// The outbox: messages an action records (`ctx.outbox.push(message)`) for
// something outside the Durable Object to act on — a queue, an email, a
// webhook — delivered after the action has succeeded, never from inside it.
//
// An action's writes and its messages go to storage together: the messages are
// written to `__outbox` when the handler resolves, in the same synchronous
// block as the action's last writes, so the Durable Object commits them as one
// (and a handler that throws records none). An alarm then hands the ones that
// are due to the sink — at most three deliveries an alarm — and deletes what
// was delivered; a message whose delivery failed stays in the table and is
// retried with backoff, on its own clock, so it never holds back the messages
// behind it (and no order is kept across a failure). The messages a delivery
// that threw leaves are split in two for their retry, each half a delivery of
// its own, so a message that fails every delivery holding it is cut off from
// the others within a few retries; once a delivery has gone through, the rest
// due goes in one. When two deliveries in a row take nothing, the sink is
// down: what is due waits for the earliest retry, its attempts not counted. A
// message is delivered at least once — make what consumes it idempotent — and
// one that fails `maxAttempts` deliveries of its own (alone, or named in
// `{ retry }`), or that the sink gives up on (`{ dead }`), is moved to
// `__outbox_dead`, logged, and never retried by itself.
//
// The sink is configured once, in the Vite plugin: `durableDb({ outbox: {
// queue: 'MY_QUEUE' } })` sends each message to a Cloudflare Queue as it is;
// `durableDb({ outbox: { module: './src/outbox.ts' } })` imports a module whose
// default export delivers them (a function, or `{ deliver }`).

/** What a message may be: declare it once with `declare global { interface DurableDbOutbox { message: MyMessage } }`. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DurableDbOutbox {}
}

/** The message `ctx.outbox.push()` takes: `DurableDbOutbox['message']` when declared, else any JSON value. */
export type OutboxMessage = DurableDbOutbox extends { message: infer M } ? M : unknown;

/** What an action records messages with. */
export interface Outbox {
  /** Records `message` (a JSON value) for delivery after the action succeeds. */
  push(message: OutboxMessage): void;
}

/** A recorded message, as the sink gets it. */
export interface OutboxEnvelope<M = OutboxMessage> {
  message: M;
  /**
   * The database that recorded it: the name `db` commands know it by (the
   * generated class's `databaseName`; a hand-written subclass without one, a
   * name derived from its class name).
   */
  database: string;
  /** The instance key of the Durable Object that recorded it, as the build applied it (in dev with the database's epoch). */
  instanceKey: string;
  /**
   * The tenant of a per-tenant database's instance: its key without the dev
   * epoch the build applied. Null for a global database's instance — by the
   * database's instance kind, so a per-tenant database's tenant named
   * `global` is that tenant.
   */
  tenantId: string | null;
  /** When the action recorded it (ms since the epoch). */
  recordedAt: number;
  /** How many deliveries of it failed before this one: 0 on its first. */
  attempts: number;
}

export interface OutboxSinkContext<Env = unknown> {
  /** The Durable Object's env: the worker's bindings. */
  env: Env;
}

/**
 * What a delivery answers. Nothing: every envelope of it was delivered.
 * `{ retry, dead }` — each a list of the very envelope objects the delivery
 * was handed, either may be left out: those in `retry` are retried (together,
 * in one delivery of their own), those in `dead` can never be delivered and
 * are moved to `__outbox_dead` at once, and every other envelope of it counts
 * as delivered; `error`, when given, is kept with both as their last error. A
 * delivery that throws retries every envelope of it.
 */
export type OutboxDelivery = void | { retry?: readonly OutboxEnvelope[]; dead?: readonly OutboxEnvelope[]; error?: unknown };

/**
 * Where the outbox delivers. `envelopes` is the delivery's own list, frozen:
 * copy it (`[...envelopes]`) to chunk or sort it — what settles the delivery
 * is the envelope objects, never their places in the list. A delivery that
 * throws is retried, every envelope of it, split in two for the retry; one
 * may settle them one by one (`{ retry }`, `{ dead }`).
 */
export interface OutboxSink<Env = unknown> {
  deliver(envelopes: readonly OutboxEnvelope[], context: OutboxSinkContext<Env>): OutboxDelivery | Promise<OutboxDelivery>;
}

export type OutboxSinkModule<Env = unknown> = OutboxSink<Env> | OutboxSink<Env>['deliver'];

