import { describe, it, expect, vi } from 'vitest';
import { type, isType, ParseError } from '../../src/type';
import { actionArgsType } from '../../src/db/actionArgs';

// `type()` runs at module scope — an action's args, an API's inputs, a job's —
// and every isolate evaluates all of them as it starts, though a request
// validates one or two. A definition is parsed when its Type is first used,
// then kept; what is parsed is the definition as it was at `type()`.

/**
 * A definition that counts how often its keys are read: what a parse does. An
 * instance of a class, which `type()` keeps as it is (it copies plain objects
 * and arrays), so the reads counted are the parse's.
 */
function counted(): { def: Record<string, unknown>; reads: () => number } {
  let reads = 0;
  const def: Record<string, unknown> = new (class Definition {})() as Record<string, unknown>;
  for (const [key, value] of Object.entries({ name: 'string > 0', 'age?': 'number.integer >= 0' })) {
    Object.defineProperty(def, key, {
      enumerable: true,
      get: () => {
        reads++;
        return value;
      },
    });
  }
  return { def, reads: () => reads };
}

describe('a definition', () => {
  it('is not parsed by type(), and is a Type already', () => {
    const { def, reads } = counted();
    const User = type.raw(def);
    expect(reads()).toBe(0);
    expect(isType(User)).toBe(true);
    expect(reads()).toBe(0);
  });

  it('is parsed at the first use, once', () => {
    const { def, reads } = counted();
    const User = type.raw(def);
    expect(User({ name: 'Ada' })).toEqual({ name: 'Ada' });
    const once = reads();
    expect(once).toBeGreaterThan(0);
    expect(User({ name: '' })).toBeInstanceOf(type.errors);
    expect(User.allows({ name: 'Ada', age: 3 })).toBe(true);
    expect(User.json).toMatchObject({ type: 'object', required: ['name'] });
    expect(reads()).toBe(once);
  });

  it.each([
    ['a call', (T: any) => T({ name: 'Ada' })],
    ['assert', (T: any) => T.assert({ name: 'Ada' })],
    ['allows', (T: any) => T.allows({ name: 'Ada' })],
    ['expression', (T: any) => T.expression],
    ['description', (T: any) => T.description],
    ['json', (T: any) => T.json],
    ['toJsonSchema()', (T: any) => T.toJsonSchema()],
    ['props', (T: any) => T.props],
    ['~standard', (T: any) => T['~standard'].validate({ name: 'Ada' })],
    ['a method that makes another Type', (T: any) => T.array()],
    ['another Type that holds it, at its use', (T: any) => type({ user: T })({ user: { name: 'Ada' } })],
  ])('is parsed by %s', (_, use) => {
    const { def, reads } = counted();
    const User = type.raw(def);
    use(User);
    expect(reads()).toBeGreaterThan(0);
  });

  // What 0.14.1, which parsed in type(), answered for it.
  it('answers as an eagerly parsed one did', () => {
    const User = type({ name: 'string > 0', 'age?': 'number.integer >= 0' });
    expect(User.expression).toBe('{ name: string >= 1, age?: number & % 1 & >= 0 }');
    expect((User({ name: '', age: 1.5 }) as InstanceType<typeof type.errors>).summary).toBe(
      'name must be non-empty\nage must be an integer (was 1.5)'
    );
    expect(User['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(User.toJsonSchema());
    expect(User.props.map((p) => [p.key, p.kind, p.value.expression])).toEqual([
      ['name', 'required', 'string >= 1'],
      ['age', 'optional', 'number & % 1 & >= 0'],
    ]);
  });

  it('that cannot be parsed throws its ParseError at each use, not at type()', () => {
    const Bad = type.raw({ name: 'strng' });
    expect(() => Bad({ name: 'x' })).toThrow(ParseError);
    expect(() => Bad.json).toThrow("'strng' is unresolvable");
    expect(() => Bad['~standard']).toThrow(ParseError);
    const Holding = type({ bad: Bad as never });
    expect(() => Holding({ bad: 'x' })).toThrow(ParseError);
  });

  it('of type.or() and type.and() too', () => {
    const { def, reads } = counted();
    const Either = type.or(def as never, 'null');
    const Both = type.and(def as never, { extra: 'boolean' });
    expect(reads()).toBe(0);
    expect(Either(null)).toBe(null);
    expect(Both.allows({ name: 'Ada', extra: true })).toBe(true);
    expect(reads()).toBeGreaterThan(0);
  });

  it("of an action's args (a parser with its own rules) too", () => {
    const { def, reads } = counted();
    const Args = actionArgsType(def as never);
    expect(reads()).toBe(0);
    expect(Args({ name: 'Ada', age: undefined })).toEqual({ name: 'Ada', age: undefined });
    expect(reads()).toBeGreaterThan(0);
  });
});

// 0.14.1 parsed a definition in `type()`, so a Type checked what was written
// there, whatever became of the objects it was written with. `type()` copies
// the definition's plain objects and arrays, and the first use parses the copy.
describe('a definition changed after type()', () => {
  it('is checked as it was at type(): an object, a tuple', () => {
    const def: Record<string, unknown> = { name: 'string' };
    const Create = type(def as never);
    def.id = 'number';
    delete def.name;
    expect(Create({ name: 'a' })).toEqual({ name: 'a' });
    expect(Create({})).toBeInstanceOf(type.errors);
    const tuple = ['string'];
    const Pair = type(tuple as never);
    tuple.push('number');
    expect(Pair(['a'])).toEqual(['a']);
  });

  it('at any depth: a nested object, a tuple expression, a spread, an index, a key with a default', () => {
    const address = { city: 'string' };
    const tags = ['string', '[]'];
    const base = { id: 'number' };
    const scores = { '[string]': 'number' };
    const fallback: unknown[] = ['number', '=', 0];
    const T = type.raw({ address, tags, extra: { '...': base }, scores, count: fallback });
    address.city = 'number';
    tags[1] = '|';
    base.id = 'string';
    scores['[string]'] = 'string';
    fallback[0] = 'string';
    const value = { address: { city: 'Lund' }, tags: ['a'], extra: { id: 1 }, scores: { a: 1 } };
    expect(T(value)).toEqual({ ...value, count: 0 });
    expect(T.expression).toBe(type.raw({ address: { city: 'string' }, tags: 'string[]', extra: { id: 'number' }, scores: { '[string]': 'number' }, count: 'number = 0' }).expression);
  });

  it('of type.or(), type.and(), type() of several arguments, type.raw() and an action\'s args', () => {
    const left = { a: 'string' };
    const right = { b: 'number' };
    const Either = type.or(left as never, right as never);
    const Both = type.and(left as never, right as never);
    const Union = (type as unknown as (...defs: unknown[]) => typeof Either)(left, '|', right);
    const Raw = type.raw(left);
    const Args = actionArgsType(left as never);
    left.a = 'number';
    right.b = 'string';
    expect(Either({ a: 'x' })).toEqual({ a: 'x' });
    expect(Either({ b: 1 })).toEqual({ b: 1 });
    expect(Both({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 });
    expect(Union({ a: 'x' })).toEqual({ a: 'x' });
    expect(Raw({ a: 'x' })).toEqual({ a: 'x' });
    expect(Args({ a: 'x' })).toEqual({ a: 'x' });
  });

  it('keeps what it holds as a value as it is: a unit, a default, a function, a Type, a RegExp, an instance', () => {
    const unit = { exactly: 'this' };
    const empty: string[] = [];
    const Tags = type({ name: 'string' });
    const morph = (s: string) => s.length;
    const T = type.raw({
      unit: ['===', unit],
      tags: ['string[]', '=', empty],
      length: ['string', '=>', morph],
      named: Tags,
      code: /^[A-Z]+$/,
      at: ['instanceof', Date],
    });
    const out = T({ unit, length: 'abc', named: { name: 'n' }, code: 'AB', at: new Date(0) }) as Record<string, unknown>;
    expect(out.unit).toBe(unit);
    expect(out.tags).toBe(empty);
    expect(out.length).toBe(3);
    expect(T({ unit: { exactly: 'this' }, length: '', named: { name: 'n' }, code: 'AB', at: new Date(0) })).toBeInstanceOf(type.errors);
  });

  it('as an instance of a class is read at the first use, as it is then', () => {
    const def = new (class Definition {
      name = 'string';
    })() as unknown as Record<string, string>;
    const T = type.raw(def);
    def.name = 'number';
    expect(T({ name: 1 })).toEqual({ name: 1 });
  });

  it('as a plain object is read by type(), once', () => {
    let reads = 0;
    const def = {};
    Object.defineProperty(def, 'name', {
      enumerable: true,
      get: () => {
        reads++;
        return 'string';
      },
    });
    const T = type.raw(def);
    expect(reads).toBe(1);
    expect(T({ name: 'a' })).toEqual({ name: 'a' });
    expect(T.json).toMatchObject({ required: ['name'] });
    expect(reads).toBe(1);
  });

  it('keeps an own __proto__ key a key', () => {
    const def = JSON.parse('{"__proto__": "string", "name": "string"}');
    const T = type.raw(def);
    expect(T.props.map((p) => p.key)).toEqual(['__proto__', 'name']);
    expect(T({ name: 'a' })).toBeInstanceOf(type.errors);
  });
});

// A RegExp literal is compiled when it first runs; the constructor parses its
// pattern when called. The IPv6 keyword's (~1 KB) is made at its first use.
describe('the keywords', () => {
  it('construct no IPv6 pattern when the module loads, one at the first use', async () => {
    vi.resetModules();
    const Original = globalThis.RegExp;
    const made: string[] = [];
    globalThis.RegExp = new Proxy(Original, {
      construct(target, args) {
        made.push(String(args[0]));
        return Reflect.construct(target, args);
      },
    });
    const ipv6 = (pattern: string) => pattern.includes('[0-9a-fA-F]{1,4}');
    try {
      const fresh = await import('../../src/type');
      expect(made.filter(ipv6)).toEqual([]);
      expect(fresh.type('string.ip.v6').allows('::1')).toBe(true);
      expect(fresh.type('string.ip').allows('fe80::1%eth0')).toBe(true);
      expect(fresh.type('string.ip').allows('10.0.0.1')).toBe(true);
    } finally {
      globalThis.RegExp = Original;
    }
    expect(made.filter(ipv6)).toHaveLength(1);
  });
});
