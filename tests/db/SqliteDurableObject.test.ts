import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

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

    // Simulate SELECT DISTINCT name FROM __migrations
    if (/SELECT DISTINCT name FROM __migrations/i.test(sql)) {
      const rows = this.tables.get('__migrations') ?? [];
      const names = Array.from(new Set(rows.map(r => r.name)));
      return new MockSqlCursor(names.map(name => ({ name })));
    }

    // Simulate INSERT INTO __migrations
    if (/INSERT INTO __migrations/i.test(sql)) {
      const rows = this.tables.get('__migrations') ?? [];
      rows.push({ name: params[0], chunk_index: params[1], applied_at: params[2] });
      this.tables.set('__migrations', rows);
      return new MockSqlCursor([]);
    }

    // Simulate plain CREATE TABLE (no IF NOT EXISTS) — throws when the
    // table already exists, like real SQLite
    const createMatch = sql.match(/^CREATE TABLE (?!IF NOT EXISTS)(\S+)/i);
    if (createMatch) {
      const tableName = createMatch[1];
      if (this.tables.has(tableName)) {
        throw new Error(`table \`${tableName}\` already exists at offset 13: SQLITE_ERROR`);
      }
      this.tables.set(tableName, []);
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
  MigrationSchemaConflictError,
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

    it('getMigrationStatus reports empty pending/applied on a fresh DO', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });
      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {};

      const status = await dobj.getMigrationStatus();
      expect(status.pending).toEqual([]);
      expect(status.applied).toEqual([]);
      expect(status.pitrAvailable).toBe(false);
      expect(status.pitrAttemptsRemaining).toBe(0);
      expect(status.attempts.attemptCount).toBe(0);
    });

    it('getMigrationStatus separates pending from applied', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });
      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_initial': { chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']] },
        '20240201_second': { chunks: [['CREATE TABLE posts (id TEXT PRIMARY KEY)']] },
      };

      // Apply only the first migration
      await dobj.fetch(new Request('http://test/'));

      // Now add an additional not-yet-applied migration
      dobj.migrations['20240301_third'] = {
        chunks: [['CREATE TABLE comments (id TEXT PRIMARY KEY)']],
      };

      const status = await dobj.getMigrationStatus();
      expect(status.applied).toEqual(['20240101_initial', '20240201_second']);
      expect(status.pending).toEqual(['20240301_third']);
    });

    it('getMigrationStatus surfaces the reason PITR is unavailable', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: false });
      const dobj = new TestDurableObject(state, {});

      // Trigger PITR check via status call
      const status = await dobj.getMigrationStatus();
      expect(status.pitrAvailable).toBe(false);
      expect(status.pitrUnavailableReason).toBe('PITR not available');
    });

    it('getMigrationStatus reports null reason when PITR is available', async () => {
      const { state } = createMockDurableObjectState({ pitrAvailable: true });
      const dobj = new TestDurableObject(state, {});

      const status = await dobj.getMigrationStatus();
      expect(status.pitrAvailable).toBe(true);
      expect(status.pitrUnavailableReason).toBeNull();
    });

    it('getMigrationStatus reports PITR attempts remaining', async () => {
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: true });

      // Seed attempt counter at 2
      mockSql.exec(
        'CREATE TABLE IF NOT EXISTS __migration_attempts (id TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, last_error TEXT)'
      );
      mockSql.exec(
        "INSERT OR IGNORE INTO __migration_attempts (id, attempt_count) VALUES ('current', 0)"
      );
      const rows = (mockSql as any).tables.get('__migration_attempts');
      rows[0].attempt_count = 2;

      const dobj = new TestDurableObject(state, {});
      const status = await dobj.getMigrationStatus();

      expect(status.pitrAvailable).toBe(true);
      expect(status.attempts.attemptCount).toBe(2);
      // MAX_PITR_ATTEMPTS is 3, so 3 + 1 - 2 = 2 retries remaining
      expect(status.pitrAttemptsRemaining).toBe(2);
    });
  });

  describe('migration error logging', () => {
    it('logs the failing statement and its position within the chunk', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': {
          chunks: [
            [
              'CREATE TABLE ok_one (id TEXT PRIMARY KEY)',
              'INVALID SQL HERE',
              'CREATE TABLE never_reached (id TEXT PRIMARY KEY)',
            ],
          ],
        },
      };

      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow();

      const chunkFailLog = errSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('Migration chunk failed')
      );
      expect(chunkFailLog).toBeDefined();
      expect(chunkFailLog![0]).toContain('20240101_bad[0]');
      expect(chunkFailLog![0]).toContain('stmt 1');
      expect(chunkFailLog![0]).toContain('INVALID SQL HERE');

      errSpy.mockRestore();
    });

    it('logs a success summary after applying migrations', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_a': { chunks: [['CREATE TABLE a (id TEXT PRIMARY KEY)']] },
        '20240201_b': {
          chunks: [
            ['CREATE TABLE b1 (id TEXT PRIMARY KEY)'],
            ['CREATE TABLE b2 (id TEXT PRIMARY KEY)'],
          ],
        },
      };

      await dobj.fetch(new Request('http://test/'));

      const summary = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('Applied')
      );
      expect(summary).toBeDefined();
      // 3 chunks across 2 migrations
      expect(summary![0]).toContain('Applied 3 migration chunk(s)');
      expect(summary![0]).toContain('across 2 migration(s)');
      expect(summary![0]).toContain('20240101_a');
      expect(summary![0]).toContain('20240201_b');
      // PITR was unavailable → should note that
      expect(summary![0]).toContain('PITR unavailable');

      logSpy.mockRestore();
    });

    it('success summary omits the PITR warning when PITR is available', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { state } = createMockDurableObjectState({ pitrAvailable: true });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_a': { chunks: [['CREATE TABLE a (id TEXT PRIMARY KEY)']] },
      };

      await dobj.fetch(new Request('http://test/'));

      const summary = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('Applied')
      );
      expect(summary).toBeDefined();
      expect(summary![0]).not.toContain('PITR unavailable');

      logSpy.mockRestore();
    });

    it('disables PITR without error-level noise when the backend does not implement restore', async () => {
      // Local workerd hands out bookmarks from getCurrentBookmark() but
      // rejects the actual restore. That's not a failure worth shouting
      // about — the backend was never going to support it.
      const { state, abort } = createMockDurableObjectState({ pitrAvailable: true });
      state.storage.onNextSessionRestoreBookmark = vi.fn().mockRejectedValue(
        new Error("This Durable Object's storage back-end does not implement point-in-time recovery.")
      );

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': { chunks: [['INVALID SQL']] },
      };

      // The user should see the SQL syntax error — the real root cause.
      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow(
        /near "INVALID": syntax error/
      );

      // No "PITR restore failed" / "Restoring to pre-migration bookmark"
      // log lines that read like a second failure, and no abort.
      const noisyLog = errSpy.mock.calls.find(
        call => typeof call[0] === 'string' &&
          (call[0].includes('PITR restore failed') || call[0].includes('Restoring to pre-migration bookmark'))
      );
      expect(noisyLog).toBeUndefined();
      expect(abort).not.toHaveBeenCalled();

      // PITR is disabled for this instance from now on, with the reason kept.
      const status = await dobj.getMigrationStatus();
      expect(status.pitrAvailable).toBe(false);
      expect(status.pitrUnavailableReason).toContain('point-in-time recovery');

      errSpy.mockRestore();
    });

    it('propagates the original migration error when PITR restore fails unexpectedly', async () => {
      // A backend that claims PITR support but fails the restore for some
      // other reason — that IS worth an error-level log.
      const { state } = createMockDurableObjectState({ pitrAvailable: true });
      state.storage.onNextSessionRestoreBookmark = vi.fn().mockRejectedValue(
        new Error('network blip during restore')
      );

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': { chunks: [['INVALID SQL']] },
      };

      // The user should see the SQL syntax error — the real root cause —
      // not the PITR restore failure masking it.
      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow(
        /near "INVALID": syntax error/
      );

      // And we should have logged the PITR failure distinctly so operators
      // can still see that PITR itself is broken.
      const pitrLog = errSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('PITR restore failed')
      );
      expect(pitrLog).toBeDefined();
      expect(pitrLog![0]).toContain('network blip during restore');

      errSpy.mockRestore();
    });

    it('re-throws the abort error when abort() throws (production-like)', async () => {
      // In real Cloudflare runtime ctx.abort() throws with the abort reason.
      // We should let that error through — the DO is being torn down on
      // purpose and the caller needs to see the abort, not our fallback.
      const { state } = createMockDurableObjectState({ pitrAvailable: true });
      state.abort = vi.fn().mockImplementation(() => {
        throw new Error('Restoring to pre-migration bookmark');
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': { chunks: [['INVALID SQL']] },
      };

      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow(
        /Restoring to pre-migration bookmark/
      );

      errSpy.mockRestore();
    });

    it('PITR-exhausted log includes pending migration names', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: true });

      // Seed counter at MAX_PITR_ATTEMPTS so the next attempt trips the cap
      mockSql.exec(
        'CREATE TABLE IF NOT EXISTS __migration_attempts (id TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, last_error TEXT)'
      );
      mockSql.exec(
        "INSERT OR IGNORE INTO __migration_attempts (id, attempt_count) VALUES ('current', 0)"
      );
      const rows = (mockSql as any).tables.get('__migration_attempts');
      rows[0].attempt_count = 3;
      rows[0].last_error = 'previous failure';

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': { chunks: [['INVALID SQL']] },
      };

      await expect(dobj.fetch(new Request('http://test/'))).rejects.toThrow();

      const exhaustedLog = errSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('PITR restore disabled')
      );
      expect(exhaustedLog).toBeDefined();
      expect(exhaustedLog![0]).toContain('20240101_bad');
      expect(exhaustedLog![0]).toContain('previous failure');

      errSpy.mockRestore();
    });
  });

  describe('schema/journal conflict detection', () => {
    function seedJournal(mockSql: MockSqlStorage, name: string) {
      mockSql.exec(
        'CREATE TABLE IF NOT EXISTS __migrations (name TEXT NOT NULL, chunk_index INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (name, chunk_index))'
      );
      mockSql.exec(
        'INSERT INTO __migrations (name, chunk_index, applied_at) VALUES (?, ?, ?)',
        name, 0, '2026-01-01T00:00:00.000Z'
      );
    }

    it('explains journal drift when a regenerated migration hits "already exists"', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: false });

      // Storage created under an old migration name: the table exists and
      // the journal records only the old name.
      mockSql.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');
      seedJournal(mockSql, '20250101000000_old_name');

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20260610152524_migration': {
          chunks: [['CREATE TABLE notes (id TEXT PRIMARY KEY)']],
        },
      };

      const err = await dobj.fetch(new Request('http://test/')).then(
        () => null,
        (e) => e
      );

      expect(err).toBeInstanceOf(MigrationSchemaConflictError);
      // Names the failing migration and the untracked journal entries
      expect(err.message).toContain('20260610152524_migration');
      expect(err.message).toContain('20250101000000_old_name');
      expect(err.message).toContain('renamed or regenerated');
      // Actionable recovery for dev and production
      expect(err.message).toContain('db reset');
      expect(err.message).toContain('baseline');
      // Original SQLite error preserved
      expect(err.message).toContain('table `notes` already exists');
      expect(err.cause).toBeInstanceOf(Error);

      errSpy.mockRestore();
    });

    it('gives generic guidance when the journal is empty but the schema exists', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable: false });

      // Table exists but nothing was ever journaled (e.g. a previous attempt
      // crashed partway through a chunk, or storage from an older version).
      mockSql.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20260610152524_migration': {
          chunks: [['CREATE TABLE notes (id TEXT PRIMARY KEY)']],
        },
      };

      const err = await dobj.fetch(new Request('http://test/')).then(
        () => null,
        (e) => e
      );

      expect(err).toBeInstanceOf(MigrationSchemaConflictError);
      expect(err.message).toContain('renamed or regenerated');
      expect(err.message).toContain('db reset');

      errSpy.mockRestore();
    });

    it('does not wrap unrelated migration errors', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { state } = createMockDurableObjectState({ pitrAvailable: false });

      const dobj = new TestDurableObject(state, {});
      dobj.migrations = {
        '20240101_bad': { chunks: [['INVALID SQL']] },
      };

      const err = await dobj.fetch(new Request('http://test/')).then(
        () => null,
        (e) => e
      );

      expect(err).not.toBeInstanceOf(MigrationSchemaConflictError);
      expect(err.message).toContain('near "INVALID": syntax error');

      errSpy.mockRestore();
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

// ============================================================================
// Concurrent first calls (one migration run)
// ============================================================================

describe('concurrent first calls', () => {
  const initial: Migrations = {
    '20240101_initial': {
      chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)'], ['CREATE TABLE posts (id TEXT PRIMARY KEY)']],
    },
  };

  for (const pitrAvailable of [false, true]) {
    it(`share one migration run (PITR ${pitrAvailable ? 'available' : 'unavailable'})`, async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { state, mockSql } = createMockDurableObjectState({ pitrAvailable });
      const dobj = new TestDurableObject(state, {});
      dobj.migrations = initial;

      // runMigrations() awaits the PITR probe/bookmark between reading the
      // pending list and applying it: every call here arrives in that window.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => dobj.fetch(new Request('http://test/')))
      );

      expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
      const creates = mockSql.getExecLog().filter((sql) => /^CREATE TABLE (users|posts)/.test(sql));
      expect(creates).toHaveLength(2);
      expect(state.storage.sql.exec('SELECT name, chunk_index FROM __migrations').toArray()).toHaveLength(2);
      expect(logSpy.mock.calls.filter(([line]) => String(line).includes('Applied'))).toHaveLength(1);
      logSpy.mockRestore();
    });
  }

  it('lets the next call retry after a failed run', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { state } = createMockDurableObjectState({ pitrAvailable: false });
    const dobj = new TestDurableObject(state, {});
    dobj.migrations = { '20240101_bad': { chunks: [['INVALID SQL']] } };

    const both = await Promise.allSettled([
      dobj.fetch(new Request('http://test/')),
      dobj.fetch(new Request('http://test/')),
    ]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    dobj.migrations = { '20240101_good': { chunks: [['CREATE TABLE users (id TEXT PRIMARY KEY)']] } };
    await expect(dobj.fetch(new Request('http://test/'))).resolves.toBeInstanceOf(Response);
    errSpy.mockRestore();
  });

  it('does not let a run in flight during resetMigrationState mark the reset storage migrated', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { state } = createMockDurableObjectState({ pitrAvailable: false });
    const dobj = new TestDurableObject(state, {});
    dobj.migrations = initial;

    const first = dobj.fetch(new Request('http://test/'));
    (dobj as any).resetMigrationState();
    await first;
    expect((dobj as any).migrationsApplied).toBe(false);
    logSpy.mockRestore();
  });
});