/** A sink module's default export as a sink: a deliver function, or an object with one. */
export function outboxSink<Env = unknown>(module: OutboxSinkModule<Env>): OutboxSink<Env> {
  if (typeof module === 'function') return { deliver: module };
  if (module && typeof module.deliver === 'function') return module;
  throw new TypeError('[db] An outbox module must default-export a deliver function, or an object with one');
}

// What Cloudflare Queues takes (1 KB is 1000 bytes): a message of at most
// 128 KB, about 100 bytes of it the queue's own, and a sendBatch of at most
// 100 messages and 256 KB. A message is sent as JSON, so its size is its JSON's.
const QUEUE_MESSAGE_BYTES = 128_000;
const QUEUE_MESSAGE_OVERHEAD = 100;
const QUEUE_BATCH_MESSAGES = 100;
const QUEUE_BATCH_BYTES = 256_000;

const utf8 = new TextEncoder();

/** What the queue counts of a message: its JSON's bytes and its own. */
function queueMessageBytes(message: unknown): number {
  return utf8.encode(JSON.stringify(message)).byteLength + QUEUE_MESSAGE_OVERHEAD;
}

type QueueBinding = { sendBatch?(messages: Array<{ body: unknown; contentType: 'json' }>): Promise<void> };

/**
 * Each message to the Queue binding `binding`, as it was pushed (as JSON), in
 * as few sendBatch calls as the queue takes: at most 100 messages and 256 KB
 * each. A message larger than a queue message holds (128 KB) can never be
 * sent: it is not, and is answered in `{ dead }`. A sendBatch that fails
 * answers the envelopes not sent yet for a retry: the batches before it were
 * delivered.
 */
export function queueOutboxSink(binding: string): OutboxSink {
  return {
    async deliver(envelopes, { env }) {
      const queue = (env as Record<string, QueueBinding | undefined>)[binding];
      if (!queue?.sendBatch) throw new Error(`[db] The outbox sends to the Queue binding ${binding}, which this worker does not have`);
      const dead: OutboxEnvelope[] = [];
      const deadSizes: number[] = [];
      const batches: OutboxEnvelope[][] = [];
      let batch: OutboxEnvelope[] = [];
      let bytes = 0;
      for (const envelope of envelopes) {
        const size = queueMessageBytes(envelope.message);
        if (size > QUEUE_MESSAGE_BYTES) {
          dead.push(envelope);
          deadSizes.push(size);
          continue;
        }
        if (batch.length === QUEUE_BATCH_MESSAGES || bytes + size > QUEUE_BATCH_BYTES) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(envelope);
        bytes += size;
      }
      if (batch.length > 0) batches.push(batch);

      const tooLarge =
        dead.length > 0
          ? `${dead.length} message(s) of ${deadSizes.join(', ')} bytes, more than a queue message holds (${QUEUE_MESSAGE_BYTES})`
          : null;
      for (let i = 0; i < batches.length; i++) {
        try {
          await queue.sendBatch(batches[i]!.map((envelope) => ({ body: envelope.message, contentType: 'json' })));
        } catch (error) {
          const retry = batches.slice(i).flat();
          if (!tooLarge) return { retry, error };
          return {
            retry,
            dead,
            error: new Error(`[db] A sendBatch to the Queue binding ${binding} failed (${String(error)}); and ${tooLarge}`, { cause: error }),
          };
        }
      }
      if (tooLarge) return { dead, error: new Error(`[db] The Queue binding ${binding} cannot take ${tooLarge}`) };
    },
  };
}

/** Why an envelope is retried, or given up on, when the sink's answer gave no `error`. */
const ANSWERED_IN = (field: 'retry' | 'dead') => `[db] The outbox sink answered it in { ${field} }`;

/** What a delivery settled: the envelopes to retry and the error kept with them, those to give up on and theirs. */
export interface SettledOutboxDelivery {
  retry: ReadonlySet<OutboxEnvelope>;
  error: unknown;
  dead: ReadonlySet<OutboxEnvelope>;
  deadError: unknown;
  /**
   * Whether the sink said which envelopes to retry (`{ retry }`). False when
   * the delivery failed whole without saying — it threw, or answered something
   * other than its own envelopes — so a failure is no envelope's own.
   */
  named: boolean;
}

