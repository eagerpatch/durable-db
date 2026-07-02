import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * Kysely write/read E2E against a REAL workerd SqlStorage — the exact path an
 * app's defineDatabase() actions take in production.
 *
 * Regression suite for two bugs found in the field (ShopLayer "advent" app,
 * 2026-07-02), both invisible to the node:sqlite/libsql unit suites:
 *
 *  1. Multi-row `.values([...])` inserts silently persisting nothing.
 *  2. Boolean-mode columns: workerd's SqlStorage has no boolean binding type,
 *     so an unnormalized `true` was stored as TEXT 'true' — which then failed
 *     downstream `'boolean'` arktype checks and made `false` truthy.
 */

interface TestEnv {
  TEST_KYSELY_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub & {
      multiRowInsert: (count: number) => Promise<number>;
      wideMultiRowInsert: (rows: number, cols: number) => Promise<number | string>;
      booleanRoundTrip: () => Promise<{
        storedType: string;
        storedValue: unknown;
        readValue: unknown;
        readType: string;
        falseReadValue: unknown;
      }>;
      legacyStringBooleanRead: () => Promise<{ t: unknown; f: unknown }>;
    };
  };
}

const testEnv = env as unknown as TestEnv;

function newStub() {
  const id = testEnv.TEST_KYSELY_DO.idFromName(`k-${crypto.randomUUID()}`);
  return testEnv.TEST_KYSELY_DO.get(id);
}

describe('Kysely E2E (real workerd SqlStorage)', () => {
  it('persists every row of a multi-row .values([...]) insert', async () => {
    const stub = newStub();
    expect(await stub.multiRowInsert(24)).toBe(24);
  });

  it('survives workerd\'s 100-bound-parameter limit (params are inlined)', async () => {
    // 24×7 = 168 params — the exact shape that threw "too many SQL variables"
    // in the field. 150×7 = 1050 params for good measure.
    expect(await newStub().wideMultiRowInsert(24, 7)).toBe(24);
    expect(await newStub().wideMultiRowInsert(150, 7)).toBe(150);
  });

  it('keeps binding normally under the parameter limit', async () => {
    expect(await newStub().wideMultiRowInsert(10, 10)).toBe(10);
  });

  it('stores booleans as INTEGER 1/0 and reads them back as booleans', async () => {
    const stub = newStub();
    const result = await stub.booleanRoundTrip();
    expect(result.storedType).toBe('integer');
    expect(result.storedValue).toBe(1);
    expect(result.readValue).toBe(true);
    expect(result.readType).toBe('boolean');
    expect(result.falseReadValue).toBe(false);
  });

  it("reads legacy TEXT 'true'/'false' rows (written by the old driver) as booleans", async () => {
    const stub = newStub();
    const result = await stub.legacyStringBooleanRead();
    expect(result.t).toBe(true);
    expect(result.f).toBe(false);
  });
});
