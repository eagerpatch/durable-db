import { SqliteDurableObject, type Migrations } from '../../src/db/SqliteDurableObject';
import { RemovedDatabaseDurableObject } from '../../src/db/RemovedDatabaseDurableObject';
import { type as actionArgsType, registerAction, registerSharedAction, callAction } from '../../src/registry';
import { createKyselyFromSql } from '../../src/db/kysely';
import { blob, integer, table, text } from '../../src/schema';

/**
 * Minimal SqliteDurableObject subclass that deliberately contains a broken
 * migration. Used by the smoke-test suite to verify that migration failure
 * paths (log format, error propagation, diagnostic accessors) work against
 * a real workerd runtime — not just our mocks.
 */
export class TestMigrationDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_ok': {
      chunks: [['CREATE TABLE test_ok (id TEXT PRIMARY KEY)']],
    },
    '20240201_bad': {
      chunks: [
        [
          'CREATE TABLE test_bad_pre (id TEXT PRIMARY KEY)',
          'THIS IS NOT VALID SQL',
        ],
      ],
    },
  };

  /** User tables present in storage (journal/attempt tables excluded). */
  async listTables(): Promise<string[]> {
    try {
      await this.ensureMigrations();
    } catch {
      // expected — the bad migration throws; we want the state it left behind
    }
    return this.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '__*' AND name NOT GLOB '_cf*' AND name NOT GLOB 'sqlite_*'`)
      .toArray()
      .map((r) => (r as { name: string }).name);
  }
}

/**
 * A DO whose first calls race: every method awaits ensureMigrations(), the
 * way the generated `rpc()` does. Several first calls arriving together on a
 * fresh instance must share one migration run.
 */
export class TestRaceDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_init': {
      chunks: [
        ['CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL)'],
        ['CREATE TABLE cart_items (id TEXT PRIMARY KEY, product_id TEXT NOT NULL)'],
      ],
    },
  };

  async countProducts(): Promise<number> {
    await this.ensureMigrations();
    return (this.sql.exec('SELECT count(*) AS n FROM products').toArray()[0] as { n: number }).n;
  }

  /** Several first calls inside one invocation, interleaved by the awaits. */
  async concurrentEnsure(n: number): Promise<void> {
    await Promise.all(Array.from({ length: n }, () => this.ensureMigrations()));
  }

  journal(): string[] {
    return this.sql
      .exec('SELECT name, chunk_index FROM __migrations ORDER BY name, chunk_index')
      .toArray()
      .map((r) => `${(r as { name: string }).name}[${(r as { chunk_index: number }).chunk_index}]`);
  }
}

/**
 * A DO whose migrations a test swaps between boots, standing in for a dev
 * server that reloads its embedded migrations: `db push` adds a `_dev_`
 * migration, `db generate` turns it into a production one.
 */
export class TestDevHandoffDO extends SqliteDurableObject {
  migrations: Migrations = {};

  async migrateWith(migrations: Migrations): Promise<{ journal: string[]; columns: string[] } | { error: string; name: string }> {
    this.migrations = migrations;
    this.resetMigrationState();
    try {
      await this.ensureMigrations();
    } catch (error) {
      return { error: (error as Error).message, name: (error as Error).name };
    }
    return {
      journal: this.sql
        .exec('SELECT name, chunk_index FROM __migrations ORDER BY name, chunk_index')
        .toArray()
        .map((r) => `${(r as { name: string }).name}[${(r as { chunk_index: number }).chunk_index}]`),
      columns: this.sql
        .exec(`SELECT name FROM pragma_table_info('products')`)
        .toArray()
        .map((r) => (r as { name: string }).name),
    };
  }
}

/**
 * Action args validation as the generated code does it, at request time in
 * workerd (where generating code from strings is disallowed): the RPC stub's
 * `__ddType(args).assert(…)` and the Durable Object's registered validator.
 */
export class TestArgsDO extends SqliteDurableObject {
  migrations: Migrations = {};

  async optionalKeyUndefined(): Promise<{ stub: unknown; durableObject: unknown; rejected: string }> {
    const schema = { productId: 'string', 'photoKey?': 'string' } as const;
    const stub = actionArgsType(schema).assert({ productId: 'p1', photoKey: undefined });

    const validator = actionArgsType(schema);
    registerAction('args-test', 'addReview', {
      validator: (args) => validator(args),
      handler: async (_db, args) => args,
    });
    const ctx = { env: {}, dbName: 'args-test', dbBindingNames: {}, instanceKey: 'global' };
    const durableObject = await callAction(null, 'args-test', 'addReview', { productId: 'p1', photoKey: undefined }, ctx);

    let rejected = '';
    try {
      actionArgsType(schema).assert({ productId: 'p1', photoKey: 7 });
    } catch (error) {
      rejected = (error as Error).message;
    }
    return { stub, durableObject, rejected };
  }
}

/** A DO with only successful migrations — used for the happy-path smoke. */
export class TestHappyDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_ok': {
      chunks: [['CREATE TABLE happy (id TEXT PRIMARY KEY)']],
    },
  };
}

// ---------------------------------------------------------------------------
// Kysely-over-real-SqlStorage E2E — the exact write/read path an app's
// defineDatabase() actions use in production (schema-aware plugin chain over
// workerd's SqlStorage). The unit suites run against node:sqlite/libsql, whose
// binding behavior differs from workerd (e.g. node:sqlite REJECTS boolean
// params where workerd silently stringifies them) — only this suite is
// authoritative for what production actually stores.
// ---------------------------------------------------------------------------

const items = table('items', {
  id: text().primaryKey(),
  day: integer().notNull(),
  active: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

/** `items` as a schema change not yet migrated sees it: one column more. */
const itemsWithWeight = table('items', {
  id: text().primaryKey(),
  day: integer().notNull(),
  active: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
  weightGrams: integer(),
});

// JSON as text and as a blob, a camelCase name, and bytes.
const documents = table('documents', {
  id: text().primaryKey(),
  meta: text({ mode: 'json' }),
  metaData: text({ mode: 'json' }),
  packed: blob({ mode: 'json' }),
  raw: blob(),
});

export class TestKyselyDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_items': {
      chunks: [
        [
          `CREATE TABLE items (
            id TEXT PRIMARY KEY,
            day INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          )`,
        ],
      ],
    },
  };

  private appDb() {
    return createKyselyFromSql<any>(this.sql, { schema: { items } });
  }

  /** Insert N rows through one .values([...]) call; return how many persisted. */
  async multiRowInsert(count: number): Promise<number> {
    await this.ensureMigrations();
    const db = this.appDb();
    await db
      .insertInto('items')
      .values(
        Array.from({ length: count }, (_, i) => ({
          id: `row-${i}`,
          day: i + 1,
          active: i % 2 === 1,
          createdAt: new Date('2026-12-01T00:00:00Z'),
        })),
      )
      .execute();
    const rows = await db.selectFrom('items').selectAll().execute();
    return rows.length;
  }

  /** What a write reports back: Kysely's affected rows and insert id, from one follow-up statement. */
  async writeResults(): Promise<{ inserted: string; insertId: string; updated: string; deleted: string }> {
    await this.ensureMigrations();
    const db = this.appDb();
    const insert = await db
      .insertInto('items')
      .values([1, 2, 3].map((day) => ({ id: `w-${day}`, day, active: false, createdAt: new Date('2026-12-01T00:00:00Z') })))
      .executeTakeFirst();
    const update = await db.updateTable('items').set({ active: true }).where('day', '<=', 2).executeTakeFirst();
    const remove = await db.deleteFrom('items').where('day', '=', 3).executeTakeFirst();
    return {
      inserted: String(insert.numInsertedOrUpdatedRows),
      insertId: String(insert.insertId),
      updated: String(update.numUpdatedRows),
      deleted: String(remove.numDeletedRows),
    };
  }

  /**
   * The exact shape of the insert that silently failed in the field: 24 rows ×
   * 7 columns (168 bound params) in one .values([...]) call. Returns persisted
   * count, or the error message if the insert throws.
   */
  async wideMultiRowInsert(rows: number, cols: number): Promise<number | string> {
    await this.ensureMigrations();
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS wide (
        c0 TEXT PRIMARY KEY, c1 TEXT, c2 TEXT, c3 TEXT, c4 TEXT,
        c5 TEXT, c6 TEXT, c7 TEXT, c8 TEXT, c9 TEXT
      )`,
    );
    const db = createKyselyFromSql<any>(this.sql);
    try {
      await db
        .insertInto('wide')
        .values(
          Array.from({ length: rows }, (_, i) =>
            Object.fromEntries(
              Array.from({ length: cols }, (_, c) => [`c${c}`, c === 0 ? `row-${i}` : `v${i}-${c}`]),
            ),
          ),
        )
        .execute();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const count = this.sql.exec('SELECT count(*) AS n FROM wide').toArray()[0] as { n: number };
    return count.n;
  }

  /**
   * JSON-mode columns and blob parameters against the real SqlStorage: what it
   * stores for them and what a read answers.
   */
  async jsonAndBlobRoundTrip(): Promise<{
    stored: Record<string, unknown>[];
    read: Record<string, unknown>[];
    found: string[];
  }> {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, meta TEXT, meta_data TEXT, packed BLOB, raw BLOB
      )`,
    );
    const db = createKyselyFromSql<any>(this.sql, { schema: { documents } });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await db
      .insertInto('documents')
      .values([
        { id: 'view', meta: { v: 1, list: ['a'] }, metaData: 'text', packed: { å: 'ö' }, raw: bytes },
        { id: 'buffer', meta: null, metaData: null, packed: null, raw: bytes.buffer.slice(1, 4) },
      ])
      .execute();
    await db.updateTable('documents').set({ metaData: { camel: true } }).where('id', '=', 'buffer').execute();

    const stored = this.sql
      .exec(
        `SELECT id, meta, meta_data, typeof(packed) AS packed_kind, CAST(packed AS TEXT) AS packed_json,
                typeof(raw) AS raw_kind, hex(raw) AS raw_hex
         FROM documents ORDER BY id`,
      )
      .toArray() as Record<string, unknown>[];
    const rows = await db.selectFrom('documents').selectAll().orderBy('id').execute();
    const found = await db.selectFrom('documents').select('id').where('raw', '=', bytes).execute();

    return {
      stored,
      read: rows.map((row: any) => ({
        id: row.id,
        meta: row.meta,
        metaData: row.metaData,
        packed: row.packed,
        rawIsBuffer: row.raw instanceof ArrayBuffer,
        raw: [...new Uint8Array(row.raw)],
      })),
      found: found.map((row: any) => row.id),
    };
  }

  /** Write a boolean through Kysely; report what SQLite stored and what a read returns. */
  async booleanRoundTrip(): Promise<{
    storedType: string;
    storedValue: unknown;
    readValue: unknown;
    readType: string;
    falseReadValue: unknown;
  }> {
    await this.ensureMigrations();
    const db = this.appDb();
    await db
      .insertInto('items')
      .values({ id: 'bool-t', day: 1, active: true, createdAt: new Date() })
      .execute();
    await db
      .insertInto('items')
      .values({ id: 'bool-f', day: 2, active: false, createdAt: new Date() })
      .execute();

    const raw = this.sql
      .exec(`SELECT active, typeof(active) AS t FROM items WHERE id = 'bool-t'`)
      .toArray()[0] as { active: unknown; t: string };
    const readT = await db.selectFrom('items').selectAll().where('id', '=', 'bool-t').executeTakeFirst();
    const readF = await db.selectFrom('items').selectAll().where('id', '=', 'bool-f').executeTakeFirst();

    return {
      storedType: raw.t,
      storedValue: raw.active,
      readValue: (readT as any).active,
      readType: typeof (readT as any).active,
      falseReadValue: (readF as any).active,
    };
  }

  /** Rows written by the OLD buggy driver (TEXT 'true'/'false') must still read as booleans. */
  async legacyStringBooleanRead(): Promise<{ t: unknown; f: unknown }> {
    await this.ensureMigrations();
    this.sql.exec(
      `INSERT INTO items (id, day, active, created_at) VALUES ('legacy-t', 1, 'true', 0), ('legacy-f', 2, 'false', 0)`,
    );
    const db = this.appDb();
    const t = await db.selectFrom('items').selectAll().where('id', '=', 'legacy-t').executeTakeFirst();
    const f = await db.selectFrom('items').selectAll().where('id', '=', 'legacy-f').executeTakeFirst();
    return { t: (t as any).active, f: (f as any).active };
  }

  /**
   * Query a column the table does not have (schema changed, not migrated):
   * a select, a WHERE and an update. Each must fail with "no such column" —
   * never read back the column's name, or compare it as a string.
   */
  async missingColumn(): Promise<{ select: string; where: string; update: string }> {
    await this.ensureMigrations();
    this.sql.exec(`INSERT OR IGNORE INTO items (id, day, active, created_at) VALUES ('w1', 1, 0, 0)`);
    const db = createKyselyFromSql<any>(this.sql, { schema: { items: itemsWithWeight } });
    const attempt = async (query: () => Promise<unknown>): Promise<string> => {
      try {
        return `ok: ${JSON.stringify(await query())}`;
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    };
    return {
      select: await attempt(() => db.selectFrom('items').select(['id', 'weightGrams']).execute()),
      where: await attempt(() => db.selectFrom('items').select('id').where('weightGrams', 'is', null).execute()),
      update: await attempt(() => db.updateTable('items').set({ weightGrams: 5 }).where('id', '=', 'w1').execute()),
    };
  }
}

/**
 * What the generated module exports for the class of a removed database
 * (`generateDurableObjectsModule`'s tombstones).
 */
export class TestRemovedDatabaseDO extends RemovedDatabaseDurableObject {
  removedClassName = 'TestRemovedDatabaseDO';
  deleteMigration = { tag: 'v2', deleted_classes: ['TestRemovedDatabaseDO'] };
}

/**
 * The outbox against a real workerd: an action's messages written with it,
 * delivered by the alarm to a sink that logs them in KV (and fails while the
 * `fail` key is set there).
 */
export class TestOutboxDO extends SqliteDurableObject<{ OUTBOX_LOG: KVNamespace }> {
  migrations: Migrations = {
    '20240101_notes': { chunks: [['CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)']] },
  };
  protected outboxSink = {
    deliver: async (envelopes: Array<{ message: unknown; tenantId: string | null }>, { env }: { env: { OUTBOX_LOG: KVNamespace } }) => {
      if (await env.OUTBOX_LOG.get('fail')) throw new Error('sink is down');
      const log = JSON.parse((await env.OUTBOX_LOG.get('delivered')) ?? '[]') as unknown[];
      log.push(...envelopes.map((e) => ({ message: e.message, tenantId: e.tenantId })));
      await env.OUTBOX_LOG.put('delivered', JSON.stringify(log));
    },
  };

  /**
   * An action writing a note and pushing `messages`; with `fail` it throws
   * after both, and the error comes back as a string (a rejection across RPC
   * is reported as unhandled by the test pool).
   */
  async record(instanceKey: string, messages: unknown[], fail = false): Promise<number | string> {
    await this.ensureMigrations();
    const ctx: { instanceKey: string; outbox?: { push(message: unknown): void } } = { instanceKey };
    try {
      return await this.runWithOutbox(ctx, async () => {
        this.sql.exec('INSERT INTO notes (text) VALUES (?)', 'note');
        for (const message of messages) ctx.outbox!.push(message);
        if (fail) throw new Error('the action failed');
        return messages.length;
      });
    } catch (error) {
      return (error as Error).message;
    }
  }

  async outboxRows(): Promise<Array<{ message: string; attempts: number; last_error: string | null }>> {
    const exists = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__outbox'`).toArray().length > 0;
    if (!exists) return [];
    return this.sql.exec('SELECT message, attempts, last_error FROM __outbox ORDER BY id').toArray() as never;
  }

  async notes(): Promise<number> {
    await this.ensureMigrations();
    return (this.sql.exec('SELECT count(*) AS n FROM notes').toArray()[0] as { n: number }).n;
  }

  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

