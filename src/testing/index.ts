import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { type } from '../arktypeConfig'; // jitless `type` — eval-free for Workers
import type { Kysely } from 'kysely';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { createKyselyFromSql } from '../db/kysely';
import {
  ACTION_TEST_META,
  liveTestDatabases,
  type ActionTestMeta,
  type LiveTestDatabase,
} from '../db/defineDatabase';
import { setTenantIdResolver } from '../context';
import { createActionOutbox, tenantOfInstanceKey, type ActionOutbox, type OutboxEnvelope, type OutboxMessage, type OutboxSink } from '../db/outbox';
import { ActionCycleError } from '../registry';
import {
  createEmptySnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
} from '../migrations/snapshot';

// ---------------------------------------------------------------------------
// durable-db test harness
//
// Runs database actions against a REAL in-memory SQLite (Node's built-in
// `node:sqlite`, which is synchronous and so maps cleanly onto Cloudflare's
// synchronous `SqlStorage.exec`). This lets app authors unit-test their
// `action()` handlers — the actual SQL, upsert/conflict logic, date handling —
// in plain `vitest` under the `node` environment, with no worker pool and no
// Cloudflare runtime.
//
// It works in the UNTRANSFORMED world: outside the durable-db Vite plugin, an
// `action()` is just a function carrying its `{ args, handler, validator }`
// under ACTION_TEST_META (see src/db/defineDatabase.ts). The harness reads that,
// validates args exactly like production, and invokes the handler with a Kysely
// bound to the in-memory db. A live test database is also published (see
// liveTestDatabases), so code under test that calls an action directly — a
// page, a procedure, a job — runs it against the test database created for
// that action's tables.
// ---------------------------------------------------------------------------