/**
 * What a delivery settled: the envelopes to retry, those to give up on, and
 * the errors kept with them (the answer's `error` with both). An answer with
 * neither `retry` nor `dead` delivered everything (a sink that returns a
 * value — a fetch's Response — did so before they existed). A `retry` or
 * `dead` that is no list, names an envelope this delivery was not handed (a
 * copy, say), or names one envelope in both is the sink's mistake and
 * retries every envelope of it: a message is never counted as delivered, or
 * given up on, that the sink did not say was.
 */
export function settleOutboxDelivery(
  envelopes: readonly OutboxEnvelope[],
  answer: unknown,
): SettledOutboxDelivery {
  if (answer === null || typeof answer !== 'object' || !('retry' in answer || 'dead' in answer)) {
    return { retry: new Set(), error: undefined, dead: new Set(), deadError: undefined, named: true };
  }
  const { retry = [], dead = [], error } = answer as { retry?: unknown; dead?: unknown; error?: unknown };
  const handed = new Set(envelopes);
  const named = (list: unknown): list is OutboxEnvelope[] => Array.isArray(list) && list.every((envelope) => handed.has(envelope));
  if (!named(retry) || !named(dead) || retry.some((envelope) => dead.includes(envelope))) {
    return {
      retry: handed,
      dead: new Set(),
      deadError: undefined,
      named: false,
      error: new Error(
        '[db] The outbox sink answered { retry } or { dead } with something other than envelopes of this delivery, or one in both: ' +
          'answer the envelope objects it was handed (every envelope of the delivery is retried)',
      ),
    };
  }
  return {
    retry: new Set(retry),
    error: error ?? new Error(ANSWERED_IN('retry')),
    dead: new Set(dead),
    deadError: error ?? new Error(ANSWERED_IN('dead')),
    named: true,
  };
}

/** What a delivery that threw is settled as: every envelope of it retried, none of them named. */
export function failedOutboxDelivery(envelopes: readonly OutboxEnvelope[], error: unknown): SettledOutboxDelivery {
  return { retry: new Set(envelopes), error, dead: new Set(), deadError: undefined, named: false };
}

export const OUTBOX_TABLE = '__outbox';

