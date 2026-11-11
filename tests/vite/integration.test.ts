import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { build, type Plugin as VitePlugin } from 'vite';
import { durableDb } from '../../src/vite/durableDb';
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
import { defineDatabase } from 'durable-db/db';
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
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
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
        'durable-db/registry'
      );

      expect(doModule).toMatch(/class MainDatabaseDO extends SqliteDurableObject/);
      expect(doModule).toMatch(/async rpc/);
      expect(doModule).toMatch(/getAction/);

      // The generated DO must import the Drizzle schema (aliased) and carry it
      // as a class property, so its Kysely gets the full schema-aware plugin
      // chain (defaults, exact column mapping, date/boolean deserialization) —
      // without this, boolean columns read back as raw storage values in
      // production. The relative './schema' import is resolved against the
      // database file since the generated module lives at a virtual id.
      expect(doModule).toMatch(/import { users as __schema_main_users } from/);
      expect(doModule).toContain(path.join('src', 'databases', 'schema'));
      expect(doModule).toMatch(/schema = \{\s*users: __schema_main_users\s*\}/);

      // 5. Generate wrangler config
      const wranglerConfig = generateRequiredConfig([parsed.database!]);

      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(1);
      expect(wranglerConfig.durable_objects!.bindings![0].name).toBe('MAIN_DATABASE_DO');
      expect(wranglerConfig.durable_objects!.bindings![0].class_name).toBe('MainDatabaseDO');
    });

    it('handles multiple databases', () => {
      // Main database
      const mainCode = `
import { defineDatabase } from 'durable-db/db';
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
import { defineDatabase } from 'durable-db/db';
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
      const doModule = generateDurableObjectsModule(databases, 'durable-db/registry');

      expect(doModule).toMatch(/class MainDatabaseDO/);
      expect(doModule).toMatch(/class AnalyticsDatabaseDO/);

      // Generate wrangler config
      const wranglerConfig = generateRequiredConfig(databases);
      expect(wranglerConfig.durable_objects!.bindings).toHaveLength(2);
    });

    it('generates correct stub for per-tenant database', () => {
      const mainCode = `
import { defineDatabase } from 'durable-db/db';
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
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
      });

      // Should use getTenantId() for instance key
      expect(transformed!.code).toMatch(/getTenantId\(\)/);
    });

    it('keeps the related() a handler reads with', () => {
      const mainCode = `
import { defineDatabase } from 'durable-db/db';
import { users, posts } from './schema';
export const { action, related, relations } = defineDatabase({
  schema: { users, posts },
});
export const listUsers = action({
  args: {},
  handler: async (db) => db.selectFrom('users').select(['users.id', related('users', 'posts', ['title'])]).execute(),
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      const code = readFile(discovered[0].absolutePath);
      const parsed = parseDatabaseFile(discovered[0].absolutePath, code);
      expect(parsed.actions.map((action) => action.exportName)).toEqual(['listUsers']);

      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
      });

      // The factory's other members stay where the handler reads them from.
      expect(transformed!.code).toMatch(/const\s*\{\s*action,\s*related,\s*relations\s*\}\s*=\s*defineDatabase/);
      expect(transformed!.code).toContain("related('users', 'posts', ['title'])");
      expect(transformed!.code).toContain('export async function listUsers');
    });

    it('generates correct stub for global database', () => {
      const analyticsCode = `
import { defineDatabase } from 'durable-db/db';
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
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
      });

      // Should use "global" as instance key
      expect(transformed!.code).toMatch(/instanceKey\s*=\s*applyDevEpoch\(["']global["'], ["']analytics["']\)/);
    });

    it('generates correct imports for websocket transport database', () => {
      const eventsCode = `
import { defineDatabase } from 'durable-db/db';
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
        'durable-db/registry'
      );

      expect(doModule).toContain('durable-db/transport/protocol');
      expect(doModule).not.toMatch(/'durable-db\/transport'/);

      // Action file should import WebSocketTransport from specific subpath
      const transformed = transformActionFile({
        code,
        dbName: parsed.database!.name,
        database: parsed.database!,
        actionsInFile: parsed.actions,
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
      });

      expect(transformed!.code).toContain('durable-db/transport/websocket');
      expect(transformed!.code).not.toMatch(/'durable-db\/transport'/);
    });

    it('includes DO short path optimization', () => {
      const mainCode = `
import { defineDatabase } from 'durable-db/db';
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
        contextImport: 'durable-db/context',
        registryImport: 'durable-db/registry',
      });

      // Should include DO context check for short path
      expect(transformed!.code).toMatch(/getDoContext/);
      expect(transformed!.code).toMatch(/callAction/);
      expect(transformed!.code).toMatch(/__do/);
    });
  });
});

// ============================================================================
// One build emits the wrangler config it patched
// ============================================================================

describe('build output wrangler config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-build-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * What @cloudflare/vite-plugin does with the worker config: read it in its
   * `config` hook (a normal-order plugin) and emit the build's wrangler.json
   * from that copy in generateBundle.
   */
  function workerConfigSnapshotPlugin(): VitePlugin {
    let snapshot = '';
    return {
      name: 'test:worker-config-snapshot',
      config(userConfig) {
        snapshot = fs.readFileSync(path.join(userConfig.root!, 'wrangler.jsonc'), 'utf-8');
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'wrangler.json', source: snapshot });
      },
    };
  }

  it('a database added since the last build is bound in that same build', async () => {
    fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
      name: 'store',
      main: 'src/index.ts',
      durable_objects: { bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] }],
    }, null, 2));
    fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.ts'), `
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const items = sqliteTable('items', { id: text().primaryKey() });
`);
    for (const name of ['main', 'wishlist']) {
      // `wishlist` is the database added since the config was last patched
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', `${name}.ts`), `
import { defineDatabase } from 'durable-db/db';
import { items } from './schema';
export const { action } = defineDatabase({ schema: { items } });
`);
    }
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), `
export * from 'virtual:durable-db/__durableObjects';
export default { fetch: () => new Response('ok') };
`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const output = await build({
      root: tempDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [durableDb({ patchWranglerConfig: true }), workerConfigSnapshotPlugin()],
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(tempDir, 'src', 'index.ts'), formats: ['es'], fileName: 'index' },
        rollupOptions: { external: [/^durable-db/, /^drizzle-orm/, /^cloudflare:/] },
      },
    });
    logSpy.mockRestore();

    const bundle = (Array.isArray(output) ? output[0] : output) as { output: Array<{ fileName: string; type: string; source?: string | Uint8Array; code?: string }> };
    const emitted = bundle.output.find((file) => file.fileName === 'wrangler.json')!;
    const config = JSON.parse(String(emitted.source));
    const worker = bundle.output.find((file) => file.type === 'chunk')!;

    // The worker exports the new Durable Object class…
    expect(worker.code).toMatch(/\bWishlistDatabaseDO = class extends SqliteDurableObject\b/);
    expect(worker.code).toMatch(/export \{[^}]*\bWishlistDatabaseDO\b/);
    // …and the config this build emits binds it, with its migration.
    expect(config.durable_objects.bindings).toEqual([
      { name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' },
      { name: 'WISHLIST_DATABASE_DO', class_name: 'WishlistDatabaseDO' },
    ]);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] },
      { tag: 'v2', new_sqlite_classes: ['WishlistDatabaseDO'] },
    ]);
  }, 30_000);
});
