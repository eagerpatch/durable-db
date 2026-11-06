import { describe, expect, it } from 'vitest';
import { type as ark } from 'arktype';
import { type } from '../../src/type';

// durable-db/type against ArkType itself: every definition here, with every
// value, must be accepted or rejected alike, give the same output, the same
// message and the same JSON Schema. A difference ArkType's own behaviour
// would explain away belongs in KNOWN, with the reason.

const VALUES: unknown[] = [
  undefined, null, true, false, 0, -0, 1, -1, 1.5, -1.5, 2, 5, 10, 11, 255, 256, NaN, Infinity, -Infinity, 10n,
  '', 'a', 'b', 'c', 'ab', 'abc', 'abcd', 'A', 'Ab', ' a ', 'aaa', 'hello world', '1', '-1', '1.5', '01', 'x@y.co', 'not an email',
  '2026-11-06', '2026-11-06T10:00:00Z', 'nope', '{"a":1}', '{', '123e4567-e89b-12d3-a456-426614174000', 'https://example.com', '1.2.3',
  '192.168.0.1', '::1', 'deadbeef', 'aGVsbG8=',
  [], ['a'], ['a', 'b'], ['a', 1], [1, 2], [1, 'a'], ['a', 1, 2], [[]],
  {}, { a: 1 }, { a: 'x' }, { name: 'a' }, { name: 1 }, { name: 'a', age: 1 }, { name: 'a', age: -1 }, { name: 'a', age: 1.5 }, { name: 'a', age: undefined },
  { name: 'a', extra: true }, { kind: 'a', a: 'x' }, { kind: 'a', a: 1 }, { kind: 'b', b: 1 }, { kind: 'c' }, { n: 1 }, { n: 'x' },
  { lines: [{ qty: 1, price: 2 }] }, { lines: [{ qty: 'x' }] }, { lines: [] }, { x: { y: 'z' } }, { x: { y: 1 } }, { x: 1 },
  new Date('2026-01-01T00:00:00Z'), new Date('invalid'), () => {}, Symbol.for('s'),
];

const DEFINITIONS: unknown[] = [
  'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'null', 'undefined', 'unknown', 'never', 'true', 'false', 'Date', 'Array',
  'number >= 0', 'number > 0', 'number >= 5', 'number > 5', 'number <= 5', 'number < 5', 'number <= 0', 'number < 0', '0 < number <= 10', '1 <= number < 11',
  'number.integer', 'number.integer >= 0', 'number.integer > 0', 'number % 2', 'number % 5', 'number.safe', 'number.epoch', 'number.NaN', 'number.Infinity',
  'string > 0', 'string >= 3', 'string <= 3', 'string < 3', 'string == 3', '1 <= string <= 4',
  'string[]', 'number[]', 'string[] > 0', 'string[] <= 1', 'unknown[]', 'string[][]', '(string | number)[]',
  'string | number', 'string | null', 'string | undefined', 'number | null', "'a' | 'b'", '"a"', "'a'", '5', '1 | 2 | 3', 'true | 1', 'boolean | null', 'string | number | null',
  'string.email', 'string.uuid', 'string.uuid.v4', 'string.url', 'string.integer', 'string.numeric', 'string.alpha', 'string.alphanumeric', 'string.digits',
  'string.hex', 'string.base64', 'string.semver', 'string.ip', 'string.ip.v4', 'string.json', 'string.date', 'string.date.iso', 'string.lower.preformatted',
  'string.upper.preformatted', 'string.trim.preformatted', 'string.capitalize.preformatted',
  'string.trim', 'string.lower', 'string.upper', 'string.capitalize', 'string.numeric.parse', 'string.integer.parse', 'string.date.parse',
  'string.date.iso.parse', 'string.json.parse',
  '/^a+$/', 'string & /^a/', 'string > 1 & /^a/',
  'Record<string, number>',
  { name: 'string' },
  { name: 'string', 'age?': 'number.integer >= 0' },
  { name: 'string', age: 'number?' },
  { 'name?': 'string' },
  { n: 'number = 5' },
  { n: "string = 'x'" },
  { name: 'string', '+': 'reject' },
  { name: 'string', '+': 'delete' },
  { '[string]': 'number' },
  { a: 'string', '[string]': 'number | string' },
  { x: { y: 'string' } },
  { lines: [{ qty: 'number.integer > 0', price: 'number' }, '[]'] },
  { kind: "'a'", a: 'string' },
  { 'quoted-key': 'string', 'a b': 'number' },
  ['string', 'number'],
  ['string', 'number?'],
  ['string', '...', 'number[]'],
  [],
  ['string', '[]'],
  ['string', '|', 'number'],
  [{ a: 'string' }, '&', { b: 'number' }],
  ['===', 'a', 1, null],
  ['instanceof', Date],
  ['keyof', { a: 'string', b: 'number' }],
];

