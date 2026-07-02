import { describe, it, expect } from 'vitest';
import { inlineParameters } from '../../src/db/kysely';

/**
 * Unit tests for the >100-parameter fallback (workerd's
 * SQLITE_MAX_VARIABLE_NUMBER is 100): placeholders are replaced with escaped
 * literals by a scanner that must never touch a `?` inside a string literal,
 * quoted identifier, or comment.
 */
describe('inlineParameters', () => {
  it('inlines primitives with correct escaping', () => {
    expect(inlineParameters('insert into t values (?, ?, ?, ?)', ['a', 1, null, 2n])).toBe(
      "insert into t values ('a', 1, NULL, 2)",
    );
  });

  it("escapes single quotes by doubling ('' — no injection)", () => {
    expect(inlineParameters('select ?', ["O'Brien'; DROP TABLE t;--"])).toBe(
      "select 'O''Brien''; DROP TABLE t;--'",
    );
  });

  it('inlines booleans as 1/0 and undefined as NULL', () => {
    expect(inlineParameters('values (?, ?, ?)', [true, false, undefined])).toBe(
      'values (1, 0, NULL)',
    );
  });

  it('inlines binary values as blob literals', () => {
    expect(inlineParameters('values (?)', [new Uint8Array([0xde, 0xad, 0x01])])).toBe(
      "values (X'dead01')",
    );
  });

  it('leaves ? inside string literals alone', () => {
    expect(inlineParameters("select 'why?' , ?", [7])).toBe("select 'why?' , 7");
  });

  it("leaves ? inside escaped ('') string literals alone", () => {
    expect(inlineParameters("select 'it''s?' , ?", [7])).toBe("select 'it''s?' , 7");
  });

  it('leaves ? inside quoted identifiers alone', () => {
    expect(inlineParameters('select "col?name" from t where x = ?', [1])).toBe(
      'select "col?name" from t where x = 1',
    );
  });

  it('leaves ? inside comments alone', () => {
    expect(inlineParameters('select ? -- why?\n/* huh? */', [3])).toBe(
      'select 3 -- why?\n/* huh? */',
    );
  });

  it('throws on placeholder/parameter count mismatch', () => {
    expect(() => inlineParameters('select ?, ?', [1])).toThrow(/placeholder/i);
    expect(() => inlineParameters('select ?', [1, 2])).toThrow(/mismatch/i);
  });

  it('throws on non-inlinable values instead of corrupting the statement', () => {
    expect(() => inlineParameters('select ?', [Number.NaN])).toThrow(/non-finite/i);
    expect(() => inlineParameters('select ?', ['bad\0string'])).toThrow(/NUL/i);
    expect(() => inlineParameters('select ?', [{} as never])).toThrow(/type object/i);
  });
});