/**
 * The outbox. `next_attempt_at` (ms since the epoch; 0, the default, is due
 * at once) is when a row is next handed to the sink — after a failed
 * delivery, its own backoff — and `attempts` how many deliveries of it failed.
 * `batch` is which rows a delivery hands the sink together: 0 for the rows no
 * delivery has failed yet, else the id of the first row of what a failed
 * delivery left to retry together (see {@link outboxBatches}). No index, on
 * purpose: every index write is a billed row written per message, and the
 * outbox is near-empty but for an outage, when there is about one alarm a
 * round of retries, reading the table twice and updating what waits once
 * (see `SqliteDurableObject.alarm()`).
 */
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  batch INTEGER NOT NULL DEFAULT 0
)`;

/**
 * The columns an outbox an older durable-db created lacks (and
 * `CREATE TABLE IF NOT EXISTS` leaves a table as it is): each added once,
 * every row it holds due at once and in no batch. The block that adds them
 * also sets every row's `attempts` to 0: 0.13 retried the 100 oldest
 * together and counted each failure on all of them, so its counts were its
 * batch's, never the row's.
 */
export const OUTBOX_ADDED_COLUMNS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'next_attempt_at', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0` },
  { column: 'batch', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN batch INTEGER NOT NULL DEFAULT 0` },
];

/**
 * The batches the rows a delivery that threw left (in id order) are retried
 * in: a lone row on its own (its id), more split in two halves, each named by
 * its first row's id. A delivery that fails whole does not say which message
 * failed it; halving cuts one that fails every delivery holding it off from
 * the others within log2(n) retries. (The rows a sink names in `{ retry }`
 * are not split: they stay one batch, named by the first of them.)
 */
export function outboxBatches(ids: readonly number[]): number[] {
  if (ids.length <= 1) return [...ids];
  const half = Math.ceil(ids.length / 2);
  return ids.map((_, index) => (index < half ? ids[0]! : ids[half]!));
}

/**
 * The due rows (in id order) by the delivery each belongs to — their
 * `batch` — in the order of each one's first row.
 */
export function outboxGroups<R extends { batch: number }>(rows: readonly R[]): R[][] {
  const groups = new Map<number, R[]>();
  for (const row of rows) {
    const group = groups.get(row.batch);
    if (group) group.push(row);
    else groups.set(row.batch, [row]);
  }
  return [...groups.values()];
}

/** Where a message goes that failed `maxAttempts` deliveries: kept, never retried by itself. */
export const OUTBOX_DEAD_TABLE = '__outbox_dead';

/** The row as it was in `__outbox` (its id kept), its last error and when it was moved here (`dead_at`, ms since the epoch). */
export const OUTBOX_DEAD_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_DEAD_TABLE} (
  id INTEGER PRIMARY KEY,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  dead_at INTEGER NOT NULL
)`;

/** How many due rows one alarm reads, and so the most one delivery hands the sink. */
export const OUTBOX_DELIVERY_SIZE = 100;

/**
 * How many failed deliveries move a message to `__outbox_dead`
 * (`durableDb({ outbox: { maxAttempts } })`): 100 is about eight hours of
 * retries at the five-minute ceiling of {@link outboxRetryDelay}. A message
 * is moved only for a failure of its own — a delivery of it alone, or one
 * that named it in `{ retry }` — never for one that threw with others in it.
 */
export const OUTBOX_MAX_ATTEMPTS = 100;

/** The wait before retrying a failed delivery: 5 s, doubling, at most 5 minutes. */
export function outboxRetryDelay(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/** What tells an instance key's tenant: the database's instance kind and the dev epoch the build applied to its keys. */
export interface InstanceKeyOrigin {
  /** The database's `instance`: a global database's instance has no tenant, whatever its key. */
  instance: 'per-tenant' | 'global';
  /**
   * What the build appends to the database's instance keys —
   * `applyDevEpoch('', name)` of `virtual:durable-db/__devEpoch`: `__dev_<epoch>`
   * in dev, `''` (the default) in production, where a key is the tenant whole.
   */
  devEpochSuffix?: string;
}

/** A dev epoch suffix: `__dev_` and a base36 epoch (`Date.now().toString(36)`, a counter appended when two collide). */
const DEV_EPOCH_SUFFIX = /__dev_[0-9a-z]+$/;

/**
 * The tenant an instance key belongs to: null for a global database's
 * instance, else the key without exactly the dev epoch suffix the build
 * applied, when it ends with it — so a tenant id that contains `__dev_` is
 * kept whole. In production (no suffix) the key is the tenant. In dev every
 * key carries an epoch, so a key that does not end with the current one is
 * an earlier epoch's — an object `db reset` left behind, whose alarm still
 * delivers what waits in its outbox — and its trailing `__dev_<epoch>` is cut.
 */
export function tenantOfInstanceKey(instanceKey: string, origin: InstanceKeyOrigin): string | null {
  if (origin?.instance !== 'per-tenant' && origin?.instance !== 'global') {
    throw new TypeError(
      "[db] tenantOfInstanceKey(instanceKey, { instance, devEpochSuffix }): say the database's instance kind — " +
        "a key alone cannot tell a global database's 'global' from a tenant named so",
    );
  }
  const { instance, devEpochSuffix = '' } = origin;
  if (instance === 'global') return null;
  if (!devEpochSuffix) return instanceKey;
  if (instanceKey.endsWith(devEpochSuffix)) return instanceKey.slice(0, -devEpochSuffix.length);
  return instanceKey.replace(DEV_EPOCH_SUFFIX, '');
}

/**
 * The outbox of one action run: `push()` collects, and once the handler has
 * resolved `take()` hands the messages over to be written. A message must be
 * a JSON value; it is checked (serialized) when pushed, so a bad one fails
 * the action that pushed it rather than a delivery later.
 */
export function createActionOutbox(sinkConfigured: boolean): Outbox & { take(): string[] } {
  let messages: string[] = [];
  return {
    push(message) {
      if (!sinkConfigured) {
        throw new Error(
          '[db] ctx.outbox.push(): no outbox sink is configured — durableDb({ outbox: { queue: "<QUEUE_BINDING>" } }) ' +
            'or durableDb({ outbox: { module: "./src/outbox.ts" } })',
        );
      }
      const json = JSON.stringify(message);
      if (json === undefined) throw new TypeError('[db] ctx.outbox.push(): a message must be a JSON value');
      messages.push(json);
    },
    take() {
      const taken = messages;
      messages = [];
      return taken;
    },
  };
}