// ============================================================================
// Dev → production migration handoff (`db push`, then `db generate`)
// ============================================================================

/**
 * A DurableObjectState over a real in-memory SQLite (node:sqlite), so schema
 * errors ("duplicate column name", "already exists") are SQLite's own.
 */
function createSqliteState() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const sqlite = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const rows = sqlite.prepare(query).all(...(params as never[]));
      return { toArray: () => rows };
    },
  };
  const state = {
    storage: {
      sql,
      getCurrentBookmark: vi.fn().mockRejectedValue(new Error('PITR not available')),
      onNextSessionRestoreBookmark: vi.fn(),
      transactionSync<T>(callback: () => T): T {
        sqlite.exec('BEGIN');
        try {
          const result = callback();
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    },
    id: { toString: () => 'test-id' },
    abort: vi.fn(),
  };
  const journal = () =>
    (sqlite.prepare('SELECT name, chunk_index FROM __migrations ORDER BY name, chunk_index').all() as Array<{
      name: string;
      chunk_index: number;
    }>).map((row) => `${row.name}[${row.chunk_index}]`);
  const columns = (table: string) =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  return { state, sqlite, journal, columns };
}

class CatalogDatabaseDO extends SqliteDurableObject {
  migrations: Migrations = {};
}

describe('dev → production migration handoff', () => {
  const init = {
    '20261104100000_init': {
      chunks: [['CREATE TABLE `products` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n']],
    },
  };

  /** Boot a fresh instance (a dev server restart) over the same storage. */
  async function boot(state: unknown, migrations: Migrations) {
    const dobj = new CatalogDatabaseDO(state, {});
    dobj.migrations = migrations;
    await dobj.fetch(new Request('http://test/'));
    return dobj;
  }

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    };
  });

  it('records the generated migration as applied when the dev migration already applied it', async () => {
    const { state, journal, columns } = createSqliteState();

    // `db push`: the dev server applies the squashed dev migration.
    await boot(state, {
      ...init,
      '_dev_dev_3b7e396f': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });
    expect(columns('products')).toContain('weight_grams');

    // `db generate weight`: the dev migration becomes a production one.
    await boot(state, {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });

    expect(journal()).toEqual([
      '20261104100000_init[0]',
      '20261104111548_weight[0]',
      '_dev_dev_3b7e396f[0]',
    ]);
    expect(logSpy.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
      'Recorded migration 20261104111548_weight as applied without running it: dev migration(s) _dev_dev_3b7e396f'
    );
  });

  it('matches a dev CREATE TABLE IF NOT EXISTS to the generated CREATE TABLE, across chunks', async () => {
    const { state, journal } = createSqliteState();
    await boot(state, {
      ...init,
      '_dev_dev_aaaa1111': {
        chunks: [[
          'CREATE TABLE IF NOT EXISTS `reviews` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n',
          'CREATE INDEX IF NOT EXISTS `reviews_id_idx` ON `reviews` (`id`);',
        ]],
      },
    });

    await boot(state, {
      ...init,
      '20261105000000_reviews': {
        chunks: [
          ['CREATE TABLE `reviews` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n'],
          ['CREATE INDEX `reviews_id_idx` ON `reviews` (`id`);'],
        ],
      },
    });

    expect(journal()).toContain('20261105000000_reviews[0]');
    expect(journal()).toContain('20261105000000_reviews[1]');
  });

  it('still runs a generated migration with statements no dev migration ran — and explains a conflict', async () => {
    const { state, journal } = createSqliteState();
    await boot(state, {
      ...init,
      '_dev_dev_3b7e396f': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });

    const err = await boot(state, {
      ...init,
      '20261104111548_weight': {
        chunks: [[
          'ALTER TABLE `products` ADD `weight_grams` integer;',
          'ALTER TABLE `products` ADD `color` text;',
        ]],
      },
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
    expect(err!.message).toContain('duplicate column name: weight_grams');
    expect(err!.message).toContain('_dev_dev_3b7e396f');
    expect(err!.message).toContain('db reset --database catalog');
    expect(journal()).not.toContain('20261104111548_weight[0]');
  });

  it('lets each dev statement stand in for one production migration only', async () => {
    const { state, journal } = createSqliteState();
    await boot(state, {
      ...init,
      '_dev_dev_3b7e396f': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });
    await boot(state, {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });

    // A later migration with the same statement is not "already applied".
    const err = await boot(state, {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
      '20261106000000_again': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
    expect(journal()).not.toContain('20261106000000_again[0]');
  });

  it('leaves a storage that never ran a dev migration alone', async () => {
    const { state, journal, columns, sqlite } = createSqliteState();
    await boot(state, init);
    await boot(state, {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    });

    expect(columns('products')).toContain('weight_grams');
    expect(journal()).toEqual(['20261104100000_init[0]', '20261104111548_weight[0]']);
    const devTable = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name = '__dev_migration_statements'`)
      .all();
    expect(devTable).toEqual([]);
  });

  it('maps "duplicate column name" to MigrationSchemaConflictError with a db reset hint', async () => {
    const { state, sqlite } = createSqliteState();
    await boot(state, init);
    sqlite.exec('ALTER TABLE `products` ADD `weight_grams` integer');

    const err = await boot(state, {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
    expect(err!.message).toContain('db reset --database catalog');
    expect(err!.message).toContain('duplicate column name');
  });

  it('names the database by its databaseName in the reset hint (the generated DO sets it)', async () => {
    class OrderItemsDatabaseDO extends SqliteDurableObject {
      migrations: Migrations = {};
      protected databaseName = 'orderItems';
    }
    const { state, sqlite } = createSqliteState();
    const dobj = new OrderItemsDatabaseDO(state, {});
    dobj.migrations = init;
    await dobj.fetch(new Request('http://test/'));
    sqlite.exec('ALTER TABLE `products` ADD `weight_grams` integer');

    const again = new OrderItemsDatabaseDO(state, {});
    again.migrations = {
      ...init,
      '20261104111548_weight': { chunks: [['ALTER TABLE `products` ADD `weight_grams` integer;']] },
    };
    const err = await again.fetch(new Request('http://test/')).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
    // Not `order-items`, which is what the class name alone would give.
    expect(err!.message).toContain('db reset --database orderItems');
  });
});

describe('repeated `db push` in dev', () => {
  // `db push` diffs the schema against the PRODUCTION snapshot, so every push
  // until the next `db generate` repeats the earlier pushes' statements.
  const init = {
    '20261104100000_init': {
      chunks: [['CREATE TABLE `products` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n']],
    },
  };
  const addWeight = 'ALTER TABLE `products` ADD `weight_grams` integer;';
  const addColor = 'ALTER TABLE `products` ADD `color_code` text;';
  const addSku = 'ALTER TABLE `products` ADD `sku` text;';

  async function boot(state: unknown, migrations: Migrations) {
    const dobj = new CatalogDatabaseDO(state, {});
    dobj.migrations = migrations;
    await dobj.fetch(new Request('http://test/'));
    return dobj;
  }

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    };
  });

  it('skips what a second push repeats of the first, then hands both off to db generate', async () => {
    const { state, journal, columns } = createSqliteState();

    // Add weightGrams, restart dev: push writes dev_A.
    await boot(state, { ...init, '_dev_dev_aaaa0001': { chunks: [[addWeight]] } });
    // Add colorCode, restart dev: push writes dev_B = dev_A's statement + the new one.
    await boot(state, { ...init, '_dev_dev_bbbb0002': { chunks: [[addWeight, addColor]] } });

    expect(columns('products')).toEqual(['id', 'weight_grams', 'color_code']);
    expect(journal()).toEqual(['20261104100000_init[0]', '_dev_dev_aaaa0001[0]', '_dev_dev_bbbb0002[0]']);
    expect(logSpy.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
      'Dev migration _dev_dev_bbbb0002: skipped the statement(s) dev migration(s) _dev_dev_aaaa0001 already applied'
    );

    // A third push repeats both.
    await boot(state, { ...init, '_dev_dev_cccc0003': { chunks: [[addWeight, addColor, addSku]] } });
    expect(columns('products')).toEqual(['id', 'weight_grams', 'color_code', 'sku']);

    // `db generate`: the production migration holds all three.
    await boot(state, { ...init, '20261105000000_product_fields': { chunks: [[addWeight, addColor, addSku]] } });
    expect(journal()).toContain('20261105000000_product_fields[0]');
    expect(columns('products')).toEqual(['id', 'weight_grams', 'color_code', 'sku']);
  });

  it('skips the repeated statements whatever their order in the new push', async () => {
    const { state, columns } = createSqliteState();
    await boot(state, { ...init, '_dev_dev_aaaa0001': { chunks: [[addWeight]] } });

    // A column added above weightGrams in the table: drizzle-kit lists it first.
    await boot(state, { ...init, '_dev_dev_bbbb0002': { chunks: [[addColor, addWeight]] } });

    expect(columns('products')).toEqual(['id', 'weight_grams', 'color_code']);
  });

  it('runs a statement an earlier push ran only when that push is not repeated whole — and explains the conflict', async () => {
    const { state, journal } = createSqliteState();
    await boot(state, { ...init, '_dev_dev_aaaa0001': { chunks: [[addWeight, addColor]] } });

    // colorCode changed type since: dev_A is not repeated whole.
    const err = await boot(state, {
      ...init,
      '_dev_dev_bbbb0002': { chunks: [[addWeight, 'ALTER TABLE `products` ADD `color_code` integer;']] },
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
    expect(err!.message).toContain('duplicate column name: weight_grams');
    expect(err!.message).toContain('earlier dev migration (_dev_dev_aaaa0001)');
    expect(err!.message).toContain('db reset --database catalog');
    expect(journal()).not.toContain('_dev_dev_bbbb0002[0]');
  });

  it('never skips anything in a production migration', async () => {
    const { state } = createSqliteState();
    await boot(state, { ...init, '_dev_dev_aaaa0001': { chunks: [[addWeight]] } });

    // A production migration that is not dev_A squashed (it has more) still runs whole.
    const err = await boot(state, {
      ...init,
      '20261105000000_fields': { chunks: [[addWeight, addColor]] },
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(MigrationSchemaConflictError);
  });
});
