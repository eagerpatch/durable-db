import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverDatabaseFiles, readFile } from '../modules/discovery';
import { parseDatabaseFile, resolveInternalActionCalls } from '../modules/parser';
import { generateRpcStubs, generateDurableObjectsModule } from '../modules/generator';
import { generateRequiredConfig } from '../modules/wrangler';
import type { DatabaseInfo, ActionInfo } from '../../db/types';

describe('plugin integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-test-'));

    // Create test structure
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
  });

  describe('full workflow', () => {
    it('discovers, parses, and generates code for a database', () => {
      // Create test files
      const schemaCode = `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.js'), schemaCode);

      const mainCode = `
import { defineDatabase } from '@shoplayer/database/db';
import { users } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users },
});

export const createUser = action({
  args: { name: 'string', email: 'string.email' },
  handler: async (db, args, ctx) => {
    return db.insertInto('users').values({ id: crypto.randomUUID(), ...args }).execute();
  },
});

export const getUser = action({
  args: { id: 'string' },
  handler: async (db, args, ctx) => {
    return db.selectFrom('users').where('id', '=', args.id).executeTakeFirst();
  },
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.js'), mainCode);

      // 1. Discover databases
      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('main');

      // 2. Parse database file
      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      expect(parsed.database).not.toBeNull();
      expect(parsed.database!.name).toBe('main');
      expect(parsed.database!.className).toBe('MainDatabaseDO');
      expect(parsed.actions).toHaveLength(2);

      // 3. Generate RPC stubs
      const stubs = generateRpcStubs(parsed.database!, parsed.actions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(stubs).toContain('export async function createUser');
      expect(stubs).toContain('export async function getUser');
      expect(stubs).toContain('getContext');
      expect(stubs).toContain('MAIN_DATABASE_DO');

      // 4. Generate DO module
      const actionsByDb = new Map([['main', parsed.actions]]);
      const doModule = generateDurableObjectsModule([parsed.database!], actionsByDb, parsed.actions);

      expect(doModule).toContain('class MainDatabaseDO extends SqliteDurableObject');
      expect(doModule).toContain('async createUser');
      expect(doModule).toContain('async getUser');

      // 5. Generate wrangler config
      const wranglerConfig = generateRequiredConfig([parsed.database!]);

      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(1);
      expect(wranglerConfig.durable_objects!.bindings![0].name).toBe('MAIN_DATABASE_DO');
      expect(wranglerConfig.durable_objects!.bindings![0].class_name).toBe('MainDatabaseDO');
    });

    it('handles internal action calls correctly', () => {
      const mainCode = `
import { defineDatabase } from '@shoplayer/database/db';
import { users } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users },
});

export const getUser = action({
  args: { id: 'string' },
  handler: async (db, args, ctx) => {
    return db.selectFrom('users').where('id', '=', args.id).executeTakeFirst();
  },
});

export const createUserIfNotExists = action({
  args: { name: 'string', email: 'string' },
  handler: async (db, args, ctx) => {
    const existing = await getUser({ id: args.email });
    if (existing) return existing;
    return db.insertInto('users').values({ id: args.email, ...args }).execute();
  },
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.js'), mainCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      // Resolve internal action calls (pass same array twice for single-DB case)
      resolveInternalActionCalls(parsed.actions, parsed.actions);

      // Check that createUserIfNotExists knows it calls getUser
      const createIfNotExists = parsed.actions.find(a => a.exportName === 'createUserIfNotExists');
      expect(createIfNotExists?.internalActionCalls).toContain('getUser');

      // Generate DO and verify transformation
      const actionsByDb = new Map([['main', parsed.actions]]);
      const doModule = generateDurableObjectsModule([parsed.database!], actionsByDb, parsed.actions);

      // The generated code should have this.getUser instead of getUser
      expect(doModule).toContain('this.getUser');
      expect(doModule).toContain('internal calls');
    });

    it('handles multiple databases', () => {
      // Main database
      const mainCode = `
import { defineDatabase } from '@shoplayer/database/db';
export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: {},
});
export const mainAction = action({
  args: {},
  handler: async (db, args, ctx) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.js'), mainCode);

      // Analytics database (global)
      const analyticsCode = `
import { defineDatabase } from '@shoplayer/database/db';
export const { action } = defineDatabase({
  migrationsDir: './migrations/analytics',
  schema: {},
  instance: 'global',
});
export const logEvent = action({
  args: { type: 'string' },
  handler: async (db, args, ctx) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'analytics.js'), analyticsCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(2);

      // Parse both
      const databases: DatabaseInfo[] = [];
      const allActions: ActionInfo[] = [];

      for (const file of discovered) {
        const code = readFile(file.absolutePath);
        const parsed = parseDatabaseFile(file.absolutePath, code);
        if (parsed.database) {
          databases.push(parsed.database);
        }
        allActions.push(...parsed.actions);
      }

      expect(databases).toHaveLength(2);

      const mainDb = databases.find(d => d.name === 'main');
      const analyticsDb = databases.find(d => d.name === 'analytics');

      expect(mainDb?.instance).toBe('per-shop');
      expect(analyticsDb?.instance).toBe('global');

      // Generate wrangler config
      const wranglerConfig = generateRequiredConfig(databases);
      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(2);
    });

    it('transforms cross-database action calls to RPC', () => {
      // Main database with action that calls another database
      const mainCode = `
import { defineDatabase } from '@shoplayer/database/db';
export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: {},
});
export const createUserWithAnalytics = action({
  args: { name: 'string' },
  handler: async (db, args, ctx) => {
    const user = await db.insertInto('users').values(args).execute();
    await logEvent({ type: 'user_created' });
    return user;
  },
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.js'), mainCode);

      // Analytics database
      const analyticsCode = `
import { defineDatabase } from '@shoplayer/database/db';
export const { action } = defineDatabase({
  migrationsDir: './migrations/analytics',
  schema: {},
  instance: 'global',
});
export const logEvent = action({
  args: { type: 'string' },
  handler: async (db, args, ctx) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'analytics.js'), analyticsCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      // Parse both
      const databases: DatabaseInfo[] = [];
      const allActions: ActionInfo[] = [];
      const actionsByDb = new Map<string, ActionInfo[]>();

      for (const file of discovered) {
        const code = readFile(file.absolutePath);
        const parsed = parseDatabaseFile(file.absolutePath, code);
        if (parsed.database) {
          databases.push(parsed.database);
          actionsByDb.set(parsed.database.name, parsed.actions);
        }
        allActions.push(...parsed.actions);
      }

      // Resolve internal/cross-DB calls for each database
      for (const [dbName, dbActions] of actionsByDb) {
        resolveInternalActionCalls(dbActions, allActions);
      }

      // Find the action that calls across databases
      const mainActions = actionsByDb.get('main') ?? [];
      const createUserWithAnalytics = mainActions.find(a => a.exportName === 'createUserWithAnalytics');

      // Should detect logEvent as a cross-DB call
      expect(createUserWithAnalytics?.crossDbActionCalls).toContain('logEvent');
      expect(createUserWithAnalytics?.internalActionCalls).toEqual([]);

      // Generate DO and verify it transforms cross-DB calls to RPC
      const doModule = generateDurableObjectsModule(databases, actionsByDb, allActions);

      // Should contain the RPC transformation
      expect(doModule).toContain('cross-DB calls');
      expect(doModule).toContain('ANALYTICS_DATABASE_DO');
      expect(doModule).toContain('idFromName');
      expect(doModule).toContain('instanceKey');
    });
  });
});
