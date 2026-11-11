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
      writeResults: () => Promise<{ inserted: string; insertId: string; updated: string; deleted: string }>;
      wideMultiRowInsert: (rows: number, cols: number) => Promise<number | string>;
      booleanRoundTrip: () => Promise<{
        storedType: string;
        storedValue: unknown;
        readValue: unknown;
        readType: string;
        falseReadValue: unknown;
      }>;
      legacyStringBooleanRead: () => Promise<{ t: unknown; f: unknown }>;
      jsonAndBlobRoundTrip: () => Promise<{
        stored: Record<string, unknown>[];
        read: Record<string, unknown>[];
        found: string[];
      }>;
      missingColumn: () => Promise<{ select: string; where: string; update: string }>;
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

  it('reports a write\'s affected rows and insert id', async () => {
    expect(await newStub().writeResults()).toEqual({ inserted: '3', insertId: '3', updated: '2', deleted: '1' });
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

  it('stores a JSON-mode column as JSON and binds a blob parameter as bytes', async () => {
    const stub = newStub();
    const result = await stub.jsonAndBlobRoundTrip();
    // JSON as text, or as its UTF-8 bytes in a blob column; a Uint8Array and an ArrayBuffer both as a blob.
    expect(result.stored).toEqual([
      { id: 'buffer', meta: null, meta_data: '{"camel":true}', packed_kind: 'null', packed_json: null, raw_kind: 'blob', raw_hex: '0102FA' },
      {
        id: 'view',
        meta: '{"v":1,"list":["a"]}',
        meta_data: '"text"',
        packed_kind: 'blob',
        packed_json: '{"å":"ö"}',
        raw_kind: 'blob',
        raw_hex: '000102FAFF',
      },
    ]);
    expect(result.read).toEqual([
      { id: 'buffer', meta: null, metaData: { camel: true }, packed: null, rawIsBuffer: true, raw: [1, 2, 250] },
      { id: 'view', meta: { v: 1, list: ['a'] }, metaData: 'text', packed: { å: 'ö' }, rawIsBuffer: true, raw: [0, 1, 2, 250, 255] },
    ]);
    expect(result.found).toEqual(['view']);
  });

  it("reads legacy TEXT 'true'/'false' rows (written by the old driver) as booleans", async () => {
    const stub = newStub();
    const result = await stub.legacyStringBooleanRead();
    expect(result.t).toBe(true);
    expect(result.f).toBe(false);
  });

  it('fails with "no such column" for a column the table lacks, never reading it as a string', async () => {
    // workerd's SQLite reads a double-quoted identifier that names no column
    // as a string literal: `select "weight_grams"` returned 'weight_grams' and
    // a WHERE on it compared two constants. Identifiers are backtick-quoted.
    const result = await newStub().missingColumn();
    expect(result.select).toMatch(/^error: no such column: weight_grams/);
    expect(result.where).toMatch(/^error: no such column: weight_grams/);
    expect(result.update).toMatch(/^error: no such column: weight_grams/);
  });
});
