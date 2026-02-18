import { describe, it, expect, vi } from 'vitest';
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  CamelCasePlugin,
  type KyselyPlugin,
} from 'kysely';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  SchemaPlugin,
  DrizzleDefaultsPlugin,
  DateSerializePlugin,
  dateSerializers,
  createDrizzlePlugins,
  extractDefaults,
} from '../../src/db/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb<T>(plugins: KyselyPlugin[]) {
  return new Kysely<T>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
    plugins,
  });
}

// ---------------------------------------------------------------------------
// Test schemas
// ---------------------------------------------------------------------------

// Schema with explicit column names (old-style: `text('column_name')`)
const usersExplicit = sqliteTable('users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  createdAt: text('created_at').notNull(),
});

// Schema without explicit column names (new-style: `text()`)
const productsImplicit = sqliteTable('products', {
  id: text().primaryKey(),
  productName: text().notNull(),
  priceInCents: integer().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

// Schema with camelCase table name (for table name mapping tests)
const userProfilesTable = sqliteTable('user_profiles', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
});

// Schema with defaultFn and onUpdateFn
const postsWithDefaults = sqliteTable('posts', {
  id: text('id').primaryKey().$defaultFn(() => 'generated-id'),
  title: text('title').notNull(),
  body: text('body'),
  createdAt: text('created_at').notNull().$defaultFn(() => '2025-01-01 00:00:00'),
  updatedAt: text('updated_at').$onUpdateFn(() => '2025-06-01 12:00:00'),
});

// ---------------------------------------------------------------------------
// SchemaPlugin tests
// ---------------------------------------------------------------------------

describe('SchemaPlugin', () => {
  describe('with explicit column names', () => {
    const schema = { users: usersExplicit };

    it('converts camelCase column names to snake_case in SELECT', () => {
      const db = createTestDb<{ users: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('users').select(['firstName', 'lastName']).compile();
      expect(query.sql).toBe('select "first_name", "last_name" from "users"');
    });

    it('converts camelCase column names in WHERE', () => {
      const db = createTestDb<{ users: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('users').selectAll().where('firstName', '=', 'John').compile();
      expect(query.sql).toBe('select * from "users" where "first_name" = ?');
    });

    it('converts camelCase column names in INSERT', () => {
      const db = createTestDb<{ users: any }>([ new SchemaPlugin(schema) ]);
      const query = db.insertInto('users').values({
        id: '1',
        firstName: 'John',
        lastName: 'Doe',
        createdAt: 'now',
      }).compile();
      expect(query.sql).toContain('"first_name"');
      expect(query.sql).toContain('"last_name"');
      expect(query.sql).toContain('"created_at"');
    });

    it('converts camelCase column names in UPDATE', () => {
      const db = createTestDb<{ users: any }>([ new SchemaPlugin(schema) ]);
      const query = db.updateTable('users').set({ firstName: 'Jane' }).where('id', '=', '1').compile();
      expect(query.sql).toContain('"first_name"');
    });
  });

  describe('with implicit column names (no explicit string)', () => {
    const schema = { products: productsImplicit };

    it('falls back to CamelCasePlugin for auto-snake_case', () => {
      const db = createTestDb<{ products: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('products').select(['productName', 'priceInCents']).compile();
      expect(query.sql).toBe('select "product_name", "price_in_cents" from "products"');
    });

    it('handles createdAt -> created_at', () => {
      const db = createTestDb<{ products: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('products').select('createdAt').compile();
      expect(query.sql).toBe('select "created_at" from "products"');
    });
  });

  describe('table name mapping', () => {
    it('maps schema key to SQL table name when they differ', () => {
      const schema = { userProfiles: userProfilesTable };
      const db = createTestDb<{ userProfiles: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('userProfiles').selectAll().compile();
      expect(query.sql).toBe('select * from "user_profiles"');
    });

    it('does not remap table names that already match', () => {
      const schema = { users: usersExplicit };
      const db = createTestDb<{ users: any }>([ new SchemaPlugin(schema) ]);
      const query = db.selectFrom('users').selectAll().compile();
      expect(query.sql).toBe('select * from "users"');
    });
  });

  describe('result transformation (SQL → JS)', () => {
    it('converts snake_case result columns to camelCase', async () => {
      const schema = { users: usersExplicit };
      const plugin = new SchemaPlugin(schema);
      const result = await plugin.transformResult({
        result: {
          rows: [{ first_name: 'John', last_name: 'Doe', created_at: '2025-01-01' }],
        },
        queryId: {} as any,
      });
      expect(result.rows[0]).toEqual({
        firstName: 'John',
        lastName: 'Doe',
        createdAt: '2025-01-01',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// DrizzleDefaultsPlugin tests
// ---------------------------------------------------------------------------

describe('DrizzleDefaultsPlugin', () => {
  describe('extractDefaults', () => {
    it('extracts defaultFn from schema columns', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const defaults = extractDefaults(schemas);
      expect(defaults.has('posts')).toBe(true);
      const tableDefaults = defaults.get('posts')!;
      expect(tableDefaults['id']).toBeDefined();
      expect(tableDefaults['id'].defaultFn).toBeDefined();
      expect(tableDefaults['id'].defaultFn!()).toBe('generated-id');
    });

    it('extracts onUpdateFn from schema columns', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const defaults = extractDefaults(schemas);
      const tableDefaults = defaults.get('posts')!;
      expect(tableDefaults['updated_at']).toBeDefined();
      expect(tableDefaults['updated_at'].onUpdateFn).toBeDefined();
      expect(tableDefaults['updated_at'].onUpdateFn!()).toBe('2025-06-01 12:00:00');
    });

    it('returns empty map for schemas without defaults', () => {
      const schemas = { users: usersExplicit } as any;
      const defaults = extractDefaults(schemas);
      // users table has no defaultFn/onUpdateFn
      expect(defaults.has('users')).toBe(false);
    });
  });

  describe('INSERT transformation', () => {
    it('adds missing default columns to INSERT', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      // Insert without id or createdAt — plugin should add them
      const query = db.insertInto('posts').values({
        title: 'Hello',
        body: 'World',
      }).compile();

      expect(query.sql).toContain('"id"');
      expect(query.sql).toContain('"created_at"');
      expect(query.parameters).toContain('generated-id');
      expect(query.parameters).toContain('2025-01-01 00:00:00');
    });

    it('does not override explicitly provided columns', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.insertInto('posts').values({
        id: 'custom-id',
        title: 'Hello',
        body: 'World',
        createdAt: 'custom-date',
      }).compile();

      expect(query.parameters).toContain('custom-id');
      expect(query.parameters).toContain('custom-date');
      expect(query.parameters).not.toContain('generated-id');
    });

    it('handles multiple rows', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.insertInto('posts').values([
        { title: 'Post 1', body: 'Body 1' },
        { title: 'Post 2', body: 'Body 2' },
      ]).compile();

      // Both rows should get default id and createdAt
      const idCount = query.parameters.filter(p => p === 'generated-id').length;
      const dateCount = query.parameters.filter(p => p === '2025-01-01 00:00:00').length;
      expect(idCount).toBe(2);
      expect(dateCount).toBe(2);
    });
  });

  describe('UPDATE transformation', () => {
    it('adds onUpdateFn columns to UPDATE', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.updateTable('posts')
        .set({ title: 'Updated' })
        .where('id', '=', '1')
        .compile();

      expect(query.sql).toContain('"updated_at"');
      expect(query.parameters).toContain('2025-06-01 12:00:00');
    });

    it('does not add onUpdateFn if column already in SET', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.updateTable('posts')
        .set({ title: 'Updated', updatedAt: 'manual-time' })
        .where('id', '=', '1')
        .compile();

      expect(query.parameters).toContain('manual-time');
      // Should not have duplicated the updatedAt column
      const updatedAtCount = (query.sql.match(/"updated_at"/g) || []).length;
      expect(updatedAtCount).toBe(1);
    });
  });

  describe('passthrough', () => {
    it('does not modify SELECT queries', () => {
      const schemas = { posts: postsWithDefaults } as any;
      const db = createTestDb<{ posts: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.selectFrom('posts').selectAll().compile();
      expect(query.sql).toBe('select * from "posts"');
    });

    it('does not modify queries on tables without defaults', () => {
      const schemas = { users: usersExplicit } as any;
      const db = createTestDb<{ users: any }>([
        new DrizzleDefaultsPlugin(schemas),
      ]);

      const query = db.insertInto('users').values({
        id: '1',
        firstName: 'John',
        createdAt: 'now',
      }).compile();

      // Should be unchanged (no defaults on users table)
      expect(query.parameters).toEqual(['1', 'John', 'now']);
    });
  });
});

// ---------------------------------------------------------------------------
// DateSerializePlugin tests
// ---------------------------------------------------------------------------

describe('DateSerializePlugin', () => {
  describe('dateSerializers', () => {
    it('serializes Date to SQLite format', () => {
      const date = new Date('2025-06-15T14:30:45.123Z');
      expect(dateSerializers.serialize(date)).toBe('2025-06-15 14:30:45');
    });

    it('deserializes SQLite date string to Date (space separator)', () => {
      const date = dateSerializers.deserialize('2025-06-15 14:30:45');
      expect(date.toISOString()).toBe('2025-06-15T14:30:45.000Z');
    });

    it('deserializes SQLite date string to Date (T separator)', () => {
      const date = dateSerializers.deserialize('2025-06-15T14:30:45');
      expect(date.toISOString()).toBe('2025-06-15T14:30:45.000Z');
    });

    it('identifies ISO date strings', () => {
      expect(dateSerializers.isDateString('2025-06-15 14:30:45')).toBe(true);
      expect(dateSerializers.isDateString('2025-06-15T14:30:45')).toBe(true);
      expect(dateSerializers.isDateString('not a date')).toBe(false);
      expect(dateSerializers.isDateString('12345')).toBe(false);
    });

    it('round-trips correctly', () => {
      const original = new Date('2025-03-20T10:15:30.000Z');
      const serialized = dateSerializers.serialize(original);
      const deserialized = dateSerializers.deserialize(serialized);
      expect(deserialized.toISOString()).toBe(original.toISOString());
    });
  });

  describe('query transformation', () => {
    it('transforms result rows with date strings', async () => {
      const plugin = new DateSerializePlugin();
      const result = await plugin.transformResult({
        result: {
          rows: [{
            name: 'John',
            created_at: '2025-06-15 14:30:45',
            age: 30,
          }],
        },
        queryId: {} as any,
      });

      expect(result.rows[0].name).toBe('John');
      expect(result.rows[0].created_at).toBeInstanceOf(Date);
      expect((result.rows[0].created_at as Date).toISOString()).toBe('2025-06-15T14:30:45.000Z');
      expect(result.rows[0].age).toBe(30);
    });

    it('leaves non-date strings alone', async () => {
      const plugin = new DateSerializePlugin();
      const result = await plugin.transformResult({
        result: {
          rows: [{ name: 'hello world', count: 42 }],
        },
        queryId: {} as any,
      });

      expect(result.rows[0].name).toBe('hello world');
      expect(result.rows[0].count).toBe(42);
    });

    it('handles empty rows', async () => {
      const plugin = new DateSerializePlugin();
      const result = await plugin.transformResult({
        result: { rows: [] },
        queryId: {} as any,
      });
      expect(result.rows).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// createDrizzlePlugins tests
// ---------------------------------------------------------------------------

describe('createDrizzlePlugins', () => {
  it('returns DrizzleDefaultsPlugin, SchemaPlugin, and DateSerializePlugin by default', () => {
    const schema = { users: usersExplicit };
    const plugins = createDrizzlePlugins(schema);
    expect(plugins).toHaveLength(3);
    expect(plugins[0]).toBeInstanceOf(DrizzleDefaultsPlugin);
    expect(plugins[1]).toBeInstanceOf(SchemaPlugin);
    expect(plugins[2]).toBeInstanceOf(DateSerializePlugin);
  });

  it('omits SchemaPlugin when camelCase is false', () => {
    const schema = { users: usersExplicit };
    const plugins = createDrizzlePlugins(schema, false);
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toBeInstanceOf(DrizzleDefaultsPlugin);
    expect(plugins[1]).toBeInstanceOf(DateSerializePlugin);
  });
});

// ---------------------------------------------------------------------------
// table() wrapper tests (from schema.ts)
// ---------------------------------------------------------------------------

describe('table() wrapper', () => {
  it('auto-converts camelCase table names to snake_case', async () => {
    const { table: t, text: txt } = await import('../../src/schema');
    const { getTableConfig } = await import('drizzle-orm/sqlite-core');

    const userProfiles = t('userProfiles', {
      id: txt().primaryKey(),
      displayName: txt().notNull(),
    });

    const config = getTableConfig(userProfiles);
    expect(config.name).toBe('user_profiles');
  });

  it('leaves already-snake_case table names unchanged', async () => {
    const { table: t, text: txt } = await import('../../src/schema');
    const { getTableConfig } = await import('drizzle-orm/sqlite-core');

    const users = t('users', {
      id: txt().primaryKey(),
    });

    const config = getTableConfig(users);
    expect(config.name).toBe('users');
  });

  it('works end-to-end with SchemaPlugin', async () => {
    const { table: t, text: txt, integer: int } = await import('../../src/schema');

    const userProfiles = t('userProfiles', {
      id: txt().primaryKey(),
      displayName: txt().notNull(),
      totalOrders: int().notNull(),
    });

    const schema = { userProfiles };
    const db = createTestDb<{ userProfiles: any }>([new SchemaPlugin(schema)]);

    const query = db.selectFrom('userProfiles')
      .select(['displayName', 'totalOrders'])
      .compile();

    // Table name: userProfiles → user_profiles (via SchemaPlugin table mapping)
    // Column names: displayName → display_name, totalOrders → total_orders (via CamelCasePlugin fallback)
    expect(query.sql).toBe('select "display_name", "total_orders" from "user_profiles"');
  });

  it('does not export sqliteTable', async () => {
    const schema = await import('../../src/schema');
    expect('sqliteTable' in schema).toBe(false);
  });
});
