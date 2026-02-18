import { describe, it, expect } from 'vitest';
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import { text, integer } from 'drizzle-orm/sqlite-core';
import { table } from '../../src/schema';
import { SchemaPlugin } from '../../src/db/plugins';
import { generateSnapshotFromSchema, createEmptySnapshot, generateMigrationStatements } from '../../src/migrations/snapshot';

function createTestDb(plugins: any[]) {
  return new Kysely<any>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
    plugins,
  });
}

describe('migration + plugin integration', () => {
  describe('implicit column names (no explicit strings)', () => {
    const products = table('products', {
      id: text().primaryKey(),
      name: text().notNull(),
      priceInCents: integer().notNull(),
      createdAt: integer({ mode: 'timestamp' }).notNull(),
    });

    it('migration generates snake_case column names', async () => {
      const snapshot = await generateSnapshotFromSchema({ products });
      const stmts = await generateMigrationStatements(createEmptySnapshot(), snapshot);

      const sql = stmts.join('\n');
      expect(sql).toContain('`price_in_cents`');
      expect(sql).toContain('`created_at`');
      expect(sql).not.toContain('priceInCents');
      expect(sql).not.toContain('createdAt');
    });

    it('Kysely queries use matching snake_case column names', async () => {
      const schema = { products };
      const db = createTestDb([new SchemaPlugin(schema)]);

      const query = db.selectFrom('products')
        .select(['priceInCents', 'createdAt'])
        .compile();

      expect(query.sql).toContain('"price_in_cents"');
      expect(query.sql).toContain('"created_at"');
    });

    it('migration and Kysely use the same column names', async () => {
      const schema = { products };
      const snapshot = await generateSnapshotFromSchema(schema);

      const migrationCols = Object.keys(
        Object.values(snapshot.tables)[0].columns
      ).sort();

      const db = createTestDb([new SchemaPlugin(schema)]);
      const query = db.insertInto('products').values({
        id: '1',
        name: 'Widget',
        priceInCents: 999,
        createdAt: 1234567890,
      }).compile();

      // Extract column names from the INSERT SQL
      const match = query.sql.match(/\(([^)]+)\) values/);
      const kyselyCols = match![1]
        .split(',')
        .map((c: string) => c.trim().replace(/"/g, ''))
        .sort();

      expect(kyselyCols).toEqual(migrationCols);
    });
  });

  describe('camelCase table names', () => {
    const userProfiles = table('userProfiles', {
      id: text().primaryKey(),
      displayName: text().notNull(),
      totalOrders: integer().notNull(),
    });

    it('migration generates snake_case table name', async () => {
      const snapshot = await generateSnapshotFromSchema({ userProfiles });
      const stmts = await generateMigrationStatements(createEmptySnapshot(), snapshot);

      const sql = stmts.join('\n');
      expect(sql).toContain('`user_profiles`');
      expect(sql).not.toContain('userProfiles');
    });

    it('Kysely queries use matching snake_case table name', async () => {
      const schema = { userProfiles };
      const db = createTestDb([new SchemaPlugin(schema)]);

      const query = db.selectFrom('userProfiles').selectAll().compile();
      expect(query.sql).toContain('"user_profiles"');
    });

    it('migration and Kysely use the same table name', async () => {
      const schema = { userProfiles };
      const snapshot = await generateSnapshotFromSchema(schema);
      const migrationTableName = Object.values(snapshot.tables)[0].name;

      const db = createTestDb([new SchemaPlugin(schema)]);
      const query = db.selectFrom('userProfiles').selectAll().compile();
      const kyselyTableName = query.sql.match(/from "([^"]+)"/)![1];

      expect(kyselyTableName).toBe(migrationTableName);
    });
  });

  describe('explicit column names still work', () => {
    const users = table('users', {
      id: text('id').primaryKey(),
      firstName: text('first_name').notNull(),
      createdAt: text('created_at').notNull(),
    });

    it('migration and Kysely agree on column names', async () => {
      const schema = { users };
      const snapshot = await generateSnapshotFromSchema(schema);
      const migrationCols = Object.keys(
        Object.values(snapshot.tables)[0].columns
      ).sort();

      const db = createTestDb([new SchemaPlugin(schema)]);
      const query = db.insertInto('users').values({
        id: '1',
        firstName: 'John',
        createdAt: 'now',
      }).compile();

      const match = query.sql.match(/\(([^)]+)\) values/);
      const kyselyCols = match![1]
        .split(',')
        .map((c: string) => c.trim().replace(/"/g, ''))
        .sort();

      expect(kyselyCols).toEqual(migrationCols);
    });
  });
});
