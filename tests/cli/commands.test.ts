import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { push, pushOne } from '../../src/cli/push';
import { generate, generateOne, UnsafeMigrationError } from '../../src/cli/generate';
import { reset, resetAndPush, DevServerRunningError } from '../../src/cli/reset';
import { status, formatStatus } from '../../src/cli/status';
import { validate } from '../../src/cli/validate';
import { UnknownDatabaseError } from '../../src/cli/shared';
import {
  loadDevState,
  saveDevState,
  getDevPaths,
  getDatabaseEpoch,
  loadDevMigrations,
  writeDevServerLock,
  DEV_SERVER_LOCK_FILE,
} from '../../src/cli/state';
import { loadMigrationFiles, loadSnapshot } from '../../src/migrations/generator';
import { SchemaRenameRequiredError } from '../../src/migrations/snapshot';

describe('CLI commands', () => {
  let tempDir: string;
  let databasesDir: string;
  let nodeModulesDir: string;

  beforeEach(() => {
    // Create a temp directory that simulates a project root
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-cli-commands-'));
    nodeModulesDir = path.join(tempDir, 'node_modules');
    databasesDir = path.join(tempDir, 'src/databases');
    
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.mkdirSync(databasesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a mock database setup
   */
  function createMockDatabase(
    name: string,
    schemaContent: string,
    existingMigrations: string[] = []
  ) {
    const dbDir = databasesDir;

    // Create schema file
    fs.writeFileSync(
      path.join(dbDir, 'schema.ts'),
      schemaContent
    );

    // Create database definition file
    fs.writeFileSync(
      path.join(dbDir, `${name}.ts`),
      `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`
    );

    // Create migrations directory with existing migrations (convention: {root}/migrations/{name}/)
    const migrationsDir = path.join(tempDir, 'migrations', name);
    fs.mkdirSync(migrationsDir, { recursive: true });

    for (let i = 0; i < existingMigrations.length; i++) {
      const migName = `${String(i + 1).padStart(14, '0')}_migration`;
      fs.writeFileSync(
        path.join(migrationsDir, `${migName}.sql`),
        existingMigrations[i]
      );
    }

    // Create initial snapshot if no migrations
    if (existingMigrations.length === 0) {
      fs.writeFileSync(
        path.join(migrationsDir, '_snapshot.json'),
        JSON.stringify({
          version: '6',
          dialect: 'sqlite',
          id: '0000000000000',
          prevId: '',
          tables: {},
          enums: {},
          views: {},
          _meta: { tables: {}, columns: {} },
        }, null, 2)
      );
    }
  }

  describe('status command', () => {
    it('returns empty status when no databases exist', async () => {
      const result = await status({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(result.epoch).toBeDefined();
      expect(result.databases).toHaveLength(0);
    });

    it('formats status correctly', () => {
      const result = {
        epoch: 'abc123',
        databases: [
          {
            name: 'main',
            prodMigrationCount: 3,
            devMigrationCount: 1,
            hasUncommittedChanges: true,
            pendingStatements: ['ALTER TABLE users ADD COLUMN bio TEXT'],
            prodSnapshotChanged: false,
            epoch: 'abc123',
            lastPush: '2024-01-01T00:00:00Z',
          },
        ],
      };

      const formatted = formatStatus(result);

      expect(formatted).toContain('Dev Epoch: abc123');
      expect(formatted).toContain('main');
      expect(formatted).toContain('Production migrations: 3');
      expect(formatted).toContain('Dev migrations: 1');
      expect(formatted).toContain('Uncommitted changes');
      expect(formatted).toContain('ALTER TABLE');
    });

    it('shows warning when prod snapshot changed', () => {
      const result = {
        epoch: 'abc123',
        databases: [
          {
            name: 'main',
            prodMigrationCount: 3,
            devMigrationCount: 1,
            hasUncommittedChanges: false,
            pendingStatements: [],
            prodSnapshotChanged: true,
            epoch: 'abc123',
            lastPush: null,
          },
        ],
      };

      const formatted = formatStatus(result);

      expect(formatted).toContain("run 'db:reset'");
    });
  });

  describe('reset command', () => {
    it('bumps epoch by default', async () => {
      // Create and save initial state
      const { saveDevState } = await import('../../src/cli/state');
      const initialState = loadDevState(tempDir);
      saveDevState(tempDir, initialState);
      const oldEpoch = initialState.epoch;

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await reset({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(result.newEpoch).toBeDefined();
      expect(result.newEpoch).not.toBe(oldEpoch);

      // Verify state was updated
      const newState = loadDevState(tempDir);
      expect(newState.epoch).toBe(result.newEpoch);
    });

    it('keeps epoch when keepEpoch is true', async () => {
      // Create and save initial state
      const { saveDevState } = await import('../../src/cli/state');
      const initialState = loadDevState(tempDir);
      saveDevState(tempDir, initialState);
      const oldEpoch = initialState.epoch;

      const result = await reset({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      }, { keepEpoch: true });

      expect(result.newEpoch).toBeNull();

      const newState = loadDevState(tempDir);
      expect(newState.epoch).toBe(oldEpoch);
    });

    it('clears dev migrations for all databases', async () => {
      // Create some dev state manually
      const paths = getDevPaths(tempDir);
      const dbMigrationsDir = paths.migrationsDir('testdb');
      fs.mkdirSync(dbMigrationsDir, { recursive: true });
      fs.writeFileSync(path.join(dbMigrationsDir, '0001_dev.sql'), 'SELECT 1');

      // Also add to state
      const state = loadDevState(tempDir);
      state.databases['testdb'] = {
        prodSnapshotHash: 'hash',
        lastPush: '2024-01-01',
      };
      const { saveDevState } = await import('../../src/cli/state');
      saveDevState(tempDir, state);

      // Reset
      await reset({ projectRoot: tempDir, databasesDir: 'src/databases' });

      // Verify migrations cleared
      expect(fs.existsSync(dbMigrationsDir)).toBe(false);
    });

    it('resets only specific database when specified', async () => {
      for (const name of ['db1', 'db2']) {
        fs.writeFileSync(
          path.join(databasesDir, `${name}.ts`),
          `import { defineDatabase } from 'durable-db/db';\nexport const { action } = defineDatabase({});\n`
        );
      }

      // Create dev state for two databases
      const paths = getDevPaths(tempDir);
      
      const db1Dir = paths.migrationsDir('db1');
      const db2Dir = paths.migrationsDir('db2');
      fs.mkdirSync(db1Dir, { recursive: true });
      fs.mkdirSync(db2Dir, { recursive: true });
      fs.writeFileSync(path.join(db1Dir, '0001_dev.sql'), 'SELECT 1');
      fs.writeFileSync(path.join(db2Dir, '0001_dev.sql'), 'SELECT 2');

      // Reset only db1
      const result = await reset(
        { projectRoot: tempDir, databasesDir: 'src/databases' },
        { database: 'db1' }
      );

      expect(result.databases).toEqual(['db1']);
      expect(fs.existsSync(db1Dir)).toBe(false);
      expect(fs.existsSync(db2Dir)).toBe(true); // db2 should still exist
    });

    it('keeps local DO storage by default (epoch bump handles freshness)', async () => {
      const doDir = path.join(tempDir, '.wrangler', 'state', 'v3', 'do', 'worker-MainDatabaseDO');
      fs.mkdirSync(doDir, { recursive: true });
      fs.writeFileSync(path.join(doDir, 'abc123.sqlite'), 'fake sqlite');

      const result = await reset({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(fs.existsSync(doDir)).toBe(true);
      expect(result.clearedStorageDirs).toEqual([]);
    });

    it('purges local DO storage when purgeLocalStorage is true', async () => {
      const doDir = path.join(tempDir, '.wrangler', 'state', 'v3', 'do', 'worker-MainDatabaseDO');
      fs.mkdirSync(doDir, { recursive: true });
      fs.writeFileSync(path.join(doDir, 'abc123.sqlite'), 'fake sqlite');

      const result = await reset(
        { projectRoot: tempDir, databasesDir: 'src/databases' },
        { purgeLocalStorage: true }
      );

      expect(fs.existsSync(doDir)).toBe(false);
      expect(result.clearedStorageDirs).toHaveLength(1);
      expect(result.clearedStorageDirs[0]).toContain('.wrangler');
    });

    it('reports no purged storage when .wrangler does not exist', async () => {
      const result = await reset(
        { projectRoot: tempDir, databasesDir: 'src/databases' },
        { purgeLocalStorage: true }
      );

      expect(result.clearedStorageDirs).toEqual([]);
    });

    it('only purges the matching DO storage for a targeted reset', async () => {
      // Two databases with discoverable definition files
      createMockDatabase('main', `
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', { id: text('id').primaryKey() });
`);
      fs.writeFileSync(
        path.join(databasesDir, 'analytics.ts'),
        `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`
      );

      const mainDoDir = path.join(tempDir, '.wrangler', 'state', 'v3', 'do', 'worker-MainDatabaseDO');
      const analyticsDoDir = path.join(tempDir, '.wrangler', 'state', 'v3', 'do', 'worker-AnalyticsDatabaseDO');
      fs.mkdirSync(mainDoDir, { recursive: true });
      fs.mkdirSync(analyticsDoDir, { recursive: true });

      const result = await reset(
        { projectRoot: tempDir, databasesDir: 'src/databases' },
        { database: 'main', purgeLocalStorage: true }
      );

      expect(fs.existsSync(mainDoDir)).toBe(false);
      expect(fs.existsSync(analyticsDoDir)).toBe(true);
      expect(result.clearedStorageDirs).toEqual([mainDoDir]);
    });
  });

  describe('integration: reset and push', () => {
    it('combines reset and push', async () => {
      const result = await resetAndPush({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(result.reset.newEpoch).toBeDefined();
      expect(Array.isArray(result.push)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles non-existent databases directory gracefully', async () => {
      // Remove the databases directory
      fs.rmSync(databasesDir, { recursive: true, force: true });

      const statusResult = await status({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });
      expect(statusResult.databases).toHaveLength(0);

      const pushResult = await push({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });
      expect(pushResult).toHaveLength(0);

      const generateResult = await generate({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });
      expect(generateResult).toHaveLength(0);
    });

    it('handles database without schema gracefully', async () => {
      // Create a database file without schema
      fs.writeFileSync(
        path.join(databasesDir, 'noschema.ts'),
        `
import { defineDatabase } from 'durable-db/db';

export const { action } = defineDatabase({});
`
      );

      const result = await push({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
        verbose: true,
      });

      // Should return result but with no changes
      expect(result).toHaveLength(1);
      expect(result[0].hasChanges).toBe(false);
    });
  });
});

describe('CLI workflow scenarios', () => {
  let tempDir: string;
  let databasesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-workflow-'));
    databasesDir = path.join(tempDir, 'src/databases');
    
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(databasesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('simulates full workflow: new project → push → generate', async () => {
    // Step 1: Create a minimal schema file (no actual Drizzle, just for parsing)
    fs.writeFileSync(
      path.join(databasesDir, 'schema.ts'),
      `export const users = {};`
    );

    // Step 2: Create database definition
    fs.writeFileSync(
      path.join(databasesDir, 'main.ts'),
      `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`
    );

    // Create migrations directory with initial snapshot (convention: {root}/migrations/{name}/)
    const migrationsDir = path.join(tempDir, 'migrations', 'main');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, '_snapshot.json'),
      JSON.stringify({
        version: '6',
        dialect: 'sqlite',
        id: '0000000000000',
        prevId: '',
        tables: {},
        enums: {},
        views: {},
        _meta: { tables: {}, columns: {} },
      }, null, 2)
    );

    // Step 3: Check initial status
    const initialStatus = await status({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(initialStatus.databases).toHaveLength(1);
    expect(initialStatus.databases[0].name).toBe('main');
    expect(initialStatus.databases[0].prodMigrationCount).toBe(0);
    expect(initialStatus.databases[0].devMigrationCount).toBe(0);
  });

  it('tracks prod snapshot changes', async () => {
    // Setup initial database
    fs.writeFileSync(
      path.join(databasesDir, 'schema.ts'),
      `export const users = {};`
    );

    fs.writeFileSync(
      path.join(databasesDir, 'main.ts'),
      `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`
    );

    const migrationsDir = path.join(tempDir, 'migrations', 'main');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, '_snapshot.json'),
      JSON.stringify({
        version: '6',
        dialect: 'sqlite',
        id: 'initial',
        prevId: '',
        tables: { users: { name: 'users' } },
        enums: {},
        views: {},
        _meta: { tables: {}, columns: {} },
      }, null, 2)
    );

    // Simulate having done a push (create dev state)
    const { saveDevState, loadDevState, hashSnapshot } = await import('../../src/cli/state');
    const { loadSnapshot } = await import('../../src/migrations/generator');
    
    const prodSnapshot = loadSnapshot(migrationsDir);
    const state = loadDevState(tempDir);
    state.databases['main'] = {
      prodSnapshotHash: 'oldhash', // Intentionally wrong hash
      lastPush: '2024-01-01',
    };
    saveDevState(tempDir, state);

    // Check status - should show prod snapshot changed
    const statusResult = await status({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(statusResult.databases[0].prodSnapshotChanged).toBe(true);
  });
});

// ============================================================================
// A project with real Drizzle schemas: per-database reset, --database
// filters, the purge guard, rename resolution and unsafe migrations
// ============================================================================

describe('CLI commands on a real schema', () => {
  const drizzleOrmDir = fileURLToPath(new URL('../../node_modules/drizzle-orm', import.meta.url));
  let tempDir: string;
  let databasesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-cli-real-'));
    databasesDir = path.join(tempDir, 'src/databases');
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(databasesDir, { recursive: true });
    // The schema is compiled and imported from the temp project
    fs.symlinkSync(drizzleOrmDir, path.join(tempDir, 'node_modules', 'drizzle-orm'), 'dir');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const ctx = () => ({ projectRoot: tempDir, databasesDir: 'src/databases', migrationsDir: 'migrations' });

  /** catalog (products) and reviews (reviews), from one schema module. */
  function writeProject(productColumns: string) {
    fs.writeFileSync(path.join(databasesDir, 'schema.ts'), `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const products = sqliteTable('products', {
  id: text().primaryKey(),
${productColumns}
});
export const reviews = sqliteTable('reviews', { id: text().primaryKey(), rating: integer() });
`);
    fs.writeFileSync(path.join(databasesDir, 'catalog.ts'), `
import { defineDatabase } from 'durable-db/db';
import { products } from './schema';
export const { action } = defineDatabase({ schema: { products } });
`);
    fs.writeFileSync(path.join(databasesDir, 'reviews.ts'), `
import { defineDatabase } from 'durable-db/db';
import { reviews } from './schema';
export const { action } = defineDatabase({ schema: { reviews } });
`);
  }

  describe('reset --database (C43)', () => {
    it('gives only that database a new epoch; the others keep the project epoch', async () => {
      writeProject('  name: text().notNull(),');
      const before = loadDevState(tempDir);
      saveDevState(tempDir, before);

      const result = await reset(ctx(), { database: 'catalog' });

      const after = loadDevState(tempDir);
      expect(after.epoch).toBe(before.epoch);
      expect(after.databases.catalog.epoch).toBe(result.newEpoch);
      expect(result.newEpoch).not.toBe(before.epoch);
      expect(getDatabaseEpoch(after, 'catalog')).toBe(result.newEpoch);
      expect(getDatabaseEpoch(after, 'reviews')).toBe(before.epoch);
    });

    it('a full reset moves every database to the new project epoch', async () => {
      writeProject('  name: text().notNull(),');
      await reset(ctx(), { database: 'catalog' });

      const result = await reset(ctx());

      const state = loadDevState(tempDir);
      expect(state.epoch).toBe(result.newEpoch);
      expect(state.databases).toEqual({});
      expect(getDatabaseEpoch(state, 'catalog')).toBe(result.newEpoch);
    });

    it('generate keeps a database\'s own epoch (it would otherwise fall back to the old instances)', async () => {
      writeProject('  name: text().notNull(),');
      const { newEpoch } = await reset(ctx(), { database: 'catalog' });

      const results = await generate(ctx(), { name: 'init', interactive: false });

      expect(results.find((r) => r.database === 'catalog')!.hasChanges).toBe(true);
      expect(getDatabaseEpoch(loadDevState(tempDir), 'catalog')).toBe(newEpoch);
    });

    it('rejects an unknown name without touching the dev state', async () => {
      writeProject('  name: text().notNull(),');
      const before = loadDevState(tempDir);
      saveDevState(tempDir, before);

      await expect(reset(ctx(), { database: 'nope' })).rejects.toThrow(
        "Unknown database 'nope'. Databases: catalog, reviews."
      );
      expect(loadDevState(tempDir)).toEqual(before);
    });

    it('every --database filter rejects an unknown name, listing the valid ones', async () => {
      writeProject('  name: text().notNull(),');
      const message = "Unknown database 'nope'. Databases: catalog, reviews.";

      await expect(push({ ...ctx(), database: 'nope' })).rejects.toBeInstanceOf(UnknownDatabaseError);
      await expect(push({ ...ctx(), database: 'nope' })).rejects.toThrow(message);
      await expect(generate(ctx(), { database: 'nope' })).rejects.toThrow(message);
      await expect(validate({ ...ctx(), database: 'nope' })).rejects.toThrow(message);
      await expect(status({ ...ctx(), database: 'nope' })).rejects.toThrow(message);
      // the programmatic single-database helpers keep returning null
      expect(await generateOne(ctx(), 'nope')).toBeNull();
      expect(await pushOne(ctx(), 'nope')).toBeNull();
    });

    it('a known --database filter selects that database', async () => {
      writeProject('  name: text().notNull(),');
      const results = await push({ ...ctx(), database: 'reviews', interactive: false });
      expect(results.map((r) => r.database)).toEqual(['reviews']);
    });
  });

  describe('reset --purge-local-storage under a running dev server (C49)', () => {
    function writeDoStorage() {
      const doDir = path.join(tempDir, '.wrangler', 'state', 'v3', 'do', 'worker-CatalogDatabaseDO');
      fs.mkdirSync(doDir, { recursive: true });
      return doDir;
    }

    it('refuses while the dev server\'s process is alive, and changes nothing', async () => {
      writeProject('  name: text().notNull(),');
      const doDir = writeDoStorage();
      writeDevServerLock(tempDir); // this process plays the dev server
      const before = loadDevState(tempDir);
      saveDevState(tempDir, before);

      const error = await reset(ctx(), { purgeLocalStorage: true }).catch((e) => e);

      expect(error).toBeInstanceOf(DevServerRunningError);
      expect(error.message).toContain(`pid ${process.pid}`);
      expect(error.message).toContain('--force');
      expect(fs.existsSync(doDir)).toBe(true);
      expect(loadDevState(tempDir)).toEqual(before);
    });

    it('purges with --force', async () => {
      writeProject('  name: text().notNull(),');
      const doDir = writeDoStorage();
      writeDevServerLock(tempDir);

      const result = await reset(ctx(), { purgeLocalStorage: true, force: true });

      expect(fs.existsSync(doDir)).toBe(false);
      expect(result.clearedStorageDirs).toHaveLength(1);
    });

    it('purges when the lock is stale (its process is gone)', async () => {
      writeProject('  name: text().notNull(),');
      const doDir = writeDoStorage();
      const lockFile = path.join(getDevPaths(tempDir).cacheDir, DEV_SERVER_LOCK_FILE);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x', startedAt: '' }));

      await reset(ctx(), { purgeLocalStorage: true });

      expect(fs.existsSync(doDir)).toBe(false);
    });
  });

  describe('renames without a terminal (C48)', () => {
    async function generateInitial() {
      writeProject('  description: text().notNull(),');
      await generate(ctx(), { name: 'init', interactive: false });
      writeProject('  summary: text().notNull(),');
    }

    it('status reports changes pending that need rename resolution, not "up to date"', async () => {
      await generateInitial();

      const result = await status(ctx());
      const catalog = result.databases.find((db) => db.name === 'catalog')!;

      expect(catalog.hasUncommittedChanges).toBe(true);
      expect(catalog.needsRenameResolution).toEqual([
        { kind: 'column', table: 'products', created: ['summary'], deleted: ['description'] },
      ]);
      const text = formatStatus(result);
      expect(text).toContain('Changes pending — needs rename resolution');
      expect(text).toContain('products: summary added, description removed');
      expect(text).toContain('--rename products.description=summary');
      expect(text).not.toMatch(/catalog[\s\S]*Schema is up to date[\s\S]*reviews/);
    });

    it('push and generate name the TTY requirement and the answers, and write nothing', async () => {
      await generateInitial();
      const migrationsBefore = fs.readdirSync(path.join(tempDir, 'migrations', 'catalog'));

      for (const run of [
        () => push({ ...ctx(), interactive: false }),
        () => generate(ctx(), { name: 'rename', interactive: false }),
      ]) {
        const error = await run().catch((e) => e);
        expect(error).toBeInstanceOf(SchemaRenameRequiredError);
        expect(error.database).toBe('catalog');
        expect(error.message).toContain('needs rename resolution');
        expect(error.message).toContain('interactive terminal (TTY)');
        expect(error.describe('lagerverk db generate')).toContain(
          'lagerverk db generate --rename products.description=summary'
        );
      }
      expect(fs.readdirSync(path.join(tempDir, 'migrations', 'catalog'))).toEqual(migrationsBefore);
      expect(loadDevMigrations(tempDir, 'catalog').size).toBe(0);
    });

    it('generate --rename writes a RENAME COLUMN migration', async () => {
      await generateInitial();

      const [catalog] = await generate(ctx(), {
        name: 'rename', database: 'catalog', renames: ['products.description=summary'], interactive: false,
      });

      expect(catalog.statements).toEqual(['ALTER TABLE `products` RENAME COLUMN "description" TO "summary";']);
      expect(catalog.warnings).toEqual([]);
      expect((await status(ctx())).databases.every((db) => !db.hasUncommittedChanges)).toBe(true);
    });

    it('push --rename writes the dev migration', async () => {
      await generateInitial();
      const [catalog] = await push({ ...ctx(), database: 'catalog', renames: ['products.description=summary'] });
      expect(catalog.statements).toEqual(['ALTER TABLE `products` RENAME COLUMN "description" TO "summary";']);
    });

    it('generate --no-renames creates and drops, warning about the data loss (and the NOT NULL add)', async () => {
      await generateInitial();

      const error = await generate(ctx(), { name: 'x', noRenames: true, interactive: false }).catch((e) => e);
      expect(error).toBeInstanceOf(UnsafeMigrationError);

      const [catalog] = await generate(ctx(), {
        name: 'x', database: 'catalog', noRenames: true, force: true, interactive: false,
      });
      expect(catalog.statements.join('\n')).toContain('DROP COLUMN `description`');
      expect(catalog.warnings).toContain('products.description is dropped — its data is lost');
    });

    it('a --rename that matches no pending change is an error', async () => {
      await generateInitial();
      await expect(
        generate(ctx(), { renames: ['products.title=name', 'products.description=summary'], interactive: false })
      ).rejects.toThrow('--rename products.title=name matches no pending change');
    });
  });

  describe('NOT NULL without a default (C38)', () => {
    async function addCurrency() {
      writeProject('  name: text().notNull(),');
      await generate(ctx(), { name: 'init', interactive: false });
      writeProject('  name: text().notNull(),\n  currency: text().notNull(),');
    }

    it('generate refuses the migration, writing nothing', async () => {
      await addCurrency();
      const dir = path.join(tempDir, 'migrations', 'catalog');
      const before = fs.readdirSync(dir);

      const error = await generate(ctx(), { name: 'currency', interactive: false }).catch((e) => e);

      expect(error).toBeInstanceOf(UnsafeMigrationError);
      expect(error.message).toContain('catalog: products.currency is added NOT NULL without a default');
      expect(error.message).toContain(
        'fails on every table that has rows: add .default(...) or add it nullable and backfill'
      );
      expect(error.message).toContain('--force');
      expect(fs.readdirSync(dir)).toEqual(before);
    });

    it('generate --force writes it and keeps the warning', async () => {
      await addCurrency();
      const [catalog] = await generate(ctx(), { name: 'currency', database: 'catalog', force: true, interactive: false });
      expect(catalog.statements).toEqual(['ALTER TABLE `products` ADD `currency` text NOT NULL;']);
      expect(catalog.warnings[0]).toContain('products.currency is added NOT NULL without a default');
    });

    it('a default makes it safe', async () => {
      writeProject('  name: text().notNull(),');
      await generate(ctx(), { name: 'init', interactive: false });
      writeProject("  name: text().notNull(),\n  currency: text().notNull().default('SEK'),");

      const [catalog] = await generate(ctx(), { name: 'currency', database: 'catalog', interactive: false });
      expect(catalog.hasChanges).toBe(true);
      expect(catalog.warnings).toEqual([]);
    });

    it('validate warns about it while it is pending (the dev migration replays fine on an empty database)', async () => {
      await addCurrency();
      await push({ ...ctx(), interactive: false });

      const [catalog] = await validate({ ...ctx(), database: 'catalog' });

      expect(catalog.migrationsValid).toBe(true);
      expect(catalog.schemaMatches).toBe(true);
      expect(catalog.pendingWarnings).toEqual([
        expect.stringContaining('not yet generated: products.currency is added NOT NULL without a default'),
      ]);
    });

    it('push warns about it (the dev migration fails on a dev database that has rows)', async () => {
      await addCurrency();
      const [catalog] = await push({ ...ctx(), database: 'catalog', interactive: false });
      expect(catalog.warnings[0]).toContain('products.currency is added NOT NULL without a default');
    });

    it('status lists the warning under the pending SQL', async () => {
      await addCurrency();
      const text = formatStatus(await status({ ...ctx(), database: 'catalog' }));
      expect(text).toContain('products.currency is added NOT NULL without a default');
    });
  });

  describe('a schema the schema module exports whole', () => {
    /** One database, given the const the schema module exports: no table is named in shop.ts. */
    function writeShop(productColumns: string) {
      fs.writeFileSync(path.join(databasesDir, 'schema.ts'), `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const products = sqliteTable('products', {
  id: text().primaryKey(),
${productColumns}
});
export const reviews = sqliteTable('reviews', {
  id: text().primaryKey(),
  productId: text().notNull().references(() => products.id),
  rating: integer(),
});
export const schema = { products, reviews };
`);
      fs.writeFileSync(path.join(databasesDir, 'shop.ts'), `
import { defineDatabase } from 'durable-db/db';
import { schema } from './schema';
export const { action } = defineDatabase({ schema });
`);
    }

    it('generate, status and validate read the tables from the const', async () => {
      writeShop('  name: text().notNull(),');

      const [created] = await generate(ctx(), { name: 'init', interactive: false });
      expect(created.database).toBe('shop');
      expect(created.hasChanges).toBe(true);
      const sql = created.statements.join('\n');
      expect(sql).toContain('CREATE TABLE `products`');
      expect(sql).toContain('CREATE TABLE `reviews`');

      expect((await status(ctx())).databases.map((db) => db.hasUncommittedChanges)).toEqual([false]);
      const [valid] = await validate(ctx());
      expect(valid.migrationsValid).toBe(true);
      expect(valid.schemaMatches).toBe(true);
    });

    it('sees a table change through the const', async () => {
      writeShop('  name: text().notNull(),');
      await generate(ctx(), { name: 'init', interactive: false });

      writeShop('  name: text().notNull(),\n  sku: text(),');

      expect((await status(ctx())).databases[0].hasUncommittedChanges).toBe(true);
      const [drifted] = await validate(ctx());
      expect(drifted.schemaMatches).toBe(false);

      const [added] = await generate(ctx(), { name: 'sku', interactive: false });
      expect(added.statements.join('\n')).toContain('ALTER TABLE `products` ADD `sku` text');
      const [valid] = await validate(ctx());
      expect(valid.schemaMatches).toBe(true);
    });
  });
});