// Loaded at runtime (not a static import) so no bundler tries to resolve
// `node:sqlite` — some still don't recognise it as a builtin. It's only ever
// reached from test code running under Node, where the require resolves fine.
// Node 22 says "SQLite is an experimental feature" once per process that
// loads it — every test worker, every test file of an app — so that one
// warning is held back while it loads; every other warning goes through.
let sqlite: typeof import('node:sqlite') | undefined;
/** `node:sqlite`, loaded without Node 22's experimental notice: for a test that opens a database of its own. */
export const loadSqlite = (): typeof import('node:sqlite') => {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const option = rest[0];
    const type =
      typeof option === 'string'
        ? option
        : ((option as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined));
    const text = warning instanceof Error ? warning.message : String(warning);
    if (type === 'ExperimentalWarning' && text.startsWith('SQLite ')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
};

type Schema = Record<string, SQLiteTableWithColumns<any>>;

/** An `action()` as it exists in test code — a function with stashed metadata. */
type TestableAction<TArgs = any, TResult = any> = ((args: TArgs) => Promise<TResult>) & {
  [ACTION_TEST_META]?: ActionTestMeta;
};

export interface CreateTestDatabaseOptions {
  /**
   * The drizzle schema (the same object passed to `defineDatabase({ schema })`).
   * Tables are created from it automatically.
   */
  schema: Schema;
  /**
   * Explicit `CREATE TABLE …` (and index) statements to apply instead of
   * deriving them from `schema`. Useful to pin a known DDL or test a migration.
   */
  statements?: string[];
  /**
   * Tenant id handlers see via `getTenantId()`. Defaults to `'test'`. The
   * in-memory db is a single shared store regardless — this only affects code
   * that reads the tenant id.
   */
  tenantId?: string;
  /**
   * The database name the outbox envelopes carry (`envelope.database`, the
   * name `db` commands know the database by). Defaults to `'test'`.
   */
  database?: string;
  /**
   * The database's instance kind: a global database's actions run on the
   * instance key `'global'` and its envelopes have no tenant. Defaults to
   * the action's own database's (`defineDatabase({ instance })`), per-tenant
   * unless it says.
   */
  instance?: 'per-tenant' | 'global';
  /**
   * Delivers what an action pushed to `ctx.outbox`, after the action
   * succeeds, as the Durable Object's sink would (awaited before `run()`
   * returns), handed a frozen list of its own as the sink is. Every envelope
   * is also kept in {@link TestDatabase.outbox}.
   */
  outbox?: OutboxSink['deliver'];
  /** The `ctx.env` handlers see. Defaults to `{}`. */
  env?: Record<string, unknown>;
}

export interface TestDatabase<TSchema = any> {
  /** The Kysely instance, for direct seeding and assertions. */
  db: Kysely<TSchema>;
  /**
   * Run an `action()` the way production does: validate `args` with the
   * action's arktype schema, then invoke its handler against {@link db}.
   * Throws the same "Invalid args" error as production on a bad payload.
   *
   * Calling the action directly does the same while this database is live:
   * an action call runs against the newest live test database created with
   * every table of the action's database.
   */
  run<TArgs, TResult>(action: (args: TArgs) => Promise<TResult>, args: TArgs): Promise<TResult>;
  /**
   * Run an action's handler with `args` already validated, as {@link run}
   * does once it has validated them: for a library that finds an action's
   * handler itself (a database driver of its own).
   */
  runHandler<TResult>(handler: (db: any, args: any, ctx: any) => Promise<TResult>, args: unknown): Promise<TResult>;
  /** The raw `node:sqlite` handle, for escape-hatch SQL. */
  sqlite: DatabaseSync;
  /** Every message the actions run here pushed to `ctx.outbox` (successful ones only), oldest first. */
  outbox: OutboxEnvelope[];
  /**
   * Close the database, stop routing direct action calls to it and clear the
   * tenant resolver.
   */
  destroy(): void;
}

/**
 * A `SqlStorage`-shaped shim over a synchronous `node:sqlite` connection — the
 * minimal surface `createKyselyFromSql` drives (`exec(sql, …params).toArray()`).
 */
function sqlStorageShim(sqlite: DatabaseSync): SqlStorage {
  const isReader = (sql: string) =>
    /^\s*(SELECT|PRAGMA|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql);

  // node:sqlite rejects JS booleans/undefined as bound params; everything the
  // Kysely plugins emit is already a primitive, but normalise to be safe. A
  // blob it binds from a view of bytes only, a Durable Object from an
  // ArrayBuffer as well.
  const normalize = (p: unknown) =>
    typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p instanceof ArrayBuffer ? new Uint8Array(p) : p;

  // A blob is answered as the ArrayBuffer a Durable Object answers, not as
  // node:sqlite's Uint8Array: code that reads one meets the same value here.
  const asStored = (row: unknown): unknown => {
    if (typeof row !== 'object' || row === null) return row;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(row)) {
      if (!(value instanceof Uint8Array)) continue;
      out ??= { ...(row as Record<string, unknown>) };
      out[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return out ?? row;
  };

  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = sqlite.prepare(query);
      const params = bindings.map(normalize) as never[];
      const rows = isReader(query) ? (stmt.all(...params) as unknown[]).map(asStored) : (stmt.run(...params), []);
      return { toArray: () => rows } as unknown as ReturnType<SqlStorage['exec']>;
    },
  } as unknown as SqlStorage;
}

// ---------------------------------------------------------------------------
// Transactions, as a Durable Object runs them
//
// An action runs as one transaction of its object (`ctx.storage.transaction()`):
// its writes or none, and while it runs the object takes no other call. Here
// that is BEGIN … COMMIT on the test database's connection, one action at a
// time: a run started while another runs waits for it. A part of an action
// (`ctx.transaction()`, an action of the same database it calls) is a
// SAVEPOINT, and two parts started at once run one after the other, as the
// runtime runs them. A call from an action into a test database an action
// further out is running in waits for itself in a Durable Object: refused
// here as there (ActionCycleError).
// ---------------------------------------------------------------------------

/** A test database's open transactions, outermost first, and the runs waiting for their turn. */
interface Transactions {
  name: string;
  open: symbol[];
  waiting: Array<() => void>;
}

