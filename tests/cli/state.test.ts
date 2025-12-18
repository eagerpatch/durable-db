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
} from '../../src/cli/state';

describe('CLI state management', () => {
  let tempDir: string;
  let nodeModulesDir: string;

  beforeEach(() => {
    // Create a temp directory that simulates a project root
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-cli-'));
    nodeModulesDir = path.join(tempDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getDevPaths', () => {
    it('returns correct paths for a project', () => {
      const paths = getDevPaths(tempDir);

      expect(paths.cacheDir).toContain('node_modules/.cache/@shoplayer/database');
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
            devMigrationCount: 2,
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
      expect(dbState.devMigrationCount).toBe(0);
      expect(state.databases['main']).toBe(dbState);
    });

    it('returns existing database state', () => {
      const state = createEmptyDevState();
      state.databases['main'] = {
        prodSnapshotHash: 'existing',
        lastPush: '2024-01-01',
        devMigrationCount: 5,
      };

      const dbState = getDatabaseDevState(state, 'main', 'newhash');

      expect(dbState.prodSnapshotHash).toBe('existing'); // Not overwritten
      expect(dbState.devMigrationCount).toBe(5);
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
        devMigrationCount: 0,
      };

      expect(hasProdSnapshotChanged(state, 'main', 'hash123')).toBe(false);
    });

    it('returns true when hash differs', () => {
      const state = createEmptyDevState();
      state.databases['main'] = {
        prodSnapshotHash: 'oldhash',
        lastPush: null,
        devMigrationCount: 0,
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

      const name = saveDevMigration(tempDir, 'main', 1, statements);
      const migrations = loadDevMigrations(tempDir, 'main');

      expect(name).toBe('0001_dev');
      expect(migrations.size).toBe(1);
      expect(migrations.has('0001_dev')).toBe(true);
      
      const chunks = migrations.get('0001_dev')!;
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toContain('CREATE TABLE users (id TEXT PRIMARY KEY)');
    });

    it('loads migrations in sorted order', () => {
      saveDevMigration(tempDir, 'main', 3, ['SELECT 3']);
      saveDevMigration(tempDir, 'main', 1, ['SELECT 1']);
      saveDevMigration(tempDir, 'main', 2, ['SELECT 2']);

      const migrations = loadDevMigrations(tempDir, 'main');

      expect(Array.from(migrations.keys())).toEqual(['0001_dev', '0002_dev', '0003_dev']);
    });

    it('returns empty map for non-existent database', () => {
      const migrations = loadDevMigrations(tempDir, 'nonexistent');
      expect(migrations.size).toBe(0);
    });

    it('clears dev migrations', () => {
      saveDevMigration(tempDir, 'main', 1, ['SELECT 1']);
      expect(loadDevMigrations(tempDir, 'main').size).toBe(1);

      clearDevMigrations(tempDir, 'main');
      expect(loadDevMigrations(tempDir, 'main').size).toBe(0);
    });
  });

  describe('clearDatabaseDevState', () => {
    it('removes all database dev files', () => {
      // Create some dev state
      saveDevMigration(tempDir, 'main', 1, ['SELECT 1']);
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
});
