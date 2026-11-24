import { assertInScope } from './scope';

// The outbox: messages an action records (`ctx.outbox.push(message)`) for
// something outside the Durable Object to act on — a queue, an email, a
// webhook — delivered after the action has succeeded, never from inside it.
//
// An action's writes and its messages go to storage together: the messages are
// written to `__outbox` when the handler resolves, in the same synchronous
// block as the action's last writes, so the Durable Object commits them as one
// (and a handler that throws records none). An alarm hands the sink the oldest
// messages that are due, at most 100 in a call, and deletes what it delivered.
// What a call did not deliver is halved and tried again in the same alarm, so a
// message the sink cannot take ends up the one of its call not delivered: it
// fails alone. A failure is judged only by what the sink did in the same
// alarm: a message that fails alone waits on its own backoff, and the failure
// counts toward `maxAttempts` only when the sink delivered another message in
// that alarm, in that call or earlier. A failure alone before anything was
// delivered cannot be told from an outage: it takes the sink for down, and
// nothing is read until its next try, which hands it the newest message alone
// and, if it does not take that one, the one tried or recorded longest ago.
// A message is delivered at least once — make what consumes it idempotent.
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
  /**
   * How many of its failures counted toward `maxAttempts` before this call:
   * 0 on its first. Only a failure alone counts — the one message of a call
   * the sink did not deliver — and only when the sink delivered another
   * message in that alarm, in that call or earlier.
   */
  attempts: number;
}

export interface OutboxSinkContext<Env = unknown> {
  /** The Durable Object's env: the worker's bindings. */
  env: Env;
}

/**
 * What a sink call answers. Nothing: every envelope of it was delivered.
 * `{ retry, dead }` — each a list of the very envelope objects the call was
 * handed, either may be left out: those in `retry` were not delivered and are
 * tried again, those in `dead` can never be and are moved to `__outbox_dead`
 * at once, and every other envelope counts as delivered; `error`, when given,
 * is kept with both as their last error. A throw is a `retry` of every
 * envelope, and so is an answer that names an envelope the call was not
 * handed, or one in both lists.
 */
export type OutboxDelivery = void | { retry?: readonly OutboxEnvelope[]; dead?: readonly OutboxEnvelope[]; error?: unknown };

/**
 * Where the outbox delivers. `envelopes` is the call's own list, frozen: copy
 * it (`[...envelopes]`) to chunk or sort it — what settles the call is the
 * envelope objects, never their places in the list.
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
 * answers the envelopes not sent yet in `{ retry }`: the batches before it
 * were delivered.
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
            error: new Error(`[db] A sendBatch to the Queue binding ${binding} failed (${outboxErrorText(error)}); and ${tooLarge}`, { cause: error }),
          };
        }
      }
      if (tooLarge) return { dead, error: new Error(`[db] The Queue binding ${binding} cannot take ${tooLarge}`) };
    },
  };
}

/** Why an envelope is retried, or given up on, when the sink's answer gave no `error`. */
const ANSWERED_IN = (field: 'retry' | 'dead') => `[db] The outbox sink answered it in { ${field} }`;

/** What a sink call settled: the envelopes not delivered and the error kept with them, those given up on and theirs; every other one was delivered. */
export interface SettledOutboxDelivery {
  retry: ReadonlySet<OutboxEnvelope>;
  error: unknown;
  dead: ReadonlySet<OutboxEnvelope>;
  deadError: unknown;
}

/**
 * What a sink call settled. An answer with neither `retry` nor `dead`
 * delivered everything (a sink that returns a value — a fetch's Response —
 * did so before they existed). A `retry` or `dead` that is no list, names an
 * envelope this call was not handed (a copy, say), or names one envelope in
 * both is the sink's mistake and counts as a throw: no envelope of the call
 * was delivered. A message is never counted as delivered, or given up on,
 * that the sink did not say was. A function's fields are read as an object's
 * (a function with a `retry` is still an answer). Each field of the answer is
 * read once, and each list copied once, by index: what is checked is what
 * settles the call, however the answer reads a second time.
 */
export function settleOutboxDelivery(envelopes: readonly OutboxEnvelope[], answer: unknown): SettledOutboxDelivery {
  if (answer === null || (typeof answer !== 'object' && typeof answer !== 'function')) {
    return { retry: new Set(), error: undefined, dead: new Set(), deadError: undefined };
  }
  const { retry, dead, error } = answer as { retry?: unknown; dead?: unknown; error?: unknown };
  if (retry === undefined && dead === undefined) {
    return { retry: new Set(), error: undefined, dead: new Set(), deadError: undefined };
  }
  const retried = answeredList(retry);
  const given = answeredList(dead);
  const handed = new Set(envelopes);
  const named = (list: unknown[] | null): list is OutboxEnvelope[] => list !== null && list.every((envelope) => handed.has(envelope as OutboxEnvelope));
  if (!named(retried) || !named(given) || retried.some((envelope) => given.includes(envelope))) {
    return {
      retry: handed,
      dead: new Set(),
      deadError: undefined,
      error: new Error(
        '[db] The outbox sink answered { retry } or { dead } with something other than envelopes of this call, or one in both: ' +
          'answer the envelope objects it was handed (every envelope of the call is retried)',
      ),
    };
  }
  return {
    retry: new Set(retried),
    error: error ?? new Error(ANSWERED_IN('retry')),
    dead: new Set(given),
    deadError: error ?? new Error(ANSWERED_IN('dead')),
  };
}

