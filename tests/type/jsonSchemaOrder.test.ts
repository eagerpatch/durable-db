import { describe, expect, it } from 'vitest';
import { type } from '../../src/type';

const keysOf = (t: { toJsonSchema: () => unknown }) => Object.keys((t.toJsonSchema() as { properties: object }).properties);

describe('a JSON Schema lists the keys as declared', () => {
  it('an object literal', () => {
    const t = type({ status: "'draft' | 'posted'", customerId: 'string', 'first?': 'number', after: 'string' });
    expect(keysOf(t)).toEqual(['status', 'customerId', 'first', 'after']);
    // what ArkType checks and prints in, and its required list, stay sorted
    expect(t.expression).toBe(`{ after: string, customerId: string, status: "draft" | "posted", first?: number }`);
    expect((t.toJsonSchema() as { required: string[] }).required).toEqual(['after', 'customerId', 'status']);
  });

  it('a spread, merge() and and(): a key both have keeps its place', () => {
    const base = type({ name: 'string', age: 'number' });
    expect(keysOf(type({ '...': base, email: 'string', name: 'string > 0' }))).toEqual(['name', 'age', 'email']);
    expect(keysOf(base.merge({ zip: 'string', age: 'number > 0' }))).toEqual(['name', 'age', 'zip']);
    expect(keysOf(base.and({ zip: 'string', name: 'string' }))).toEqual(['name', 'age', 'zip']);
  });

  it('pick(), omit(), partial(), required() and onUndeclaredKey() keep the order', () => {
    const t = type({ z: 'string', a: 'number', 'm?': 'boolean' });
    expect(keysOf(t.pick('m', 'z'))).toEqual(['z', 'm']);
    expect(keysOf(t.omit('a'))).toEqual(['z', 'm']);
    expect(keysOf(t.partial())).toEqual(['z', 'a', 'm']);
    expect(keysOf(t.required())).toEqual(['z', 'a', 'm']);
    expect(keysOf(t.onUndeclaredKey('reject'))).toEqual(['z', 'a', 'm']);
  });
});
