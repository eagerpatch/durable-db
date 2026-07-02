import { SqliteDurableObject, type Migrations } from '../../src/db/SqliteDurableObject';
import { createKyselyFromSql } from '../../src/db/kysely';
import { integer, table, text } from '../../src/schema';

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
}
