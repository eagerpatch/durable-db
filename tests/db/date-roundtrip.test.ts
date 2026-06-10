import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, CamelCasePlugin, type KyselyPlugin } from 'kysely';
import Database from 'libsql';
import { table, text, integer } from '../../src/schema';
import { createDrizzlePlugins, DateSerializePlugin } from '../../src/db/plugins';

/**
 * End-to-end regression tests for the date/text round-trip bug:
 * a `text()` column holding an ISO date string (e.g. `created`,
 * `createdAt`, `created_at`) used to come back as Invalid Date from
 * the read path (→ null over the action RPC), because the
 * DateSerializePlugin heuristically converted any date-looking string
 * and appended a second 'Z' while doing so.
 *
 * Runs against a real SQLite database with the same plugin chains the
 * library uses at runtime.
 */

const events = table('events', {
  id: text().primaryKey(),
  created: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

const DDL = `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

const cleanups: Array<() => Promise<void>> = [];

function createDb(plugins: KyselyPlugin[]): Kysely<any> {
  const database = new Database(':memory:');
  database.exec(DDL);
  const db = new Kysely<any>({
    dialect: new SqliteDialect({ database: database as any }),
    plugins,
  });
  cleanups.push(() => db.destroy());
  return db;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const ISO = '2026-06-10T08:30:00.000Z';
const WHEN = new Date('2026-06-10T08:30:00.000Z');

async function insertAndReadBack(db: Kysely<any>) {
  await db.insertInto('events')
    .values({ id: '1', created: ISO, createdAt: WHEN })
    .execute();

  const rows = await db.selectFrom('events').selectAll().execute();
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('date/text column round-trip (real SQLite)', () => {
  it('round-trips with the schema-aware plugin chain (createDrizzlePlugins)', async () => {
    const db = createDb(createDrizzlePlugins({ events } as any));
    const row = await insertAndReadBack(db);

    // text() column: user-stored ISO string comes back verbatim
    expect(row.created).toBe(ISO);

    // integer({ mode: 'timestamp' }) column: Date round-trips as Date
    expect(row.createdAt).toBeInstanceOf(Date);
    expect((row.createdAt as Date).getTime()).toBe(WHEN.getTime());
  });

  it('round-trips with the schema-less chain the DO uses (CamelCase + DateSerialize)', async () => {
    const db = createDb([new CamelCasePlugin(), new DateSerializePlugin()]);
    const row = await insertAndReadBack(db);

    expect(row.created).toBe(ISO);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect((row.createdAt as Date).getTime()).toBe(WHEN.getTime());
  });

  it('never produces Invalid Date on the read path', async () => {
    const db = createDb([new CamelCasePlugin(), new DateSerializePlugin()]);
    const row = await insertAndReadBack(db);

    for (const value of Object.values(row)) {
      if (value instanceof Date) {
        expect(Number.isNaN(value.getTime())).toBe(false);
      }
    }

    // JSON serialization (what RPC/websocket transports do) must not
    // collapse anything to null
    const json = JSON.parse(JSON.stringify(row));
    expect(json.created).toBe(ISO);
    expect(json.createdAt).not.toBeNull();
  });
});
