import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * End-to-end smoke tests that run a real Durable Object against workerd.
 *
 * The unit tests under tests/db/ mock cloudflare:workers and MockSqlStorage,
 * so they verify the shape of our logic but can drift from what actually
 * happens in production. This suite keeps us honest about:
 *   - Our code compiles and boots under the real workerd runtime (imports,
 *     drizzle-orm, kysely, etc. all work).
 *   - Migration failure paths propagate errors correctly from the DO.
 *   - getMigrationStatus() behaves identically to our mocked version.
 *
 * Note: direct console capture across the DO isolate boundary is not
 * reliable with this pool version, so we assert on the observable state
 * (propagated error, status accessor output) rather than stdout format.
 * The unit suite (tests/db/SqliteDurableObject.test.ts) covers log text.
 */

interface TestEnv {
  TEST_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub & {
      getMigrationStatus: () => Promise<{
        applied: string[];
        pending: string[];
        pitrAvailable: boolean;
        pitrUnavailableReason: string | null;
        attempts: { attemptCount: number; lastError: string | null };
      }>;
      getMigrationAttempts: () => {
        attemptCount: number;
        lastAttemptAt: string | null;
        lastError: string | null;
      };
    };
  };
}

const testEnv = env as unknown as TestEnv;

function newStub() {
  const id = testEnv.TEST_DO.idFromName(`t-${crypto.randomUUID()}`);
  return testEnv.TEST_DO.get(id);
}

describe('migration E2E (real workerd)', () => {
  it('propagates the underlying SQL error, not a PITR-layer error', async () => {
    const stub = newStub();

    let caught: Error | null = null;
    try {
      await stub.fetch(new Request('http://test/'));
    } catch (e) {
      caught = e as Error;
    }

    expect(caught, 'expected fetch to reject').not.toBeNull();
    // workerd's local storage accepts getCurrentBookmark() but rejects the
    // actual onNextSessionRestoreBookmark call — the exact scenario where
    // our PITR fallback should surface the SQL error instead of the PITR
    // complaint. This asserts that our runMigrations catch block is
    // unwrapping correctly in a real runtime.
    expect(caught!.message).toMatch(/syntax error|NOT VALID|INVALID/i);
  });

  it('disables PITR for the instance after workerd rejects the restore call', async () => {
    const stub = newStub();

    // The failed migration triggers a restore attempt; workerd's local
    // storage rejects it with "does not implement point-in-time recovery".
    // That should downgrade the instance to PITR-off (with the reason kept)
    // instead of logging an error-level "PITR restore failed" every run.
    await stub.fetch(new Request('http://test/')).catch(() => null);

    const status = await stub.getMigrationStatus();
    expect(status.pitrAvailable).toBe(false);
    expect(status.pitrUnavailableReason).toMatch(/point-in-time recovery/i);
  });

  it('getMigrationStatus reports applied vs pending against a real DO', async () => {
    const stub = newStub();

    // Trigger migrations; the bad one will fail but the happy one should
    // apply (possibly rolled back via PITR if workerd supports it).
    await stub.fetch(new Request('http://test/')).catch(() => null);

    const status = await stub.getMigrationStatus();

    // Pending list should contain the broken migration regardless of PITR.
    expect(status.pending).toContain('20240201_bad');

    // Applied list behavior depends on PITR: without PITR the good migration
    // is retained; with PITR the whole batch is rolled back. Either way,
    // the shape is consistent.
    expect(Array.isArray(status.applied)).toBe(true);

    // When PITR is unavailable, reason should be a string.
    if (!status.pitrAvailable) {
      expect(typeof status.pitrUnavailableReason).toBe('string');
    } else {
      expect(status.pitrUnavailableReason).toBeNull();
    }

    // Some attempt should have been recorded with an error referencing SQL.
    expect(status.attempts.lastError).toMatch(/syntax error|NOT VALID|INVALID/i);
  });
});

describe('chunk atomicity (real workerd)', () => {
  // Regression for "poisoned storage": a chunk that fails (or a process
  // killed mid-chunk) must not leave part of its schema behind with no
  // journal row — that state throws MigrationSchemaConflictError on every
  // subsequent boot, and local dev has no PITR to undo it. Each chunk now
  // commits atomically with its journal row via storage.transactionSync.
  it('rolls back a failed chunk completely (no partial schema)', async () => {
    const stub = newStub() as DurableObjectStub & { listTables: () => Promise<string[]> };
    const tables = await stub.listTables();
    // 20240101_ok applied; 20240201_bad's CREATE TABLE must have rolled back
    // together with the statement that failed after it.
    expect(tables).toContain('test_ok');
    expect(tables).not.toContain('test_bad_pre');
  });
});
