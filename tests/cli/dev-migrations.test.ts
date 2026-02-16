import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDevPaths, saveDevMigration, loadDevMigrations } from '../../src/cli/state';

describe('dev migrations integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-dev-mig-'));
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('dev migration naming', () => {
    it('uses the provided name directly', () => {
      const name1 = saveDevMigration(tempDir, 'main', 'dev_abc123', ['SELECT 1']);
      const name2 = saveDevMigration(tempDir, 'main', 'dev_def456', ['SELECT 2']);

      expect(name1).toBe('dev_abc123');
      expect(name2).toBe('dev_def456');
    });

    it('dev migrations sort after any prod migration timestamp', () => {
      // Prod migrations typically have timestamps like 20241217143000
      // Dev migrations have content-hash names like dev_abc123
      // When prefixed with _dev_, they become _dev_dev_abc123
      // This ensures they sort AFTER prod migrations in the combined map

      const prodMigrations = [
        '20241217143000_initial',
        '20241218093000_add_users',
      ];

      saveDevMigration(tempDir, 'main', 'dev_abc123', ['SELECT 1']);
      saveDevMigration(tempDir, 'main', 'dev_def456', ['SELECT 2']);

      const devMigrations = loadDevMigrations(tempDir, 'main');

      // Simulate merging like the Vite plugin does
      const allMigrations = new Map<string, string[][]>();

      // Add prod migrations (simulated)
      for (const name of prodMigrations) {
        allMigrations.set(name, [['-- prod migration']]);
      }

      // Add dev migrations with prefix
      for (const [name, chunks] of devMigrations) {
        allMigrations.set(`_dev_${name}`, chunks);
      }

      // Verify sort order
      const sortedNames = Array.from(allMigrations.keys()).sort();

      expect(sortedNames).toEqual([
        '20241217143000_initial',
        '20241218093000_add_users',
        '_dev_dev_abc123',
        '_dev_dev_def456',
      ]);
    });
  });

  describe('dev migration isolation', () => {
    it('keeps dev migrations separate per database', () => {
      saveDevMigration(tempDir, 'db1', 'dev_aaa', ['SELECT 1']);
      saveDevMigration(tempDir, 'db2', 'dev_bbb', ['SELECT 2']);
      saveDevMigration(tempDir, 'db2', 'dev_ccc', ['SELECT 3']);

      const db1Migrations = loadDevMigrations(tempDir, 'db1');
      const db2Migrations = loadDevMigrations(tempDir, 'db2');

      expect(db1Migrations.size).toBe(1);
      expect(db2Migrations.size).toBe(2);

      // Verify correct content
      expect(db1Migrations.get('dev_aaa')![0]).toContain('SELECT 1');
      expect(db2Migrations.get('dev_bbb')![0]).toContain('SELECT 2');
      expect(db2Migrations.get('dev_ccc')![0]).toContain('SELECT 3');
    });
  });

  describe('dev paths', () => {
    it('creates correct cache structure', () => {
      const paths = getDevPaths(tempDir);

      // Save some dev state to create the directory structure
      saveDevMigration(tempDir, 'main', 'dev_test', ['SELECT 1']);

      expect(fs.existsSync(paths.migrationsDir('main'))).toBe(true);
      expect(paths.cacheDir).toContain('.cache/@shoplayer/database');
      expect(paths.migrationsDir('main')).toContain('databases/main/migrations');
    });
  });
});