// ---------------------------------------------------------------------------
// Shared actions — registered once, an action of every database.
// ---------------------------------------------------------------------------

const things = table('things', { id: text().primaryKey() });

// At module scope, the way a library registers one: loaded with the worker's
// entry, so it is there in every Durable Object's isolate.
registerSharedAction('lib:ids', {
  validator: (args) => args,
  handler: async (db, args, ctx) => {
    const { table: from } = args as { table: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (db as any).selectFrom(from).select('id').orderBy('id').execute();
    return { database: (ctx as { dbName: string }).dbName, ids: rows.map((row: { id: string }) => row.id) };
  },
});

// A database's own action of the same name.
registerAction('shared-own', 'lib:ids', {
  validator: (args) => args,
  handler: async () => 'own',
});

/**
 * A shared action against a real workerd: called as an action of whichever
 * database the object is (`asDatabase`), it reads that object's own SQLite.
 */
export class TestSharedDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_things': { chunks: [['CREATE TABLE things (id TEXT PRIMARY KEY)']] },
  };

  async ids(asDatabase: string, add: string[]): Promise<unknown> {
    await this.ensureMigrations();
    for (const id of add) this.sql.exec('INSERT INTO things (id) VALUES (?)', id);
    const db = createKyselyFromSql<any>(this.sql, { schema: { things } });
    const ctx = { env: {}, dbName: asDatabase, dbBindingNames: {}, instanceKey: 'global' };
    return callAction(db, asDatabase, 'lib:ids', { table: 'things' }, ctx);
  }
}