/** A list of a sink's answer as a plain array of its own, its length and each index read once: none (left out) is empty, anything but an array null. */
function answeredList(list: unknown): unknown[] | null {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const length: unknown = list.length;
  if (!Number.isSafeInteger(length) || (length as number) < 0) return null;
  const copy: unknown[] = new Array(length as number);
  for (let i = 0; i < (length as number); i++) copy[i] = list[i];
  return copy;
}

export const OUTBOX_TABLE = '__outbox';

/**
 * The outbox. `tries`: how often the message failed alone — its own backoff,
 * `next_attempt_at` (ms since the epoch; 0 is due) = now +
 * `outboxRetryDelay(tries)`. `counted`: those of its failures that count
 * toward `maxAttempts` — the envelope's `attempts`. `tried_at`: when a try of
 * the down sink last handed it alone (0: never); with `recorded_at`, the
 * order those tries take the waiting messages in (`max(tried_at,
 * recorded_at)`). `attempts` is durable-db 0.13's count, kept so that 0.13
 * runs on this table after a rollback: never read or written here. No index,
 * on purpose: every index write is a billed row written per message, and the
 * outbox is near-empty but for an outage.
 */
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  tried_at INTEGER NOT NULL DEFAULT 0
)`;

/** What the outbox knows of its sink: one row. */
export const OUTBOX_SINK_TABLE = '__outbox_sink';

/**
 * `down_until`: while later than now the sink is taken for down and nothing
 * is read or called; once past, the next alarm is its next try (0: it is not
 * down). `down_rounds`: how many rounds in a row the sink has been taken for
 * down (1 when an alarm takes it down, one more for each try that finds it
 * down), the backoff of the next try.
 */
export const OUTBOX_SINK_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_SINK_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  down_until INTEGER NOT NULL DEFAULT 0,
  down_rounds INTEGER NOT NULL DEFAULT 0
)`;

/**
 * The columns an outbox durable-db 0.13 created lacks (`CREATE TABLE IF NOT
 * EXISTS` leaves a table as it is), each added once; nothing is reset. 0.13's
 * `attempts` stays as it was: this count is `counted`, which starts at 0.
 */
export const OUTBOX_ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: OUTBOX_TABLE, column: 'tries', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN tries INTEGER NOT NULL DEFAULT 0` },
  { table: OUTBOX_TABLE, column: 'counted', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN counted INTEGER NOT NULL DEFAULT 0` },
  { table: OUTBOX_TABLE, column: 'next_attempt_at', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0` },
  { table: OUTBOX_TABLE, column: 'tried_at', ddl: `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN tried_at INTEGER NOT NULL DEFAULT 0` },
];

/** Where a message goes that the sink gave up on, or that reached `maxAttempts`: kept, never retried by itself. */
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

/** How many due rows one alarm reads, and so the most one sink call is handed. */
export const OUTBOX_DELIVERY_SIZE = 100;

/** How many sink calls one alarm makes at most (each is a subrequest). */
export const OUTBOX_CALLS_PER_ALARM = 16;

/**
 * How many counted failures move a message to `__outbox_dead`
 * (`durableDb({ outbox: { maxAttempts } })`, at least 2). A failure counts
 * when the message failed alone — the one of its call not delivered — in an
 * alarm in which the sink delivered another message, in that call or
 * earlier, so an outage counts at most one a message.
 */
export const OUTBOX_MAX_ATTEMPTS = 100;

/**
 * What a row and a log line keep of a sink's error, whatever it is: a sink
 * throws, and answers as `error`, any value, and `String()` throws for some
 * (a null-prototype object, a revoked Proxy).
 */
export function outboxErrorText(error: unknown): string {
  try {
    return String(error);
  } catch {
    try {
      return Object.prototype.toString.call(error);
    } catch {
      return '[an error that cannot be shown as text]';
    }
  }
}

/** The wait before the next try: 5 s, doubling, at most 5 minutes. */
export function outboxRetryDelay(tries: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, tries - 1), 300_000);
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

/** The outbox of one action run, as the object holds it: what was pushed, and where a part of the run began. */
export interface ActionOutbox extends Outbox {
  /** The messages pushed, handed over once the run has resolved (and emptied). */
  take(): string[];
  /** Where the messages stand now: a part of the run that may fail on its own begins here. */
  mark(): number;
  /** Drops what was pushed since `mark`: the part that pushed it failed, and its writes were rolled back. */
  rewind(mark: number): void;
}

/**
 * The outbox of one action run: `push()` collects, and once the handler has
 * resolved `take()` hands the messages over to be written. A message must be
 * a JSON value; it is checked (serialized) when pushed, so a bad one fails
 * the action that pushed it rather than a delivery later. A part of the run
 * that is rolled back on its own (`ctx.transaction()`, an action it calls)
 * takes its messages with it: `rewind()` to the `mark()` it began at.
 */
export function createActionOutbox(sinkConfigured: boolean): ActionOutbox {
  let messages: string[] = [];
  return {
    push(message) {
      assertInScope('ctx.outbox.push()');
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
    mark: () => messages.length,
    rewind(mark) {
      messages.length = Math.min(messages.length, mark);
    },
  };
}
