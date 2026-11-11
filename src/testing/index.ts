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
import { createActionOutbox, tenantOfInstanceKey, type OutboxEnvelope, type OutboxMessage, type OutboxSink } from '../db/outbox';
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
const loadSqlite = (): typeof import('node:sqlite') =>
  createRequire(import.meta.url)('node:sqlite');

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
   * Delivers what an action pushed to `ctx.outbox`, after the action
   * succeeds, as the Durable Object's sink would (awaited before `run()`
   * returns). Every envelope is also kept in {@link TestDatabase.outbox}.
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
  const { schema, statements, tenantId = 'test', env = {} } = options;
  const recorded: OutboxEnvelope[] = [];

  const { DatabaseSync } = loadSqlite();
  const sqlite = new DatabaseSync(':memory:');
  const db = createKyselyFromSql<TSchema>(sqlStorageShim(sqlite), { schema });

  const ddl = statements ?? (await deriveStatements(schema));
  for (const stmt of ddl) sqlite.exec(stmt);

  setTenantIdResolver(() => tenantId);

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
    // The handler's context, its outbox as the Durable Object's: messages of a successful run only.
    const outbox = createActionOutbox(true);
    const result = (await (meta.handler as (db: unknown, args: unknown, ctx: unknown) => Promise<unknown>)(db, validated, {
      env,
      instanceKey: tenantId,
      outbox,
    })) as TResult;
    const envelopes: OutboxEnvelope[] = outbox.take().map((message) => ({
      message: JSON.parse(message) as OutboxMessage,
      instanceKey: tenantId,
      tenantId: tenantOfInstanceKey(tenantId),
      recordedAt: Date.now(),
    }));
    if (envelopes.length > 0) {
      recorded.push(...envelopes);
      await options.outbox?.(envelopes, { env });
    }
    return result;
  }

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
