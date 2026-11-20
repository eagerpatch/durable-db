// The outbox: messages an action records (`ctx.outbox.push(message)`) for
// something outside the Durable Object to act on — a queue, an email, a
// webhook — delivered after the action has succeeded, never from inside it.
//
// An action's writes and its messages go to storage together: the messages are
// written to `__outbox` when the handler resolves, in the same synchronous
// block as the action's last writes, so the Durable Object commits them as one
// (and a handler that throws records none). An alarm then hands the ones that
// are due to the sink and deletes what was delivered; a message whose delivery
// failed stays in the table and is retried with backoff, on its own clock, so
// it never holds back the messages behind it (and no order is kept across a
// failure). A message is delivered at least once — make what consumes it
// idempotent — and one that fails `maxAttempts` deliveries is moved to
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
 * `{ retry }`: those envelopes — the very objects the delivery was handed —
 * are retried, and every other envelope of it counts as delivered; `error`,
 * when given, is kept with them as their last error. A delivery that throws
 * retries every envelope of it.
 */
export type OutboxDelivery = void | { retry: readonly OutboxEnvelope[]; error?: unknown };

/** Where the outbox delivers. A delivery that throws is retried, every envelope of it; one may settle them one by one (`{ retry }`). */
export interface OutboxSink<Env = unknown> {
  deliver(envelopes: OutboxEnvelope[], context: OutboxSinkContext<Env>): OutboxDelivery | Promise<OutboxDelivery>;
}

export type OutboxSinkModule<Env = unknown> = OutboxSink<Env> | OutboxSink<Env>['deliver'];

/** A sink module's default export as a sink: a deliver function, or an object with one. */
export function outboxSink<Env = unknown>(module: OutboxSinkModule<Env>): OutboxSink<Env> {
  if (typeof module === 'function') return { deliver: module };
  if (module && typeof module.deliver === 'function') return module;
  throw new TypeError('[db] An outbox module must default-export a deliver function, or an object with one');
}

/** Cloudflare Queues takes at most 100 messages per sendBatch. */
const QUEUE_BATCH = 100;

/**
 * Each message to the Queue binding `binding`, as it was pushed. A sendBatch
 * that fails answers the envelopes not sent yet for a retry: the batches
 * before it were delivered.
 */
export function queueOutboxSink(binding: string): OutboxSink {
  return {
    async deliver(envelopes, { env }) {
      const queue = (env as Record<string, { sendBatch?(messages: Array<{ body: unknown }>): Promise<void> } | undefined>)[binding];
      if (!queue?.sendBatch) throw new Error(`[db] The outbox sends to the Queue binding ${binding}, which this worker does not have`);
      for (let i = 0; i < envelopes.length; i += QUEUE_BATCH) {
        try {
          await queue.sendBatch(envelopes.slice(i, i + QUEUE_BATCH).map((envelope) => ({ body: envelope.message })));
        } catch (error) {
          return { retry: envelopes.slice(i), error };
        }
      }
    },
  };
}

/** Why an envelope is retried when the sink's `{ retry }` gave no `error`. */
const RETRY_ASKED = '[db] The outbox sink answered it in { retry }';

/**
 * What a delivery settled: the envelopes to retry, and the error kept with
 * them. An answer without `retry` delivered everything (a sink that returns
 * a value — a fetch's Response — did so before `{ retry }` existed). A
 * `{ retry }` that is no list, or names an envelope this delivery was not
 * handed (a copy, say), is the sink's mistake and retries every envelope of
 * it: a message is never counted as delivered that the sink did not say was.
 */
export function settleOutboxDelivery(
  envelopes: readonly OutboxEnvelope[],
  answer: unknown,
): { retry: ReadonlySet<OutboxEnvelope>; error: unknown } {
  if (answer === null || typeof answer !== 'object' || !('retry' in answer)) return { retry: new Set(), error: undefined };
  const { retry, error } = answer as { retry: unknown; error?: unknown };
  const handed = new Set(envelopes);
  if (!Array.isArray(retry) || retry.some((envelope) => !handed.has(envelope))) {
    return {
      retry: handed,
      error: new Error(
        '[db] The outbox sink answered { retry } with something other than envelopes of this delivery: ' +
          'answer the envelope objects it was handed (every envelope of the delivery is retried)',
      ),
    };
  }
  return { retry: new Set(retry as OutboxEnvelope[]), error: error ?? new Error(RETRY_ASKED) };
}

export const OUTBOX_TABLE = '__outbox';

/**
 * The outbox. `next_attempt_at` (ms since the epoch; 0, the default, is due
 * at once) is when a row is next handed to the sink — after a failed
 * delivery, its own backoff — and `attempts` how many deliveries of it failed.
 */
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
)`;

/**
 * An outbox an older durable-db created has no `next_attempt_at` (and
 * `CREATE TABLE IF NOT EXISTS` leaves a table as it is): added once, every
 * row it holds due at once.
 */
export const OUTBOX_NEXT_ATTEMPT_COLUMN = `ALTER TABLE ${OUTBOX_TABLE} ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0`;

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

/** How many envelopes one delivery hands the sink. */
export const OUTBOX_DELIVERY_SIZE = 100;

/**
 * How many failed deliveries move a message to `__outbox_dead`
 * (`durableDb({ outbox: { maxAttempts } })`): 100 is about eight hours of
 * retries at the five-minute ceiling of {@link outboxRetryDelay}.
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

/**
 * The tenant an instance key belongs to: null for a global database's
 * instance, else the key without exactly the dev epoch suffix the build
 * applied, when it ends with it — nothing else is cut, so a tenant id that
 * contains `__dev_` is kept whole.
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
  return devEpochSuffix && instanceKey.endsWith(devEpochSuffix) ? instanceKey.slice(0, -devEpochSuffix.length) : instanceKey;
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