/** A transaction the code running now is inside: its database, its level, the action context it belongs to. */
interface Frame {
  transactions: Transactions;
  level: symbol;
  ctx: ActionRunContext;
}

/** The context a handler is handed: a Durable Object's (`dbName` the database's name, `'test'` unless the options say). */
interface ActionRunContext {
  env: Record<string, unknown>;
  dbName: string;
  instanceKey: string;
  outbox: ActionOutbox;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

// On globalThis: an app's tests can load this module twice (the app's own
// import and a framework's), and a run of one copy must see the other's.
const FRAMES = Symbol.for('durable-db.testTransactions');
const frames: AsyncLocalStorage<Frame[]> = ((globalThis as Record<symbol, unknown>)[FRAMES] ??=
  new AsyncLocalStorage<Frame[]>()) as AsyncLocalStorage<Frame[]>;

/**
 * Runs `fn` in a transaction of `transactions` — BEGIN, or a SAVEPOINT inside
 * the one the calling code is in — once it is this one's turn, committing it
 * when `fn` resolves and rolling it back when it throws.
 */
async function inTransaction<T>(
  sqlite: DatabaseSync,
  transactions: Transactions,
  ctx: ActionRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  const stack = frames.getStore() ?? [];
  let inside: symbol | undefined;
  for (const frame of stack) if (frame.transactions === transactions) inside = frame.level;
  // The level this one opens inside: the one the calling code is in, while it is open.
  const parent = inside !== undefined && transactions.open.includes(inside) ? inside : undefined;
  while (transactions.open.at(-1) !== parent) await new Promise<void>((resolve) => transactions.waiting.push(resolve));
  const level = Symbol('transaction');
  transactions.open.push(level);
  const depth = transactions.open.length;
  const savepoint = `durable_db_test_${depth}`;
  sqlite.exec(depth === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  try {
    const result = await frames.run([...stack, { transactions, level, ctx }], fn);
    sqlite.exec(depth === 1 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    sqlite.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw error;
  } finally {
    transactions.open.pop();
    // The next one goes on once this one's caller has heard how it ended, as in a Durable Object.
    const waiting = transactions.waiting.splice(0);
    if (waiting.length > 0) setImmediate(() => waiting.forEach((wake) => wake()));
  }
}

/** A part of the action of `ctx`: a savepoint, and what it pushed goes with it when it throws. */
function partOf(sqlite: DatabaseSync, transactions: Transactions, ctx: ActionRunContext) {
  return <T>(fn: () => Promise<T>): Promise<T> =>
    inTransaction(sqlite, transactions, ctx, async () => {
      const mark = ctx.outbox.mark();
      try {
        return await fn();
      } catch (error) {
        ctx.outbox.rewind(mark);
        throw error;
      }
    });
}

async function deriveStatements(schema: Schema): Promise<string[]> {
  const snapshot = await generateSnapshotFromSchema(schema);
  return generateMigrationStatements(createEmptySnapshot(), snapshot);
}

/**
 * Spin up an isolated in-memory database for a `defineDatabase` schema and run
 * its actions against it.
 *
 * @example
 * ```ts
 * import { createTestDatabase } from 'durable-db/testing';
 * import { settings, shipments } from '../src/databases/schema';
 * import { upsertShipment, listShipments } from '../src/databases/actions';
 *
 * const t = await createTestDatabase({ schema: { settings, shipments } });
 * await t.run(upsertShipment, { orderId: 'gid://…/1', status: 'booked', … });
 * expect(await t.run(listShipments, {})).toHaveLength(1);
 * t.destroy();
 * ```
 */
export async function createTestDatabase<TSchema = any>(
  options: CreateTestDatabaseOptions
): Promise<TestDatabase<TSchema>> {
  const { schema, statements, tenantId = 'test', database = 'test', env = {} } = options;
  const recorded: OutboxEnvelope[] = [];

  const { DatabaseSync } = loadSqlite();
  const sqlite = new DatabaseSync(':memory:');
  const db = createKyselyFromSql<TSchema>(sqlStorageShim(sqlite), { schema });

  const ddl = statements ?? (await deriveStatements(schema));
  for (const stmt of ddl) sqlite.exec(stmt);

  setTenantIdResolver(() => tenantId);

  const instance = (meta?: ActionTestMeta) => options.instance ?? meta?.instance ?? 'per-tenant';
  const transactions: Transactions = { name: database, open: [], waiting: [] };

  async function execute<TResult>(
    handler: (db: unknown, args: unknown, ctx: unknown) => Promise<TResult>,
    validated: unknown,
    kind: 'per-tenant' | 'global',
  ): Promise<TResult> {
    const instanceKey = kind === 'global' ? 'global' : tenantId;
    const stack = frames.getStore() ?? [];
    const innermost = stack.at(-1);
    // An action of this database called from one of its actions: a part of it, on its context.
    if (innermost?.transactions === transactions) {
      return innermost.ctx.transaction(() => handler(db, validated, innermost.ctx));
    }
    // A call into a test database an action further out is running in: it would wait for itself.
    if (stack.some((frame) => frame.transactions === transactions)) {
      const via = stack.map((frame) => ({ database: frame.transactions.name, instanceKey: frame.ctx.instanceKey }));
      throw new ActionCycleError(via, { database, instanceKey });
    }
    // The handler's context, its outbox as the Durable Object's: messages of a successful run only.
    const ctx: ActionRunContext = {
      env,
      dbName: database,
      instanceKey,
      outbox: createActionOutbox(true),
      transaction: (fn) => part(fn),
    };
    const part = partOf(sqlite, transactions, ctx);
    let recordedAt = 0;
    const result = await inTransaction(sqlite, transactions, ctx, async () => {
      const value = await handler(db, validated, ctx);
      recordedAt = Date.now();
      return value;
    });
    const envelopes: OutboxEnvelope[] = ctx.outbox.take().map((message) => ({
      message: JSON.parse(message) as OutboxMessage,
      database,
      instanceKey,
      tenantId: tenantOfInstanceKey(instanceKey, { instance: kind }),
      recordedAt,
      attempts: 0,
    }));
    if (envelopes.length > 0) {
      recorded.push(...envelopes);
      await options.outbox?.(Object.freeze(envelopes.slice()), { env });
    }
    return result;
  }

  async function run<TArgs, TResult>(
    action: (args: TArgs) => Promise<TResult>,
    args: TArgs
  ): Promise<TResult> {
    const meta = (action as TestableAction)[ACTION_TEST_META];
    if (!meta) {
      throw new Error(
        'createTestDatabase().run() was given a function that is not a durable-db action ' +
          '(no test metadata). Pass an export created by `action({ … })`.'
      );
    }
    const validated = (meta.validator as (input: unknown) => unknown)(args);
    if (validated instanceof type.errors) {
      throw new Error(`Invalid args for action: ${validated.summary}`);
    }
    return execute(meta.handler as (db: unknown, args: unknown, ctx: unknown) => Promise<TResult>, validated, instance(meta));
  }

  const runHandler = <TResult>(handler: (db: any, args: any, ctx: any) => Promise<TResult>, args: unknown): Promise<TResult> =>
    execute(handler, args, instance());

  const live: LiveTestDatabase = {
    tables: new Set(Object.values(schema)),
    run: (action, args) => run(action, args),
    clear() {
      const tables = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
        .all() as Array<{ name: string }>;
      // Rows go in any order: foreign keys are off while the tables empty.
      const { foreign_keys: foreignKeys } = sqlite.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      sqlite.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const { name } of tables) sqlite.exec(`DELETE FROM \`${name.replaceAll('`', '``')}\``);
      } finally {
        sqlite.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
      }
    },
  };
  liveTestDatabases().push(live);

  return {
    db,
    run,
    runHandler,
    sqlite,
    outbox: recorded,
    destroy() {
      const registry = liveTestDatabases();
      const index = registry.indexOf(live);
      if (index !== -1) registry.splice(index, 1);
      setTenantIdResolver(null);
      sqlite.close();
    },
  };
}
