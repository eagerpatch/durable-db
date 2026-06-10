import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverDatabaseFiles, readFile } from '../../src/vite/modules/discovery';
import { parseDatabaseFile } from '../../src/vite/modules/parser';
import { generateDurableObjectsModule, transformActionFile } from '../../src/vite/modules/generator';
import { generateRequiredConfig } from '../../src/vite/modules/wrangler';
import type { DatabaseInfo, ActionInfo } from '../../src/db';

describe('plugin integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-test-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('full workflow', () => {
    it('discovers, parses, and generates code for a database', () => {
      const schemaCode = `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.ts'), schemaCode);

      const mainCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
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
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

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

      // 3. Transform action file
      const transformed = transformActionFile({
        code,
        sourceFileName: discovered[0].absolutePath,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: '@eagerpatch/durable-db/context',
        registryImport: '@eagerpatch/durable-db/registry',
      });

      expect(transformed).not.toBeNull();
      expect(transformed!.code).toMatch(/export async function createUser/);
      expect(transformed!.code).toMatch(/export async function getUser/);
      expect(transformed!.code).toMatch(/getTenantId/);
      expect(transformed!.code).toMatch(/registerAction/);
      expect(transformed!.code).toMatch(/MAIN_DATABASE_DO/);

      // 4. Generate DO module
      const doModule = generateDurableObjectsModule(
        [parsed.database!],
        '@eagerpatch/durable-db/registry'
      );

      expect(doModule).toMatch(/class MainDatabaseDO extends SqliteDurableObject/);
      expect(doModule).toMatch(/async rpc/);
      expect(doModule).toMatch(/getAction/);

      // 5. Generate wrangler config
      const wranglerConfig = generateRequiredConfig([parsed.database!]);

      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(1);
      expect(wranglerConfig.durable_objects!.bindings![0].name).toBe('MAIN_DATABASE_DO');
      expect(wranglerConfig.durable_objects!.bindings![0].class_name).toBe('MainDatabaseDO');
    });

    it('handles multiple databases', () => {
      // Main database
      const mainCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
});
export const mainAction = action({
  args: {},
  handler: async (db, args, ctx) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

      // Analytics database (global)
      const analyticsCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
  instance: 'global',
});
export const logEvent = action({
  args: { type: 'string' },
  handler: async (db, args, ctx) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'analytics.ts'), analyticsCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(2);

      // Parse both
      const databases: DatabaseInfo[] = [];

      for (const file of discovered) {
        const code = readFile(file.absolutePath);
        const parsed = parseDatabaseFile(file.absolutePath, code);
        if (parsed.database) {
          databases.push(parsed.database);
        }
      }

      expect(databases).toHaveLength(2);

      const mainDb = databases.find((d) => d.name === 'main');
      const analyticsDb = databases.find((d) => d.name === 'analytics');

      expect(mainDb?.instance).toBe('per-tenant');
      expect(analyticsDb?.instance).toBe('global');

      // Generate DO module with both databases
      const doModule = generateDurableObjectsModule(databases, '@eagerpatch/durable-db/registry');

      expect(doModule).toMatch(/class MainDatabaseDO/);
      expect(doModule).toMatch(/class AnalyticsDatabaseDO/);

      // Generate wrangler config
      const wranglerConfig = generateRequiredConfig(databases);
      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(2);
    });

    it('generates correct stub for per-tenant database', () => {
      const mainCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
  instance: 'per-tenant',
});
export const createUser = action({
  args: { name: 'string' },
  handler: async (db, args) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: '@eagerpatch/durable-db/context',
        registryImport: '@eagerpatch/durable-db/registry',
      });

      // Should use getTenantId() for instance key
      expect(transformed!.code).toMatch(/getTenantId\(\)/);
    });

    it('generates correct stub for global database', () => {
      const analyticsCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
  instance: 'global',
});
export const logEvent = action({
  args: { type: 'string' },
  handler: async (db, args) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'analytics.ts'), analyticsCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: '@eagerpatch/durable-db/context',
        registryImport: '@eagerpatch/durable-db/registry',
      });

      // Should use "global" as instance key
      expect(transformed!.code).toMatch(/instanceKey\s*=\s*applyDevEpoch\(["']global["']\)/);
    });

    it('generates correct imports for websocket transport database', () => {
      const eventsCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
  transport: 'websocket',
});
export const logEvent = action({
  args: { type: 'string' },
  handler: async (db, args) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'events.ts'), eventsCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      // DO module should import from specific transport subpaths
      const doModule = generateDurableObjectsModule(
        [parsed.database!],
        '@eagerpatch/durable-db/registry'
      );

      expect(doModule).toContain('@eagerpatch/durable-db/transport/protocol');
      expect(doModule).not.toMatch(/'@eagerpatch\/durable-db\/transport'/);

      // Action file should import WebSocketTransport from specific subpath
      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: '@eagerpatch/durable-db/context',
        registryImport: '@eagerpatch/durable-db/registry',
      });

      expect(transformed!.code).toContain('@eagerpatch/durable-db/transport/websocket');
      expect(transformed!.code).not.toMatch(/'@eagerpatch\/durable-db\/transport'/);
    });

    it('includes DO short path optimization', () => {
      const mainCode = `
import { defineDatabase } from '@eagerpatch/durable-db/db';
export const { action } = defineDatabase({
  schema: {},
});
export const createUser = action({
  args: { name: 'string' },
  handler: async (db, args) => null,
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);

      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: '@eagerpatch/durable-db/context',
        registryImport: '@eagerpatch/durable-db/registry',
      });

      // Should include DO context check for short path
      expect(transformed!.code).toMatch(/getDoContext/);
      expect(transformed!.code).toMatch(/callAction/);
      expect(transformed!.code).toMatch(/__do/);
    });
  });
});
