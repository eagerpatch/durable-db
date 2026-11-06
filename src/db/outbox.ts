// The outbox: messages an action records (`ctx.outbox.push(message)`) for
// something outside the Durable Object to act on — a queue, an email, a
// webhook — delivered after the action has succeeded, never from inside it.
//
// An action's writes and its messages go to storage together: the messages are
// written to `__outbox` when the handler resolves, in the same synchronous
// block as the action's last writes, so the Durable Object commits them as one
// (and a handler that throws records none). An alarm then hands them to the
// sink and deletes what was delivered; a failed delivery stays in the table and
// is retried with backoff, so a message is delivered at least once — make
// what consumes it idempotent.
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
  /** The instance key of the Durable Object that recorded it. */
  instanceKey: string;
  /** The tenant of a per-tenant database's instance (its key without the dev epoch); null for a global database. */
  tenantId: string | null;
  /** When the action recorded it (ms since the epoch). */
  recordedAt: number;
}

export interface OutboxSinkContext<Env = unknown> {
  /** The Durable Object's env: the worker's bindings. */
  env: Env;
}

/** Where the outbox delivers. A delivery that throws is retried, every envelope of it. */
export interface OutboxSink<Env = unknown> {
  deliver(envelopes: OutboxEnvelope[], context: OutboxSinkContext<Env>): Promise<void> | void;
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

/** Each message to the Queue binding `binding`, as it was pushed. */
export function queueOutboxSink(binding: string): OutboxSink {
  return {
    async deliver(envelopes, { env }) {
      const queue = (env as Record<string, { sendBatch?(messages: Array<{ body: unknown }>): Promise<void> } | undefined>)[binding];
      if (!queue?.sendBatch) throw new Error(`[db] The outbox sends to the Queue binding ${binding}, which this worker does not have`);
      for (let i = 0; i < envelopes.length; i += QUEUE_BATCH) {
        await queue.sendBatch(envelopes.slice(i, i + QUEUE_BATCH).map((envelope) => ({ body: envelope.message })));
      }
    },
  };
}

export const OUTBOX_TABLE = '__outbox';

export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
)`;

/** How many envelopes one delivery hands the sink. */
export const OUTBOX_DELIVERY_SIZE = 100;

/** The wait before retrying a failed delivery: 5 s, doubling, at most 5 minutes. */
export function outboxRetryDelay(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/** The tenant an instance key belongs to (its dev epoch suffix dropped); null for a global database. */
export function tenantOfInstanceKey(instanceKey: string): string | null {
  const suffixAt = instanceKey.lastIndexOf('__dev_');
  const tenant = suffixAt === -1 ? instanceKey : instanceKey.slice(0, suffixAt);
  return tenant === 'global' ? null : tenant;
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
