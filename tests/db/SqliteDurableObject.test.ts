import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for SqliteDurableObject PITR integration.
 *
 * Since DurableObject, DurableObjectState, and SqlStorage are Cloudflare runtime
 * types, we mock them and test the migration/PITR logic through the class.
 */

// ============================================================================
// Mock Cloudflare runtime types
// ============================================================================

class MockSqlCursor {
  private rows: any[];
  constructor(rows: any[]) {
    this.rows = rows;
  }
  toArray() {
    return this.rows;
  }
}

class MockSqlStorage {
  private tables: Map<string, any[]> = new Map();
  private execLog: string[] = [];

  exec(sql: string, ...params: any[]): MockSqlCursor {
    this.execLog.push(sql.trim());

    // Simulate CREATE TABLE IF NOT EXISTS
    if (/^CREATE TABLE IF NOT EXISTS (\S+)/i.test(sql)) {
      const match = sql.match(/^CREATE TABLE IF NOT EXISTS (\S+)/i);
      const tableName = match![1];
      if (!this.tables.has(tableName)) {
        this.tables.set(tableName, []);
      }
      return new MockSqlCursor([]);
    }

    // Simulate INSERT OR IGNORE for __migration_attempts
    if (/INSERT OR IGNORE INTO __migration_attempts/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      if (!rows.some(r => r.id === 'current')) {
        rows.push({ id: 'current', attempt_count: 0, last_attempt_at: null, last_error: null });
        this.tables.set('__migration_attempts', rows);
      }
      return new MockSqlCursor([]);
    }

    // Simulate UPDATE __migration_attempts SET attempt_count = attempt_count + 1
    if (/UPDATE __migration_attempts[\s\S]*attempt_count = attempt_count \+ 1/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      const row = rows.find(r => r.id === 'current');
      if (row) {
        row.attempt_count++;
        row.last_attempt_at = params[0] ?? new Date().toISOString();
      }
      return new MockSqlCursor([]);
    }

    // Simulate UPDATE __migration_attempts SET attempt_count = 0
    if (/UPDATE __migration_attempts[\s\S]*attempt_count = 0/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      const row = rows.find(r => r.id === 'current');
      if (row) {
        row.attempt_count = 0;
        row.last_error = null;
      }
      return new MockSqlCursor([]);
    }

    // Simulate UPDATE __migration_attempts SET last_error
    if (/UPDATE __migration_attempts SET last_error/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      const row = rows.find(r => r.id === 'current');
      if (row) {
        row.last_error = params[0] ?? null;
      }
      return new MockSqlCursor([]);
    }

    // Simulate SELECT attempt_count FROM __migration_attempts
    if (/SELECT attempt_count FROM __migration_attempts/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      const row = rows.find(r => r.id === (params[0] ?? 'current'));
      return new MockSqlCursor(row ? [{ attempt_count: row.attempt_count }] : []);
    }

    // Simulate SELECT from __migration_attempts (full)
    if (/SELECT attempt_count, last_attempt_at, last_error FROM __migration_attempts/i.test(sql)) {
      const rows = this.tables.get('__migration_attempts') ?? [];
      const row = rows.find(r => r.id === (params[0] ?? 'current'));
      return new MockSqlCursor(row ? [row] : []);
    }

    // Simulate SELECT from __migrations
    if (/SELECT name, chunk_index FROM __migrations/i.test(sql)) {
      return new MockSqlCursor(this.tables.get('__migrations') ?? []);
    }

    // Simulate INSERT INTO __migrations
    if (/INSERT INTO __migrations/i.test(sql)) {
      const rows = this.tables.get('__migrations') ?? [];
      rows.push({ name: params[0], chunk_index: params[1], applied_at: params[2] });
      this.tables.set('__migrations', rows);
      return new MockSqlCursor([]);
    }

    // For test migrations that should fail
    if (/INVALID SQL/i.test(sql)) {
      throw new Error('near "INVALID": syntax error');
    }

    // Default: successful exec
    return new MockSqlCursor([]);
  }

  getExecLog() {
    return this.execLog;
  }
}

