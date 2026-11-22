import { describe, it, expect } from 'vitest';
import { type, isType, ParseError } from '../../src/type';
import { actionArgsType } from '../../src/db/actionArgs';

// `type()` runs at module scope — an action's args, an API's inputs, a job's —
// and every isolate evaluates all of them as it starts, though a request
// validates one or two. A definition is parsed when its Type is first used,
// then kept.

/** A definition that counts how often its keys are read: what a parse does. */
function counted(): { def: Record<string, unknown>; reads: () => number } {
  let reads = 0;
  const def = {};
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
  it('is not read by type(), and is a Type already', () => {
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
