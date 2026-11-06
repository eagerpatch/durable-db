import { describe, expect, expectTypeOf, it } from 'vitest';
import { type, ArkErrors } from '../../src/type';

// The types are ArkType's own (`type.validate` / `type.infer`); these hold
// when `tsc -p tests/type/tsconfig.json` passes, and the runtime half here.

describe('durable-db/type: inferred types', () => {
  it('infers an object as ArkType does', () => {
    const User = type({ name: 'string', 'age?': 'number.integer >= 0', tags: 'string[]', role: "'admin' | 'member'" });
    expectTypeOf<typeof User.infer>().toEqualTypeOf<{ name: string; age?: number; tags: string[]; role: 'admin' | 'member' }>();
    expect(User({ name: 'a', tags: [], role: 'admin' })).toEqual({ name: 'a', tags: [], role: 'admin' });
  });

  it('nests its own Types in definitions, arrays and unions', () => {
    const Line = type({ qty: 'number.integer > 0', price: 'number' });
    const Invoice = type({ customer: 'string', lines: Line.array(), 'note?': type('string').or('null') });
    expectTypeOf<typeof Invoice.infer>().toEqualTypeOf<{ customer: string; lines: { qty: number; price: number }[]; note?: string | null }>();
  });

  it('types defaults and morphs on both sides', () => {
    const Query = type({ page: 'string.integer.parse', size: type('number').default(20) });
    expectTypeOf<typeof Query.inferIn>().toEqualTypeOf<{ page: string; size?: number }>();
    expectTypeOf<typeof Query.infer>().toEqualTypeOf<{ page: number; size: number }>();
    expect(Query({ page: '2' })).toEqual({ page: 2, size: 20 });
  });

  it('narrows a result to its errors', () => {
    const out = type('string')(1);
    if (out instanceof type.errors) {
      expectTypeOf(out).toEqualTypeOf<ArkErrors>();
      expect(out.summary).toBe('must be a string (was a number)');
    } else {
      expectTypeOf(out).toEqualTypeOf<string>();
    }
  });

  it('refuses a definition ArkType refuses, at compile time', () => {
    // @ts-expect-error — not a keyword
    expect(() => type({ name: 'strng' })).toThrow("'strng' is unresolvable");
    // @ts-expect-error — a bound needs a number on its other side
    expect(() => type('string > x')).toThrow();
  });

  it('is a Standard Schema, typed', () => {
    const T = type({ n: 'string.numeric.parse' });
    expectTypeOf<NonNullable<(typeof T)['~standard']['types']>['input']>().toEqualTypeOf<{ n: string }>();
    expectTypeOf<NonNullable<(typeof T)['~standard']['types']>['output']>().toEqualTypeOf<{ n: number }>();
    expect(T['~standard'].validate({ n: '1.5' })).toEqual({ value: { n: 1.5 } });
    const failed = T['~standard'].validate({ n: 'x' });
    expect('issues' in failed && failed.issues?.map((i) => [i.message, i.path])).toEqual([['n must be a well-formed numeric string (was "x")', ['n']]]);
  });
});
