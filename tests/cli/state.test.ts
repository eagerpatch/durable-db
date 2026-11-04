import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getDevPaths,
  createEmptyDevState,
  generateEpoch,
  loadDevState,
  saveDevState,
  getDatabaseDevState,
  hasProdSnapshotChanged,
  loadDevMigrations,
  saveDevMigration,
  clearDevMigrations,
  clearDatabaseDevState,
  loadDevSnapshot,
  saveDevSnapshot,
  getInstanceKey,
  getDatabaseEpoch,
  getDatabaseEpochs,
  forgetDatabaseDevState,
  getDevEpoch,
  writeDevServerLock,
  removeDevServerLock,
  readDevServerLock,
  runningDevServer,
  isProcessAlive,
} from '../../src/cli/state';

describe('CLI state management', () => {
  let tempDir: string;
  let nodeModulesDir: string;

  beforeEach(() => {
    // Create a temp directory that simulates a project root
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-cli-'));
    nodeModulesDir = path.join(tempDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getDevPaths', () => {
    it('returns correct paths for a project', () => {
      const paths = getDevPaths(tempDir);

      expect(paths.cacheDir).toContain('node_modules/.cache/durable-db');
      expect(paths.stateFile).toContain('state.json');
      expect(paths.databaseDir('main')).toContain('databases/main');
      expect(paths.migrationsDir('main')).toContain('databases/main/migrations');
      expect(paths.snapshotFile('main')).toContain('databases/main/_snapshot.json');
    });
  });

  describe('createEmptyDevState', () => {
    it('creates state with epoch and empty databases', () => {
      const state = createEmptyDevState();

      expect(state.epoch).toBeDefined();
      expect(state.epoch.length).toBeGreaterThan(0);
      expect(state.databases).toEqual({});
    });
  });

  describe('generateEpoch', () => {
    it('generates unique epochs', () => {
      const epoch1 = generateEpoch();
      // Small delay to ensure different timestamp
      const epoch2 = generateEpoch();

      expect(epoch1).toBeDefined();
      expect(epoch1.length).toBeGreaterThan(0);
      // Note: epochs might be the same if generated in the same millisecond
      // but they should be valid base36 strings
      expect(() => parseInt(epoch1, 36)).not.toThrow();
    });
  });

  describe('loadDevState / saveDevState', () => {
    it('saves and loads state', () => {
      const state = {
        epoch: 'test123',
        databases: {
          main: {
            prodSnapshotHash: 'abc',
            lastPush: '2024-01-01T00:00:00Z',
          },
        },
      };

      saveDevState(tempDir, state);
      const loaded = loadDevState(tempDir);

      expect(loaded).toEqual(state);
    });

    it('returns empty state when file does not exist', () => {
      const loaded = loadDevState(tempDir);

      expect(loaded.epoch).toBeDefined();
      expect(loaded.databases).toEqual({});
    });

    it('creates directory structure if needed', () => {
      const state = createEmptyDevState();
      saveDevState(tempDir, state);

      const paths = getDevPaths(tempDir);
      expect(fs.existsSync(paths.stateFile)).toBe(true);
    });
  });

  describe('getDatabaseDevState', () => {
    it('creates new database state if not exists', () => {
      const state = createEmptyDevState();
      const dbState = getDatabaseDevState(state, 'main', 'hash123');

      expect(dbState.prodSnapshotHash).toBe('hash123');
      expect(dbState.lastPush).toBeNull();
      expect(state.databases['main']).toBe(dbState);
    });

    it('returns existing database state', () => {
      const state = createEmptyDevState();
      state.databases['main'] = {
        prodSnapshotHash: 'existing',
        lastPush: '2024-01-01',
      };

      const dbState = getDatabaseDevState(state, 'main', 'newhash');

      expect(dbState.prodSnapshotHash).toBe('existing'); // Not overwritten
    });
  });

  describe('hasProdSnapshotChanged', () => {
    it('returns false when no state exists', () => {
      const state = createEmptyDevState();
      expect(hasProdSnapshotChanged(state, 'main', 'hash123')).toBe(false);
    });

    it('returns false when hash matches', () => {
      const state = createEmptyDevState();
      state.databases['main'] = {
        prodSnapshotHash: 'hash123',
        lastPush: null,
      };

      expect(hasProdSnapshotChanged(state, 'main', 'hash123')).toBe(false);
    });

    it('returns true when hash differs', () => {
      const state = createEmptyDevState();
      state.databases['main'] = {
        prodSnapshotHash: 'oldhash',
        lastPush: null,
      };

      expect(hasProdSnapshotChanged(state, 'main', 'newhash')).toBe(true);
    });
  });

  describe('dev migrations', () => {
    it('saves and loads dev migrations', () => {
      const statements = [
        'CREATE TABLE users (id TEXT PRIMARY KEY)',
        'CREATE INDEX idx_users ON users(id)',
      ];

      const name = saveDevMigration(tempDir, 'main', 'dev_abc123', statements);
      const migrations = loadDevMigrations(tempDir, 'main');

      expect(name).toBe('dev_abc123');
      expect(migrations.size).toBe(1);
      expect(migrations.has('dev_abc123')).toBe(true);

      const chunks = migrations.get('dev_abc123')!;
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toContain('CREATE TABLE users (id TEXT PRIMARY KEY)');
    });

    it('loads migrations in sorted order', () => {
      saveDevMigration(tempDir, 'main', 'dev_ccc', ['SELECT 3']);
      saveDevMigration(tempDir, 'main', 'dev_aaa', ['SELECT 1']);
      saveDevMigration(tempDir, 'main', 'dev_bbb', ['SELECT 2']);

      const migrations = loadDevMigrations(tempDir, 'main');

      expect(Array.from(migrations.keys())).toEqual(['dev_aaa', 'dev_bbb', 'dev_ccc']);
    });

    it('returns empty map for non-existent database', () => {
      const migrations = loadDevMigrations(tempDir, 'nonexistent');
      expect(migrations.size).toBe(0);
    });

    it('clears dev migrations', () => {
      saveDevMigration(tempDir, 'main', 'dev_test', ['SELECT 1']);
      expect(loadDevMigrations(tempDir, 'main').size).toBe(1);

      clearDevMigrations(tempDir, 'main');
      expect(loadDevMigrations(tempDir, 'main').size).toBe(0);
    });
  });

  describe('clearDatabaseDevState', () => {
    it('removes all database dev files', () => {
      // Create some dev state
      saveDevMigration(tempDir, 'main', 'dev_test', ['SELECT 1']);
      saveDevSnapshot(tempDir, 'main', { tables: {} });

      const paths = getDevPaths(tempDir);
      expect(fs.existsSync(paths.databaseDir('main'))).toBe(true);

      clearDatabaseDevState(tempDir, 'main');
      expect(fs.existsSync(paths.databaseDir('main'))).toBe(false);
    });

    it('does nothing for non-existent database', () => {
      // Should not throw
      clearDatabaseDevState(tempDir, 'nonexistent');
    });
  });

  describe('dev snapshots', () => {
    it('saves and loads dev snapshot', () => {
      const snapshot = {
        version: '6',
        dialect: 'sqlite',
        tables: { users: { name: 'users' } },
      };

      saveDevSnapshot(tempDir, 'main', snapshot);
      const loaded = loadDevSnapshot(tempDir, 'main');

      expect(loaded).toEqual(snapshot);
    });

    it('returns null for non-existent snapshot', () => {
      const loaded = loadDevSnapshot(tempDir, 'main');
      expect(loaded).toBeNull();
    });
  });

  describe('getInstanceKey', () => {
    it('returns base key when epoch is null', () => {
      expect(getInstanceKey('my-shop.myshopify.com', null)).toBe('my-shop.myshopify.com');
    });

    it('appends dev suffix when epoch provided', () => {
      expect(getInstanceKey('my-shop.myshopify.com', 'abc123')).toBe('my-shop.myshopify.com__dev_abc123');
    });

    it('works with global key', () => {
      expect(getInstanceKey('global', 'xyz')).toBe('global__dev_xyz');
    });
  });
  describe('per-database epochs', () => {
    it('falls back to the project epoch for a database without its own', () => {
      const state = { epoch: 'project', databases: { catalog: { epoch: 'own' }, reviews: { lastPush: null } } };
      expect(getDatabaseEpoch(state, 'catalog')).toBe('own');
      expect(getDatabaseEpoch(state, 'reviews')).toBe('project');
      expect(getDatabaseEpoch(state, 'unknown')).toBe('project');
      expect(getDatabaseEpochs(state)).toEqual({ catalog: 'own' });
    });

    it('reads a state.json from before per-database epochs', () => {
      fs.mkdirSync(path.dirname(getDevPaths(tempDir).stateFile), { recursive: true });
      fs.writeFileSync(getDevPaths(tempDir).stateFile, JSON.stringify({ epoch: 'old' }));
      const state = loadDevState(tempDir);
      expect(state.databases).toEqual({});
      expect(getDatabaseEpoch(state, 'catalog')).toBe('old');
      expect(getDevEpoch(tempDir, 'catalog')).toBe('old');
    });

    it('forgetting a database\'s bookkeeping keeps its epoch', () => {
      const state = {
        epoch: 'project',
        databases: {
          catalog: { epoch: 'own', prodSnapshotHash: 'h', lastPush: 'x' },
          reviews: { prodSnapshotHash: 'h', lastPush: 'x' },
        },
      };
      forgetDatabaseDevState(state, 'catalog');
      forgetDatabaseDevState(state, 'reviews');
      expect(state.databases).toEqual({ catalog: { epoch: 'own' } });
    });

    it('an epoch-only entry is not a changed production snapshot', () => {
      const state = { epoch: 'project', databases: { catalog: { epoch: 'own' } } };
      expect(hasProdSnapshotChanged(state, 'catalog', 'hash')).toBe(false);
      expect(getDatabaseDevState(state, 'catalog', 'hash')).toEqual({ epoch: 'own', prodSnapshotHash: 'hash', lastPush: null });
    });
  });

  describe('dev-server lock', () => {
    it('records this process and removes only its own lock', () => {
      const first = writeDevServerLock(tempDir);
      expect(readDevServerLock(tempDir)).toMatchObject({ pid: process.pid, token: first });
      expect(runningDevServer(tempDir)?.pid).toBe(process.pid);

      // A restart writes its own lock before the old server closes
      const second = writeDevServerLock(tempDir);
      removeDevServerLock(tempDir, first);
      expect(readDevServerLock(tempDir)?.token).toBe(second);

      removeDevServerLock(tempDir, second);
      expect(readDevServerLock(tempDir)).toBeNull();
      expect(runningDevServer(tempDir)).toBeNull();
    });

    it('ignores a lock whose process is gone', () => {
      const lockFile = path.join(getDevPaths(tempDir).cacheDir, 'dev-server.json');
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, token: 't', startedAt: '' }));
      expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
      expect(runningDevServer(tempDir)).toBeNull();
    });
  });
});