const DEFINITION_BUILDERS: Array<[string, (t: typeof type | typeof ark) => unknown]> = [
  ['object.or(object) discriminated', (t) => (t as typeof ark)({ kind: "'a'", a: 'string' }).or({ kind: "'b'", b: 'number' })],
  ['object.or(object)', (t) => (t as typeof ark)({ name: 'string' }).or({ n: 'number' })],
  ['string.array()', (t) => (t as typeof ark)('string').array()],
  ['object.merge', (t) => (t as typeof ark)({ a: 'string', b: 'string' }).merge({ b: 'number' })],
  ['object.pick', (t) => (t as typeof ark)({ a: 'string', b: 'number' }).pick('a')],
  ['object.omit', (t) => (t as typeof ark)({ a: 'string', b: 'number' }).omit('a')],
  ['object.partial', (t) => (t as typeof ark)({ a: 'string', b: 'number' }).partial()],
  ['object.required', (t) => (t as typeof ark)({ 'a?': 'string', 'b?': 'number' }).required()],
  ['string.narrow', (t) => (t as typeof ark)('string').narrow((s) => s.length % 2 === 0)],
  ['string.narrow mustBe', (t) => (t as typeof ark)('string').narrow((s, ctx) => s.startsWith('a') || ctx.mustBe('a string starting with a'))],
  ['string.pipe', (t) => (t as typeof ark)('string').pipe((s) => s.length)],
  ['string.numeric.parse.to', (t) => (t as typeof ark)('string.numeric.parse').to('number > 1')],
  ['describe', (t) => (t as typeof ark)('string').describe('a name')],
  ['optional()', (t) => (t as typeof ark)({ a: (t as typeof ark)('string').optional() })],
  ['default()', (t) => (t as typeof ark)({ a: (t as typeof ark)('number').default(1) })],
  ['nested Type', (t) => (t as typeof ark)({ inner: (t as typeof ark)({ y: 'string' }), list: (t as typeof ark)({ q: 'number' }).array() })],
  ['onUndeclaredKey', (t) => (t as typeof ark)({ a: 'string' }).onUndeclaredKey('reject')],
  ['unit', (t) => (t as typeof ark).unit('x')],
  ['enumerated', (t) => (t as typeof ark).enumerated('x', 1)],
];

/** Where durable-db/type differs from ArkType on purpose, and why. */
const KNOWN: Array<{ name: RegExp; value?: string; kind: 'decision' | 'output' | 'message' | 'json'; reason: string }> = [
  {
    name: /^\["===","a",1,null\]$/,
    kind: 'message',
    reason: 'ArkType lists mixed units in an order we have not derived ("1, \"a\" or null"); we print the order its JSON Schema has',
  },
  {
    name: /.*/,
    value: 'fn',
    kind: 'message',
    reason: 'ArkType names a function by a counter in its global registry (`Function(fn11)`); we print its own name',
  },
  {
    name: /number/,
    value: 'NaN',
    kind: 'decision',
    reason: "ArkType's `number` rejects NaN, but a union with another domain (`number | string`, `number | null`) lets it through; NaN stays rejected everywhere here",
  },
];

const known = (name: string, kind: string, value?: string) =>
  KNOWN.some((k) => k.kind === kind && k.name.test(name) && (k.value === undefined || k.value === value));

const label = (v: unknown) => {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return String(v);
  if (typeof v === 'function') return 'fn';
  if (v instanceof Date) return Number.isNaN(v.valueOf()) ? 'InvalidDate' : `Date(${v.toISOString()})`;
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return JSON.stringify(v);
};

const clone = (v: unknown): unknown => (typeof v === 'object' && v !== null && !(v instanceof Date) ? structuredClone(v) : v);

const ONLY = process.env.CONFORMANCE_ONLY?.split(',');

function compare(name: string, a: any, l: any) {
  const problems: string[] = [];
  const want = (kind: string) => !ONLY || ONLY.includes(kind);
  for (const value of VALUES) {
    const expected = a(clone(value));
    const actual = l(clone(value));
    const expectedOk = !(expected instanceof ark.errors);
    const actualOk = !(actual instanceof type.errors);
    if (expectedOk !== actualOk) {
      if (want('decision') && !known(name, 'decision', label(value))) problems.push(`${label(value)}: arktype ${expectedOk ? 'accepts' : `rejects (${expected.summary})`}, durable-db/type ${actualOk ? 'accepts' : `rejects (${actual.summary})`}`);
      continue;
    }
    if (expectedOk) {
      try {
        expect(actual).toEqual(expected);
      } catch {
        if (want('output') && !known(name, 'output', label(value))) problems.push(`${label(value)}: output ${label(expected)} ≠ ${label(actual)}`);
      }
    } else if (want('message') && !known(name, 'message', label(value)) && expected.summary !== actual.summary) {
      problems.push(`${label(value)}: message\n      arktype:        ${expected.summary.replace(/\n/g, '\n                      ')}\n      durable-db/type: ${actual.summary.replace(/\n/g, '\n                      ')}`);
    }
  }
  let expectedJson: unknown;
  try {
    expectedJson = a.toJsonSchema();
  } catch {
    expectedJson = 'throws';
  }
  if (want('json') && expectedJson !== 'throws' && !known(name, 'json')) {
    let actualJson: unknown;
    try {
      actualJson = l.toJsonSchema();
    } catch (error) {
      actualJson = `throws ${(error as Error).message}`;
    }
    try {
      expect(actualJson).toEqual(expectedJson);
    } catch {
      problems.push(`JSON Schema:\n      arktype:        ${JSON.stringify(expectedJson)}\n      durable-db/type: ${JSON.stringify(actualJson)}`);
    }
  }
  return problems;
}

describe('durable-db/type against ArkType', () => {
  for (const def of DEFINITIONS) {
    const name = typeof def === 'string' ? def : label(def).replace(/"fn"|null/g, (m) => m) + (Array.isArray(def) && def.includes(Date) ? ' (Date)' : '');
    it(name, () => {
      const problems = compare(name, ark(def as never), type(def as never));
      expect(problems, `\n  ${problems.join('\n  ')}`).toEqual([]);
    });
  }
  for (const [name, build] of DEFINITION_BUILDERS) {
    it(name, () => {
      const problems = compare(name, build(ark), build(type));
      expect(problems, `\n  ${problems.join('\n  ')}`).toEqual([]);
    });
  }
});