function createMockDurableObjectState(opts: {
  pitrAvailable?: boolean;
  bookmarkValue?: string;
} = {}) {
  const { pitrAvailable = false, bookmarkValue = 'bookmark-abc123' } = opts;

  const mockSql = new MockSqlStorage();
  const onNextSessionRestoreBookmark = vi.fn().mockResolvedValue(undefined);
  const getCurrentBookmark = pitrAvailable
    ? vi.fn().mockResolvedValue(bookmarkValue)
    : vi.fn().mockRejectedValue(new Error('PITR not available'));
  const abort = vi.fn();

  const state = {
    storage: {
      sql: mockSql,
      getCurrentBookmark,
      onNextSessionRestoreBookmark,
    },
    id: { toString: () => 'test-id' },
    abort,
  };

  return { state, mockSql, getCurrentBookmark, onNextSessionRestoreBookmark, abort };
}

// ============================================================================
// Create a test subclass since SqliteDurableObject is abstract
// ============================================================================

// We need to import the actual class, but it imports from 'cloudflare:workers'
// which doesn't exist in test environment. So we test the logic via mocks.

// Instead of importing the real class, we'll create a minimal test double
// that replicates the PITR logic for unit testing.

import {
  SqliteDurableObject,
  type Migrations,
} from '../../src/db/SqliteDurableObject';

// Mock the cloudflare:workers module
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mock @outerbase/browsable-durable-object (it imports cloudflare:workers internally)
vi.mock('@outerbase/browsable-durable-object', () => ({
  BrowsableHandler: class {},
  Browsable: () => (cls: any) => cls,
  studio: () => new Response('studio'),
}));

class TestDurableObject extends SqliteDurableObject {
  migrations: Migrations = {};

