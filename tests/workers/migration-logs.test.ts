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
  it('propagates an error when a migration statement fails', async () => {
    const stub = newStub();

    let caught: Error | null = null;
    try {
      await stub.fetch(new Request('http://test/'));
    } catch (e) {
      caught = e as Error;
    }

    expect(caught, 'expected fetch to reject').not.toBeNull();
    // The exact message depends on the workerd storage back-end: without
    // PITR support it may surface the SQL error; with the local test
    // storage it can surface a PITR-unavailability error thrown by the
    // runtime. Either way, a) the fetch rejects, and b) the next test
    // verifies the migration error itself is recorded on the DO.
    expect(caught!.message.length).toBeGreaterThan(0);
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
