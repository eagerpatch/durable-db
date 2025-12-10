import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createEmptySnapshot,
  snapshotsEqual,
  hashSnapshot,
  loadMigrationFiles,
  generateMigrationName,
  loadSnapshot,
  saveSnapshot,
  type Snapshot,
} from '../index';

describe('migrations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-migrations-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createEmptySnapshot', () => {
    it('creates a valid empty snapshot', () => {
      const snapshot = createEmptySnapshot();

      expect(snapshot.version).toBe('6');
      expect(snapshot.dialect).toBe('sqlite');
      expect(snapshot.tables).toEqual({});
      expect(snapshot.enums).toEqual({});
    });
  });

  describe('snapshotsEqual', () => {
    it('returns true for identical snapshots', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();

      expect(snapshotsEqual(a, b)).toBe(true);
    });

    it('returns false when tables differ', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.tables = { users: { name: 'users' } } as any;

      expect(snapshotsEqual(a, b)).toBe(false);
    });
  });

  describe('hashSnapshot', () => {
    it('returns consistent hash for same snapshot', () => {
      const snapshot = createEmptySnapshot();

      expect(hashSnapshot(snapshot)).toBe(hashSnapshot(snapshot));
    });

    it('returns different hash for different snapshots', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.tables = { users: { name: 'users' } } as any;

      expect(hashSnapshot(a)).not.toBe(hashSnapshot(b));
    });
  });

  describe('generateMigrationName', () => {
    it('generates a timestamp-based name', () => {
      const name = generateMigrationName();

      // Should be 14 characters (YYYYMMDDHHmmss)
      expect(name).toMatch(/^\d{14}$/);
    });

    it('includes suffix when provided', () => {
      const name = generateMigrationName('initial');

      expect(name).toMatch(/^\d{14}_initial$/);
    });
  });

  describe('loadSnapshot / saveSnapshot', () => {
    it('saves and loads a snapshot', () => {
      const snapshot = {
        version: '6',
        dialect: 'sqlite',
        id: 'test123',
        prevId: '',
        tables: { users: { name: 'users' } },
        enums: {},
        _meta: { tables: {}, columns: {} },
      } as unknown as Snapshot;

      saveSnapshot(tempDir, snapshot);
      const loaded = loadSnapshot(tempDir);

      expect(loaded).toEqual(snapshot);
    });

    it('returns empty snapshot when file does not exist', () => {
      const loaded = loadSnapshot(tempDir);

      expect(loaded.tables).toEqual({});
    });

    it('creates directory if it does not exist', () => {
      const nestedDir = path.join(tempDir, 'nested', 'dir');
      const snapshot = createEmptySnapshot();

      saveSnapshot(nestedDir, snapshot);

      expect(fs.existsSync(path.join(nestedDir, '_snapshot.json'))).toBe(true);
    });
  });

  describe('loadMigrationFiles', () => {
    it('loads SQL files sorted by name', () => {
      fs.writeFileSync(
        path.join(tempDir, '002_second.sql'),
        'CREATE TABLE posts (id TEXT);'
      );
      fs.writeFileSync(
        path.join(tempDir, '001_first.sql'),
        'CREATE TABLE users (id TEXT);\nCREATE INDEX idx_users ON users(id);'
      );

      const migrations = loadMigrationFiles(tempDir);

      expect(Array.from(migrations.keys())).toEqual(['001_first', '002_second']);
      expect(migrations.get('001_first')).toEqual([
        'CREATE TABLE users (id TEXT)',
        'CREATE INDEX idx_users ON users(id)',
      ]);
      expect(migrations.get('002_second')).toEqual([
        'CREATE TABLE posts (id TEXT)',
      ]);
    });

    it('ignores comment lines', () => {
      fs.writeFileSync(
        path.join(tempDir, '001_test.sql'),
        '-- This is a comment\n\nCREATE TABLE users (id TEXT);'
      );

      const migrations = loadMigrationFiles(tempDir);

      expect(migrations.get('001_test')).toEqual([
        'CREATE TABLE users (id TEXT)',
      ]);
    });

    it('returns empty map for non-existent directory', () => {
      const migrations = loadMigrationFiles('/nonexistent/dir');

      expect(migrations.size).toBe(0);
    });
  });
});