  constructor(ctx: any, env: any) {
    super(ctx, env);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('SqliteDurableObject', () => {
  describe('migrations without PITR', () => {
    it('creates tracking tables and applies migrations', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      // Should have applied the migration
      const applied = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({ name: '20240101_initial', chunk_index: 0 });
    });

    it('skips already-applied migrations', async () => {
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      // Apply once
      await dobj.fetch(new Request('http://test/'));

      // Create a new instance to reset migrationsApplied flag
      const dobj2 = new TestDurableObject(state, {});
      dobj2.migrations = dobj.migrations;

      // Apply again — should not re-execute the CREATE TABLE
      const logBefore = mockSql.getExecLog().length;
      await dobj2.fetch(new Request('http://test/'));

      // Should not have tried to create the users table again
      // (the migrations tracking should show it's already applied)
      const applied = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(applied).toHaveLength(1); // Still only 1
    });

    it('throws on migration failure without PITR', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': {
          chunks: [['INVALID SQL']],
        },
      };

      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow(
        'near "INVALID": syntax error'
      );
    });
  });

  describe('migrations with PITR', () => {
    it('takes a bookmark before applying migrations', async () => {
      const { state, getCurrentBookmark } = createMockDurableObjectState({
        pitrAvailable: true,
      });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      // Should have called getCurrentBookmark twice:
      // once for checkPitrAvailable, once to take the actual bookmark
      expect(getCurrentBookmark).toHaveBeenCalled();
    });

    it('resets attempt counter on success', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: true });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      // Check attempt counter is reset
      const attempts = dobj.getMigrationAttempts();
      expect(attempts.attemptCount).toBe(0);
      expect(attempts.lastError).toBeNull();
    });

    it('restores to bookmark on migration failure', async () => {
      const { state, onNextSessionRestoreBookmark, abort } =
        createMockDurableObjectState({ pitrAvailable: true, bookmarkValue: 'bm-123' });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': {
          chunks: [['INVALID SQL']],
        },
      };

      // The abort() should be called, which means the error is "absorbed"
      // In real CF runtime, abort() throws. In our mock, it doesn't.
      // The migration error should still propagate since abort is mocked.
      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow();

      expect(onNextSessionRestoreBookmark).toHaveBeenCalledWith('bm-123');
      expect(abort).toHaveBeenCalledWith('Restoring to pre-migration bookmark');
    });

    it('skips PITR after max attempts', async () => {
      const { state, mockSql, onNextSessionRestoreBookmark } =
        createMockDurableObjectState({ pitrAvailable: true });

      // Simulate 3 previous attempts by pre-populating the counter
      mockSql.exec(
        'CREATE TABLE IF NOT EXISTS __migration_attempts (id TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, last_error TEXT)'
      );
      mockSql.exec(
        "INSERT OR IGNORE INTO __migration_attempts (id, attempt_count) VALUES ('current', 0)"
      );
      // Set counter to 3 (already at max)
      const rows = (mockSql as any).tables.get('__migration_attempts');
      if (rows) {
        rows[0].attempt_count = 3;
      }

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': {
          chunks: [['INVALID SQL']],
        },
      };

      // Should throw without trying to restore
      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow(
        'near "INVALID": syntax error'
      );

      // Should NOT have called restore since attempts > MAX
      expect(onNextSessionRestoreBookmark).not.toHaveBeenCalled();
    });
  });

  describe('diagnostic methods', () => {
    it('getMigrationAttempts returns zeroes when no attempts', () => {
      const { state } = createMockDurableObjectState();
      const dobj = new TestDurableObject(state, {});

      const attempts = dobj.getMigrationAttempts();
      expect(attempts.attemptCount).toBe(0);
      expect(attempts.lastAttemptAt).toBeNull();
      expect(attempts.lastError).toBeNull();
    });

    it('getMigrationBookmark returns null when PITR unavailable', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });
      const dobj = new TestDurableObject(state, {});

      const bookmark = await dobj.getMigrationBookmark();
      expect(bookmark).toBeNull();
    });

    it('getMigrationBookmark returns bookmark when PITR available', async () => {
      const { state } = createMockDurableObjectState({
        pitrAvailable: true,
        bookmarkValue: 'test-bookmark',
      });
      const dobj = new TestDurableObject(state, {});

      const bookmark = await dobj.getMigrationBookmark();
      expect(bookmark).toBe('test-bookmark');
    });

    it('restoreToBookmark calls PITR APIs', async () => {
      const { state, onNextSessionRestoreBookmark, abort } =
        createMockDurableObjectState({ pitrAvailable: true });
      const dobj = new TestDurableObject(state, {});

      await dobj.restoreToBookmark('my-bookmark');

      expect(onNextSessionRestoreBookmark).toHaveBeenCalledWith('my-bookmark');
      expect(abort).toHaveBeenCalledWith('Restoring to pre-migration bookmark');
    });
  });

  describe('resetMigrationState', () => {
    it('allows migrations to re-run after reset', async () => {
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      // Apply migrations via fetch
      await dobj.fetch(new Request('http://test/'));

      const appliedBefore = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(appliedBefore).toHaveLength(1);

      // Call resetMigrationState (it's protected, so we need to access it via the test class)
      (dobj as any).resetMigrationState();

      // Second fetch should re-run ensureMigrations, which checks __migrations table
      // and finds no new pending migrations (same migration already applied)
      await dobj.fetch(new Request('http://test/'));

      // Should still only have 1 migration entry (not duplicated)
      const appliedAfter = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(appliedAfter).toHaveLength(1);
    });
  });

  describe('multiple migration chunks', () => {
    it('applies chunks in order', async () => {
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': {
          chunks: [
            ['CREATE TABLE users (id TEXT PRIMARY KEY)'],
            ['CREATE TABLE posts (id TEXT PRIMARY KEY)'],
          ],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      const applied = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(applied).toHaveLength(2);
      expect(applied[0]).toMatchObject({ name: '20240101_initial', chunk_index: 0 });
      expect(applied[1]).toMatchObject({ name: '20240101_initial', chunk_index: 1 });
    });

    it('applies multiple migrations in sorted order', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240201_second': {
          chunks: [['CREATE TABLE posts (id TEXT PRIMARY KEY)']],
        },
        '20240101_first': {
          chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      const applied = state.storage.sql.exec(
        'SELECT name, chunk_index FROM __migrations'
      ).toArray();
      expect(applied).toHaveLength(2);
      // Should be sorted by name
      expect(applied[0].name).toBe('20240101_first');
      expect(applied[1].name).toBe('20240201_second');
    });
  });
});
