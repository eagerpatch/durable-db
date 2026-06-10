import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { push, pushOne } from '../../src/cli/push';
import { generate, generateOne } from '../../src/cli/generate';
import { reset, resetAndPush } from '../../src/cli/reset';
import { status, formatStatus } from '../../src/cli/status';
import { loadDevState, getDevPaths, loadDevMigrations } from '../../src/cli/state';
import { loadMigrationFiles, loadSnapshot } from '../../src/migrations/generator';

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
import { defineDatabase } from '@eagerpatch/durable-db/db';
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
import { defineDatabase } from '@eagerpatch/durable-db/db';
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
import { defineDatabase } from '@eagerpatch/durable-db/db';

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
import { defineDatabase } from '@eagerpatch/durable-db/db';
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
import { defineDatabase } from '@eagerpatch/durable-db/db';
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
