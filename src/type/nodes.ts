// The validators a definition compiles to: plain closures over a small tree
// of nodes — no code generation (Workers refuse `new Function` during a
// request) and nothing built at import, so a worker that imports this pays
// for the definitions it parses, not for a scope of every keyword.
//
// Each node validates a value (and transforms it, for a morph or a default
// below it), describes what it expects in ArkType's words for an error
// message, and writes its JSON Schema.
import { ArkError, type ArkErrorInput, type PathKey } from './errors';

export const FAIL: unique symbol = Symbol('durable-db/type: fail');

export type Domain = 'string' | 'number' | 'bigint' | 'boolean' | 'symbol' | 'undefined' | 'null' | 'object';

export interface TypeConfig {
  /** An optional key rejects `undefined` (ArkType's default), or admits it like TypeScript's default settings. */
  exactOptionalPropertyTypes: boolean;
  /** What an object does with a key it does not declare. */
  onUndeclaredKey: 'ignore' | 'reject' | 'delete';
  /** JSON Schema for a unit JSON has no value for (`undefined`, a symbol, a bigint); the default throws. */
  jsonSchemaUnit?: (unit: unknown) => JsonSchema;
}

export const DEFAULT_CONFIG: TypeConfig = { exactOptionalPropertyTypes: true, onUndeclaredKey: 'ignore' };

export type JsonSchema = Record<string, unknown>;

export interface JsonContext {
  side: 'in' | 'out';
  target: 'draft-2020-12' | 'draft-07';
  config: TypeConfig;
}

export class ToJsonSchemaError extends Error {
  override readonly name = 'ToJsonSchemaError';
}

/** A validation in progress: the errors so far and where it is. */
export class Ctx {
  readonly errors: ArkError[] = [];
  readonly path: PathKey[];
  constructor(
    /** The rules of the Type being run; a nested Type made with other rules switches them for its part. */
    public config: TypeConfig,
    path: readonly PathKey[] = [],
  ) {
    this.path = [...path];
  }

  fail(input: ArkErrorInput): typeof FAIL {
    this.errors.push(new ArkError({ ...input, path: [...this.path, ...(input.path ?? [])] }));
    return FAIL;
  }

  /** A child validation that keeps its errors to itself (a union tries its branches with one). */
  scratch(): Ctx {
    return new Ctx(this.config, this.path);
  }
}

export function domainOf(value: unknown): Domain {
  if (value === null) return 'null';
  const t = typeof value;
  return t === 'function' ? 'object' : (t as Domain);
}

const DOMAIN_DESCRIPTIONS: Record<Domain, string> = {
  string: 'a string',
  number: 'a number',
  bigint: 'a bigint',
  boolean: 'boolean',
  symbol: 'a symbol',
  undefined: 'undefined',
  null: 'null',
  object: 'an object',
};

/** What a value was, as a domain: `a number`, `an object` — and `NaN` where a number is expected. */
export function describeDomain(value: unknown, nan = false): string {
  if (nan && typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return DOMAIN_DESCRIPTIONS[domainOf(value)];
}

/** What a value was, as ArkType prints it (its `printable`): `"c"`, `6`, `1n`, `{"a":1}`, `January 1, 2026`. */
export function printValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return `Symbol(${value.description ?? ''})`;
    case 'function':
      return `Function(${value.name || 'anonymous'})`;
    case 'object': {
      if (value === null) return 'null';
      const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
      if (ctor === 'Object' || ctor === 'Array') return JSON.stringify(serialize(value, [])).replace(/"\uE000(-?\d+n)"/g, '$1');
      if (value instanceof Date) return describeDate(value);
      return ctor;
    }
    default:
      return String(value);
  }
}

function serialize(value: unknown, seen: unknown[]): unknown {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return `\uE000${value}n`;
    case 'symbol':
      return `Symbol(${value.description ?? ''})`;
    case 'function':
      return `Function(${value.name || 'anonymous'})`;
    case 'object': {
      if (value === null) return null;
      if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return (value as { toJSON(): unknown }).toJSON();
      if (seen.includes(value)) return '(cycle)';
      const next = [...seen, value];
      if (Array.isArray(value)) return value.map((item) => serialize(item, next));
      const out: Record<string, unknown> = {};
      for (const key in value) out[key] = serialize((value as Record<string, unknown>)[key], next);
      return out;
    }
    default:
      return value;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number, length: number) => String(n).padStart(length, '0');

/** A Date as ArkType describes one, to its precision (local time): `2026`, `January 6, 2026`, `1:30 PM, January 6, 2026`. */
function describeDate(date: Date): string {
  const [year, month, day, hours, minutes, seconds, ms] = [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
  if (month === 0 && day === 1 && hours === 0 && minutes === 0 && seconds === 0 && ms === 0) return `${year}`;
  const datePortion = `${MONTHS[month]} ${day}, ${year}`;
  if (hours === 0 && minutes === 0 && seconds === 0 && ms === 0) return datePortion;
  const h = hours % 12 || 12;
  let time = seconds || ms ? `${h}:${pad(minutes, 2)}:${pad(seconds, 2)}` : `${h}:${pad(minutes, 2)}`;
  if (ms) time += `.${pad(ms, 3)}`;
  return `${time}${hours < 12 ? ' AM' : ' PM'}, ${datePortion}`;
}

/** What a value was, for a constructor check: `string`, `object`, `an invalid Date`. */
function describeForProto(value: unknown): string {
  if (value instanceof Date && Number.isNaN(value.valueOf())) return 'an invalid Date';
  if (typeof value === 'object' && value !== null) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    return ctor && ctor !== 'Object' ? ctor : 'object';
  }
  return domainOf(value);
}

/** `a`, `a or b`, `a, b or c`. */
export function joinOr(items: readonly string[]): string {
  const unique = [...new Set(items)];
  if (unique.length <= 2) return unique.join(' or ');
  return `${unique.slice(0, -1).join(', ')} or ${unique[unique.length - 1]}`;
}

function notConvertible(what: string): never {
  throw new ToJsonSchemaError(`${what} is not convertible to JSON Schema`);
}

export abstract class Node {
  abstract readonly kind: string;
  /** The definition, as ArkType writes it: `string`, `number >= 0`, `{ name: string }`. */
  abstract readonly expression: string;
  /** What a value must be, in a message: `a string`, `non-negative`, `"a" or "b"`. */
  abstract readonly expected: string;
  /** Whether validating may give back something other than the value (a morph or a default below). */
  readonly morphs: boolean = false;
  /** A description set with `.describe()` / `.configure()`. */
  description?: string;

  /**
   * What a missing key's value must be, as ArkType says it: the basis — the
   * domain or constructor — not the rules on it (`'string > 0'` → `a string`).
   */
  get basis(): string {
    return expectedOf(this);
  }

  /** The value (or what it becomes), or FAIL with the errors in `ctx`. */
  abstract run(value: unknown, ctx: Ctx): unknown;

  /** JSON Schema keys of this node's metadata (`.describe()`, a keyword's `format`). */
  meta?: JsonSchema;

  protected abstract jsonOf(js: JsonContext): JsonSchema;

  /** The node's JSON Schema, with its description and metadata. */
  json(js: JsonContext): JsonSchema {
    const schema = this.jsonOf(js);
    if (this.description !== undefined) schema.description = this.description;
    return this.meta ? { ...schema, ...this.meta } : schema;
  }

  /**
   * Where this node goes in a union, as ArkType orders branches: by kind
   * (domains, then other constraints, then constructors, then units), then by
   * ArkType's JSON of the node.
   */
  abstract sortKey(): string;

  /** The one domain every value of this node has, if there is one (for a union's message). */
  domain(): Domain | null {
    return null;
  }

  allows(value: unknown, config: TypeConfig): boolean {
    return this.run(value, new Ctx(config)) !== FAIL;
  }
}

/** What a description replaces: the expected in every message this node writes. */
export function expectedOf(node: Node): string {
  return node.description ?? node.expected;
}

/** A unit as ArkType's JSON writes it, for ordering. */
function unitKey(value: unknown): string {
  if (value === undefined) return '"undefined"';
  if (typeof value === 'bigint') return `"${value}n"`;
  if (typeof value === 'symbol') return '"symbol"';
  if (typeof value === 'number' && !Number.isFinite(value)) return `"${value}"`;
  return JSON.stringify(value);
}

/** A node as a value in ArkType's JSON: a bare domain is its name. */
function valueKey(node: Node): string {
  return node instanceof DomainNode && node.name !== 'boolean' ? `"${node.name}"` : node.sortKey().slice(1);
}

// ── Leaves ──────────────────────────────────────────────────────────────

export class DomainNode extends Node {
  readonly kind = 'domain';
  override get basis(): string {
    return DOMAIN_DESCRIPTIONS[this.name];
  }
  sortKey(): string {
    return this.name === 'boolean' ? '3{"unit":false}' : `0{"domain":"${this.name}"}`;
  }
  readonly expected: string;
  constructor(readonly name: Domain) {
    super();
    this.expected = DOMAIN_DESCRIPTIONS[name];
  }
  get expression(): string {
    return this.name;
  }
  run(value: unknown, ctx: Ctx): unknown {
    const domain = domainOf(value);
    if (domain === this.name && !(domain === 'number' && Number.isNaN(value))) return value;
    // `boolean` is ArkType's union of `true` and `false`: the value is printed.
    return ctx.fail({ code: 'domain', expected: expectedOf(this), actual: this.name === 'boolean' ? printValue(value) : describeDomain(value, true), data: value });
  }
  domain(): Domain {
    return this.name;
  }
  jsonOf(js: JsonContext): JsonSchema {
    switch (this.name) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'null':
      case 'object':
        return { type: this.name };
      case 'undefined':
        return unitJson(undefined, js);
      default:
        return notConvertible(this.name);
    }
  }
}

function unitJson(value: unknown, js: JsonContext): JsonSchema {
  // A number is a `const` even when JSON cannot hold it (NaN, Infinity), as ArkType writes it.
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return { const: value };
  }
  if (js.config.jsonSchemaUnit) return js.config.jsonSchemaUnit(value);
  return notConvertible(printValue(value));
}

export class UnitNode extends Node {
  readonly kind = 'unit';
  override get basis(): string {
    return (this.meta?.description as string | undefined) ?? printValue(this.value);
  }
  sortKey(): string {
    return `3{"unit":${unitKey(this.value)}}`;
  }
  constructor(readonly value: unknown) {
    super();
  }
  get expression(): string {
    return printValue(this.value);
  }
  get expected(): string {
    return printValue(this.value);
  }
  run(value: unknown, ctx: Ctx): unknown {
    if (value === this.value || (Number.isNaN(this.value) && Number.isNaN(value))) return value;
    return ctx.fail({ code: 'unit', expected: expectedOf(this), actual: printValue(value), data: value });
  }
  domain(): Domain {
    return domainOf(this.value);
  }
  jsonOf(js: JsonContext): JsonSchema {
    return this.value === null ? { type: 'null' } : unitJson(this.value, js);
  }
}

export class UnknownNode extends Node {
  readonly kind = 'unknown';
  override get basis(): string {
    return 'present';
  }
  sortKey(): string {
    return '0{}';
  }
  readonly expression = 'unknown';
  readonly expected = 'anything';
  run(value: unknown): unknown {
    return value;
  }
  jsonOf(): JsonSchema {
    return {};
  }
}

export class NeverNode extends Node {
  readonly kind = 'never';
  sortKey(): string {
    return '9';
  }
  readonly expression = 'never';
  readonly expected = 'never';
  run(value: unknown, ctx: Ctx): unknown {
    // ArkType's message for never has no path: just `never`.
    return ctx.fail({ code: 'union', expected: 'never', problem: 'never', message: 'never', data: value });
  }
  jsonOf(): JsonSchema {
    return { enum: [] };
  }
}

/** `instanceof` a constructor: `Date` (a valid one), `Array`, any class. */
export class ProtoNode extends Node {
  readonly kind = 'proto';
  override get basis(): string {
    return this.expected;
  }
  sortKey(): string {
    return `2{"proto":"${this.expression}"}`;
  }
  readonly expected: string;
  readonly expression: string;
  constructor(readonly ctor: abstract new (...args: never[]) => unknown, name?: string) {
    super();
    this.expression = name ?? ctor.name;
    this.expected = ctor === Array ? 'an array' : `${/^[AEIOU]/.test(this.expression) ? 'an' : 'a'} ${this.expression}`;
  }
  run(value: unknown, ctx: Ctx): unknown {
    const ok = this.ctor === Array ? Array.isArray(value) : value instanceof this.ctor;
    if (ok && !(value instanceof Date && Number.isNaN(value.valueOf()))) return value;
    return ctx.fail({ code: 'proto', expected: expectedOf(this), actual: describeForProto(value), data: value });
  }
  domain(): Domain {
    return 'object';
  }
  jsonOf(): JsonSchema {
    if (this.ctor === Array) return { type: 'array' };
    return notConvertible(this.expression);
  }
}

// ── Refinements: bounds, divisors, patterns, predicates ─────────────────

export interface Refinement {
  kind: 'min' | 'max' | 'exactLength' | 'minLength' | 'maxLength' | 'after' | 'before' | 'divisor' | 'pattern' | 'predicate';
  /** In `expression`: `>= 0`, `% 2`, `/^a/`. */
  expression: string;
  /** In a message: `non-negative`, `an integer`. */
  expected: string;
  /** What the value was for this rule, or null when the message says enough (`must be non-empty`). */
  actual(value: unknown): string | null;
  /** True when the value passes; false, or the errors a predicate wrote itself, when it does not. */
  test(value: unknown, ctx: Ctx): boolean | ArkError[];
  /** Adds the rule to the base's JSON Schema. */
  json(schema: JsonSchema, js: JsonContext): void;
}

type Measure = 'value' | 'length' | 'time';

function measured(value: unknown, measure: Measure): number {
  if (measure === 'length') return (value as { length: number }).length;
  if (measure === 'time') return (value as Date).valueOf();
  return value as number;
}

function printLimit(limit: number, measure: Measure): string {
  return measure === 'time' ? new Date(limit).toLocaleString() : String(limit);
}

/** A lower bound: `>= n` (inclusive) or `> n`. On a length the bound is whole: `> 0` is `>= 1`. */
export function minRefinement(limit: number, exclusive: boolean, measure: Measure): Refinement {
  if (measure === 'length' && exclusive) return minRefinement(limit + 1, false, measure);
  const kind = measure === 'length' ? 'minLength' : measure === 'time' ? 'after' : 'min';
  const expected =
    measure === 'length'
      ? limit === 1
        ? 'non-empty'
        : `at least length ${limit}`
      : measure === 'time'
        ? `${exclusive ? 'after' : 'at or after'} ${printLimit(limit, measure)}`
        : limit === 0
          ? exclusive
            ? 'positive'
            : 'non-negative'
          : `${exclusive ? 'more than' : 'at least'} ${limit}`;
  return {
    kind,
    expression: `${exclusive ? '>' : '>='} ${printLimit(limit, measure)}`,
    expected,
    actual: (value) =>
      measure === 'length' && (limit === 1 || measured(value, measure) === 0) ? null : measure === 'time' ? printValue(value) : String(measured(value, measure)),
    test: (value) => (exclusive ? measured(value, measure) > limit : measured(value, measure) >= limit),
    json(schema) {
      if (measure === 'length') schema[schema.type === 'array' ? 'minItems' : 'minLength'] = limit;
      else if (measure === 'value') schema[exclusive ? 'exclusiveMinimum' : 'minimum'] = limit;
      else notConvertible('A Date bound');
    },
  };
}

/** An upper bound: `<= n` or `< n`; on a length `< n` is `<= n - 1`. */
export function maxRefinement(limit: number, exclusive: boolean, measure: Measure): Refinement {
  if (measure === 'length' && exclusive) return maxRefinement(limit - 1, false, measure);
  const kind = measure === 'length' ? 'maxLength' : measure === 'time' ? 'before' : 'max';
  const expected =
    measure === 'length'
      ? `at most length ${limit}`
      : measure === 'time'
        ? `${exclusive ? 'before' : 'at or before'} ${printLimit(limit, measure)}`
        : limit === 0
          ? exclusive
            ? 'negative'
            : 'non-positive'
          : `${exclusive ? 'less than' : 'at most'} ${limit}`;
  return {
    kind,
    expression: `${exclusive ? '<' : '<='} ${printLimit(limit, measure)}`,
    expected,
    actual: (value) => (measure === 'time' ? printValue(value) : String(measured(value, measure))),
    test: (value) => (exclusive ? measured(value, measure) < limit : measured(value, measure) <= limit),
    json(schema) {
      if (measure === 'length') schema[schema.type === 'array' ? 'maxItems' : 'maxLength'] = limit;
      else if (measure === 'value') schema[exclusive ? 'exclusiveMaximum' : 'maximum'] = limit;
      else notConvertible('A Date bound');
    },
  };
}

export function exactLengthRefinement(length: number): Refinement {
  return {
    kind: 'exactLength',
    expression: `== ${length}`,
    expected: `exactly length ${length}`,
    actual: (value) => String((value as { length: number }).length),
    test: (value) => (value as { length: number }).length === length,
    json(schema) {
      const [min, max] = schema.type === 'array' ? ['minItems', 'maxItems'] : ['minLength', 'maxLength'];
      schema[min] = length;
      schema[max] = length;
    },
  };
}

export function divisorRefinement(divisor: number, expected?: string): Refinement {
  return {
    kind: 'divisor',
    expression: `% ${divisor}`,
    expected: expected ?? (divisor === 1 ? 'an integer' : divisor === 2 ? 'even' : `a multiple of ${divisor}`),
    actual: (value) => String(value),
    test: (value) => (value as number) % divisor === 0,
    json(schema) {
      schema.type = 'integer';
      if (divisor !== 1) schema.multipleOf = divisor;
    },
  };
}

export function patternRefinement(regex: RegExp, expected?: string, format?: string): Refinement {
  return {
    kind: 'pattern',
    expression: String(regex),
    expected: expected ?? `matched by ${regex.source}`,
    actual: (value) => printValue(value),
    test: (value) => {
      regex.lastIndex = 0;
      return regex.test(value as string);
    },
    json(schema) {
      if (schema.pattern !== undefined) {
        const all = (schema.allOf as JsonSchema[] | undefined) ?? [];
        all.push({ pattern: regex.source });
        schema.allOf = all;
      } else {
        schema.pattern = regex.source;
      }
      if (format) schema.format = format;
    },
  };
}

/** What a predicate (`.narrow()`, a keyword's check) sees as its second argument — ArkType's traversal context, the parts it uses. */
export interface TraversalContext {
  readonly path: readonly PathKey[];
  /** Reject with a description: `ctx.mustBe('a palindrome')` → "must be a palindrome (was …)". */
  mustBe(expected: string): false;
  /** Reject with a custom error. */
  reject(input: Partial<ArkErrorInput> | string): false;
  /** An error for a morph to return. */
  error(input: Partial<ArkErrorInput> | string): ArkError;
}

export type Predicate = (value: never, ctx: TraversalContext) => boolean;

export function predicateRefinement(predicate: Predicate, expected?: string, json?: (schema: JsonSchema) => void): Refinement {
  const description = expected ?? `valid according to ${predicate.name || 'an anonymous predicate'}`;
  return {
    kind: 'predicate',
    expression: `:${predicate.name || 'predicate'}`,
    expected: description,
    actual: (value) => printValue(value),
    test(value, ctx) {
      const own: ArkError[] = [];
      const ok = (predicate as (value: unknown, ctx: TraversalContext) => boolean)(value, traversalContext(ctx, own, value));
      return ok ? true : own.length > 0 ? own : false;
    },
    // A predicate has no JSON Schema: the schema describes what it can (the base).
    json(schema) {
      json?.(schema);
    },
  };
}

function errorInput(input: Partial<ArkErrorInput> | string): ArkErrorInput {
  return typeof input === 'string' ? { code: 'predicate', expected: input } : { code: 'predicate', ...input };
}

export function traversalContext(ctx: Ctx, sink: ArkError[], value: unknown): TraversalContext {
  // `path` in an error a predicate or morph writes is relative to the value it was given.
  const own = (input: Partial<ArkErrorInput> | string) => {
    const resolved = errorInput(input);
    return new ArkError({ actual: printValue(value), data: value, ...resolved, path: [...ctx.path, ...(resolved.path ?? [])] });
  };
  return {
    path: ctx.path,
    mustBe(expected) {
      sink.push(new ArkError({ code: 'predicate', expected, actual: printValue(value), path: ctx.path, data: value }));
      return false;
    },
    reject(input) {
      sink.push(own(input));
      return false;
    },
    error(input) {
      return own(input);
    },
  };
}

/** The order ArkType checks (and reports) a node's rules in: its `prestructuralKinds`, then predicates. */
const RULE_ORDER: Refinement['kind'][] = ['pattern', 'divisor', 'exactLength', 'max', 'min', 'maxLength', 'minLength', 'before', 'after', 'predicate'];

/** A base (a domain, `Date`, an array) and the rules its values also follow. */
export class RefinedNode extends Node {
  readonly kind = 'refined';
  override get basis(): string {
    return this.base.basis;
  }
  readonly refinements: readonly Refinement[];
  sortKey(): string {
    const base = this.base.sortKey().slice(2, -1);
    const rules = [...this.refinements].sort((a, b) => (a.kind < b.kind ? -1 : 1)).map((r) => `"${r.kind}":${JSON.stringify(r.expression)}`);
    return `1{${[base, ...rules].join(',')}}`;
  }
  constructor(
    readonly base: Node,
    refinements: readonly Refinement[],
    private readonly ownExpected?: string,
  ) {
    super();
    this.refinements = [...refinements].sort((a, b) => RULE_ORDER.indexOf(a.kind) - RULE_ORDER.indexOf(b.kind));
    (this as { morphs: boolean }).morphs = base.morphs;
  }
  get expression(): string {
    return [this.base.expression, ...this.refinements.map((r) => r.expression)].join(this.refinements.length > 1 ? ' & ' : ' ');
  }
  get expected(): string {
    return this.ownExpected ?? (this.refinements.length === 1 ? this.refinements[0]!.expected : this.refinements.map((r) => r.expected).join(' and '));
  }
  with(refinement: Refinement): RefinedNode {
    return new RefinedNode(this.base, [...this.refinements, refinement]);
  }
  run(value: unknown, ctx: Ctx): unknown {
    // An array's length is checked before its elements, and alone when it is wrong (as ArkType reports it).
    if ((this.base instanceof ArrayNode || this.base instanceof TupleNode) && Array.isArray(value)) {
      const reported = this.check(value, ctx);
      return reported === FAIL ? FAIL : this.base.run(value, ctx);
    }
    const out = this.base.run(value, ctx);
    if (out === FAIL) return FAIL;
    return this.check(out, ctx);
  }

  /** The rules on a value that passed the base: the value, or FAIL. */
  private check(out: unknown, ctx: Ctx): unknown {
    // The common case — every rule passes — allocates nothing.
    let passes = true;
    for (const refinement of this.refinements) {
      if (refinement.test(out, ctx) !== true) {
        passes = false;
        break;
      }
    }
    if (passes) return out;
    const failed: Refinement[] = [];
    // Errors a predicate wrote itself (`ctx.reject()`, `ctx.mustBe()`) stand as they are.
    const written: ArkError[] = [];
    for (const refinement of this.refinements) {
      const result = refinement.test(out, ctx);
      if (result === false) failed.push(refinement);
      else if (result !== true) written.push(...result);
    }
    ctx.errors.push(...written);
    if (failed.length === 0) return written.length > 0 ? FAIL : out;
    if (this.description) return ctx.fail({ code: failed[0]!.kind, expected: this.description, actual: printValue(out), data: out });
    if (failed.length === 1) {
      const [rule] = failed as [Refinement];
      return ctx.fail({ code: rule.kind, expected: rule.expected, actual: rule.actual(out), data: out });
    }
    return ctx.fail({
      code: 'intersection',
      expected: failed.map((r) => r.expected).join(' and '),
      problem: `(${printValue(out)}) must be...\n${failed.map((r) => `  ◦ ${r.expected}`).join('\n')}`,
      data: out,
    });
  }
  domain(): Domain | null {
    return this.base.domain();
  }
  jsonOf(js: JsonContext): JsonSchema {
    const schema = this.base.json(js);
    for (const refinement of this.refinements) refinement.json(schema, js);
    return schema;
  }
}

// ── Composites ──────────────────────────────────────────────────────────

/** A shallow copy that keeps what the value is: an array, a Date, an instance of a class. */
function copyOf<T extends object>(source: T): T {
  if (Array.isArray(source)) return [...source] as T;
  const base = source instanceof Date ? new Date(source.valueOf()) : Object.create(Object.getPrototypeOf(source));
  return Object.assign(base, source) as T;
}

/** Copy-on-write: the container is copied once, the first time a child gives back something else — the input is never changed. */
class Writer<T extends object> {
  private copy: T | null = null;
  constructor(private readonly source: T) {}
  set(key: PropertyKey, value: unknown): void {
    this.copy ??= copyOf(this.source);
    (this.copy as Record<PropertyKey, unknown>)[key] = value;
  }
  delete(key: PropertyKey): void {
    this.copy ??= copyOf(this.source);
    delete (this.copy as Record<PropertyKey, unknown>)[key];
  }
  get result(): T {
    return this.copy ?? this.source;
  }
}

export class ArrayNode extends Node {
  readonly kind = 'array';
  override get basis(): string {
    return 'an array';
  }
  sortKey(): string {
    return this.element instanceof UnknownNode ? '2{"proto":"Array"}' : `1{"sequence":${valueKey(this.element)},"proto":"Array"}`;
  }
  readonly expected = 'an array';
  constructor(readonly element: Node) {
    super();
    (this as { morphs: boolean }).morphs = element.morphs;
  }
  get expression(): string {
    const inner = this.element.expression;
    return /[|& ]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
  }
  run(value: unknown, ctx: Ctx): unknown {
    if (!Array.isArray(value)) return ctx.fail({ code: 'proto', expected: expectedOf(this), actual: describeForProto(value), data: value });
    let copy: unknown[] | null = null;
    let failed = false;
    for (let i = 0; i < value.length; i++) {
      ctx.path.push(i);
      const out = this.element.run(value[i], ctx);
      ctx.path.pop();
      if (out === FAIL) failed = true;
      else if (out !== value[i]) (copy ??= [...value])[i] = out;
    }
    return failed ? FAIL : (copy ?? value);
  }
  domain(): Domain {
    return 'object';
  }
  jsonOf(js: JsonContext): JsonSchema {
    return this.element instanceof UnknownNode ? { type: 'array' } : { type: 'array', items: this.element.json(js) };
  }
}

/** `[string, number]`, `[string, number?]`, `[string, ...number[]]`. */
export class TupleNode extends Node {
  readonly kind = 'tuple';
  override get basis(): string {
    return 'an array';
  }
  sortKey(): string {
    return `1{"sequence":{"prefix":[${[...this.required, ...this.optional].map(valueKey).join(',')}]},"proto":"Array"}`;
  }
  readonly expected = 'an array';
  constructor(
    readonly required: readonly Node[],
    readonly optional: readonly Node[],
    readonly rest: Node | null,
  ) {
    super();
    (this as { morphs: boolean }).morphs = [...required, ...optional].some((n) => n.morphs) || Boolean(rest?.morphs);
  }
  get expression(): string {
    const items = [...this.required.map((n) => n.expression), ...this.optional.map((n) => `${n.expression}?`)];
    if (this.rest) items.push(`...${new ArrayNode(this.rest).expression}`);
    return `[${items.join(', ')}]`;
  }
  run(value: unknown, ctx: Ctx): unknown {
    if (!Array.isArray(value)) return ctx.fail({ code: 'proto', expected: 'an array', actual: describeForProto(value), data: value });
    const fixed = [...this.required, ...this.optional];
    const min = this.required.length;
    const max = this.rest ? Number.POSITIVE_INFINITY : fixed.length;
    if (value.length < min || value.length > max) {
      const [code, expected] =
        min === max
          ? ['exactLength', `exactly length ${min}`]
          : value.length < min
            ? ['minLength', min === 1 ? 'non-empty' : `at least length ${min}`]
            : ['maxLength', `at most length ${max}`];
      return ctx.fail({ code, expected, actual: code === 'minLength' && value.length === 0 ? null : String(value.length), data: value });
    }
    const writer = new Writer(value);
    let failed = false;
    for (let i = 0; i < value.length; i++) {
      const node = i < fixed.length ? fixed[i]! : this.rest;
      if (!node) break;
      ctx.path.push(i);
      const out = node.run(value[i], ctx);
      ctx.path.pop();
      if (out === FAIL) failed = true;
      else if (out !== value[i]) writer.set(i, out);
    }
    return failed ? FAIL : writer.result;
  }
  domain(): Domain {
    return 'object';
  }
  jsonOf(js: JsonContext): JsonSchema {
    const items = [...this.required, ...this.optional].map((n) => n.json(js));
    const rest = this.rest ? this.rest.json(js) : false;
    if (items.length === 0 && !this.rest) return { type: 'array', minItems: 0, maxItems: 0 };
    if (js.target === 'draft-07') return { type: 'array', minItems: this.required.length, items, additionalItems: rest };
    return { type: 'array', minItems: this.required.length, prefixItems: items, items: rest };
  }
}

export interface Prop {
  key: string;
  value: Node;
  kind: 'required' | 'optional';
  /** A default: the key is optional going in, and the value is set when it is missing. */
  default?: { value: unknown };
}

export interface IndexSignature {
  key: Node;
  value: Node;
}

const byKey = (a: Prop, b: Prop) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export class ObjectNode extends Node {
  readonly kind = 'object';
  override get basis(): string {
    return 'an object';
  }
  sortKey(): string {
    const entries = (props: readonly Prop[]) => props.map((p) => `{"key":${JSON.stringify(p.key)},"value":${valueKey(p.value)}}`).join(',');
    const required = this.props.filter((p) => p.kind === 'required');
    const optional = this.props.filter((p) => p.kind === 'optional');
    const parts = [
      ...(required.length > 0 ? [`"required":[${entries(required)}]`] : []),
      ...(optional.length > 0 ? [`"optional":[${entries(optional)}]`] : []),
      ...(this.index.length > 0 ? [`"index":[${this.index.map((i) => valueKey(i.key)).join(',')}]`] : []),
    ];
    return parts.length === 0 ? '0{"domain":"object"}' : `1{${parts.join(',')},"domain":"object"}`;
  }
  readonly expected = 'an object';
  /** Required keys, then optional ones, each sorted — the order ArkType checks and prints them in. */
  readonly props: readonly Prop[];
  private readonly declared: ReadonlySet<string>;

  constructor(
    props: readonly Prop[],
    readonly index: readonly IndexSignature[] = [],
    readonly undeclared?: 'ignore' | 'reject' | 'delete',
  ) {
    super();
    const required = props.filter((p) => p.kind === 'required').sort(byKey);
    const optional = props.filter((p) => p.kind === 'optional').sort(byKey);
    this.props = [...required, ...optional];
    this.declared = new Set(this.props.map((p) => p.key));
    (this as { morphs: boolean }).morphs =
      this.props.some((p) => p.default || p.value.morphs) || index.some((i) => i.value.morphs) || undeclared === 'delete';
  }

  get expression(): string {
    const entries = this.props.map((p) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(p.key) ? p.key : JSON.stringify(p.key);
      if (p.default) return `${key}: ${p.value.expression} = ${printValue(p.default.value)}`;
      return `${key}${p.kind === 'optional' ? '?' : ''}: ${p.value.expression}`;
    });
    for (const sig of this.index) entries.push(`[${sig.key.expression}]: ${sig.value.expression}`);
    if (entries.length === 0) return '{}';
    return `{ ${entries.join(', ')} }`;
  }

  get(key: string): Prop | undefined {
    return this.props.find((p) => p.key === key);
  }

  private readonly orUndefined = new Map<Prop, Node>();

  /** An optional key's value where it admits `undefined` (`exactOptionalPropertyTypes: false`): `value | undefined`. */
  private valueOf(prop: Prop, config: TypeConfig): Node {
    if (prop.kind !== 'optional' || prop.default || config.exactOptionalPropertyTypes) return prop.value;
    let node = this.orUndefined.get(prop);
    if (!node) {
      const branches = prop.value instanceof UnionNode && !prop.value.description ? [...prop.value.branches] : [prop.value];
      if (!branches.some((b) => b instanceof UnitNode && b.value === undefined)) branches.push(new UnitNode(undefined));
      this.orUndefined.set(prop, (node = new UnionNode(branches, true)));
    }
    return node;
  }

  run(value: unknown, ctx: Ctx): unknown {
    if (domainOf(value) !== 'object') return ctx.fail({ code: 'domain', expected: expectedOf(this), actual: describeDomain(value, true), data: value });
    const source = value as Record<string, unknown>;
    let writer: Writer<Record<string, unknown>> | null = null;
    let failed = false;
    for (const prop of this.props) {
      ctx.path.push(prop.key);
      if (!(prop.key in source)) {
        if (prop.default) {
          const fallback = prop.default.value;
          (writer ??= new Writer(source)).set(prop.key, typeof fallback === 'function' ? (fallback as () => unknown)() : fallback);
        } else if (prop.kind === 'required') {
          ctx.fail({ code: 'required', expected: prop.value.basis, actual: 'missing' });
          failed = true;
        }
      } else {
        const item = source[prop.key];
        const out = this.valueOf(prop, ctx.config).run(item, ctx);
        if (out === FAIL) failed = true;
        else if (out !== item) (writer ??= new Writer(source)).set(prop.key, out);
      }
      ctx.path.pop();
    }
    const undeclared = this.undeclared ?? ctx.config.onUndeclaredKey;
    if (this.index.length > 0 || undeclared !== 'ignore') {
      for (const key of Object.keys(source)) {
        if (this.declared.has(key)) continue;
        const signature = this.index.find((sig) => sig.key.allows(key, ctx.config));
        ctx.path.push(key);
        if (signature) {
          const out = signature.value.run(source[key], ctx);
          if (out === FAIL) failed = true;
          else if (out !== source[key]) (writer ??= new Writer(source)).set(key, out);
        } else if (undeclared === 'reject') {
          ctx.fail({ code: 'predicate', expected: 'removed', problem: 'must be removed' });
          failed = true;
        } else if (undeclared === 'delete') {
          (writer ??= new Writer(source)).delete(key);
        }
        ctx.path.pop();
      }
    }
    return failed ? FAIL : (writer?.result ?? source);
  }

  domain(): Domain {
    return 'object';
  }

  jsonOf(js: JsonContext): JsonSchema {
    const schema: JsonSchema = { type: 'object' };
    if (this.props.length > 0) {
      const properties: Record<string, JsonSchema> = {};
      for (const prop of this.props) {
        const value = this.valueOf(prop, js.config).json(js);
        properties[prop.key] = prop.default ? { ...value, default: prop.default.value } : value;
      }
      schema.properties = properties;
      // An output has its defaulted keys; an input may leave them out.
      const required = this.props.filter((p) => p.kind === 'required' || (js.side === 'out' && p.default)).map((p) => p.key);
      if (required.length > 0) schema.required = required;
    }
    for (const sig of this.index) {
      if (sig.key instanceof DomainNode && sig.key.name === 'string') schema.additionalProperties = sig.value.json(js);
      else if (sig.key instanceof RefinedNode && sig.key.refinements.every((r) => r.kind === 'pattern')) {
        const patterns = (schema.patternProperties as Record<string, JsonSchema> | undefined) ?? {};
        for (const r of sig.key.refinements) patterns[r.expression.slice(1, r.expression.lastIndexOf('/'))] = sig.value.json(js);
        schema.patternProperties = patterns;
      } else notConvertible(`An index signature of ${sig.key.expression}`);
    }
    if ((this.undeclared ?? js.config.onUndeclaredKey) !== 'ignore' && this.index.length === 0) schema.additionalProperties = false;
    return schema;
  }
}


/** `boolean`: `false | true`, printed as `boolean` on its own (in a larger union it is its two units). */
export class BooleanNode extends Node {
  readonly kind = 'boolean';
  override get basis(): string {
    return 'boolean';
  }
  readonly expression = 'boolean';
  readonly expected = 'boolean';
  readonly units = [new UnitNode(false), new UnitNode(true)];
  sortKey(): string {
    return '3{"unit":false}';
  }
  run(value: unknown, ctx: Ctx): unknown {
    if (typeof value === 'boolean') return value;
    return ctx.fail({ code: 'domain', expected: expectedOf(this), actual: printValue(value), data: value });
  }
  domain(): Domain {
    return 'boolean';
  }
  jsonOf(): JsonSchema {
    return { type: 'boolean' };
  }
}

export class UnionNode extends Node {
  readonly kind = 'union';
  override get basis(): string {
    return joinOr(this.shown.map((b) => b.basis));
  }
  sortKey(): string {
    return `4${this.shown.map((b) => b.sortKey()).join('|')}`;
  }
  /** The branches in the order a value is tried against them; `shown` is ArkType's display order. */
  private readonly shown: readonly Node[];
  constructor(
    readonly branches: readonly Node[],
    /** An optional key's `value | undefined`: its value is printed as itself in a message (`(was 7)`), as ArkType does. */
    private readonly optionalValue = false,
  ) {
    super();
    this.shown = [...branches].sort((a, b) => (a.sortKey() < b.sortKey() ? -1 : a.sortKey() > b.sortKey() ? 1 : 0));
    (this as { morphs: boolean }).morphs = branches.some((b) => b.morphs);
  }
  get expression(): string {
    return this.shown.map((b) => b.expression).join(' | ');
  }
  get expected(): string {
    return joinOr(this.shown.map(expectedOf));
  }
  run(value: unknown, ctx: Ctx): unknown {
    // Only branches of the value's domain can take it: the others are tried (for their errors) only to report a failure.
    const domain = domainOf(value);
    for (const branch of this.branches) {
      const branchDomain = branch.domain();
      if (branchDomain !== null && branchDomain !== domain) continue;
      // Tried in place: a failed branch's errors are dropped again.
      const mark = ctx.errors.length;
      const out = branch.run(value, ctx);
      if (out !== FAIL) return out;
      ctx.errors.length = mark;
    }
    const attempts = this.branches.map((branch) => {
      const scratch = ctx.scratch();
      branch.run(value, scratch);
      return { branch, ctx: scratch };
    });
    return this.report(value, ctx, attempts);
  }

  private report(value: unknown, ctx: Ctx, attempts: Array<{ branch: Node; ctx: Ctx }>): typeof FAIL {
    if (this.description) {
      // A value of a domain no branch has is named by its domain: `(was a number)` for a UUID.
      const known = this.branches.some((b) => b.domain() === domainOf(value));
      return ctx.fail({ code: 'union', expected: this.description, actual: known ? printValue(value) : describeDomain(value, true), data: value });
    }
    // Objects told apart by a literal key (`kind: 'a'` | `kind: 'b'`): the key's problem, or the matching branch's.
    const discriminant = this.discriminant();
    if (discriminant) {
      const { key, values } = discriminant;
      const item = domainOf(value) === 'object' ? (value as Record<string, unknown>)[key] : undefined;
      const matched = attempts.find((_, i) => values[i]!.some((v) => v === item));
      if (matched) return push(ctx, matched.ctx);
      return ctx.fail({
        code: 'union',
        path: [key],
        expected: joinOr(values.flat().map(printValue)),
        actual: printValue(item),
        data: item,
      });
    }
    // One branch of the value's domain: its problem.
    const domain = domainOf(value);
    const sameDomain = attempts.filter(({ branch }) => {
      const d = branch.domain();
      return d === domain && !(branch instanceof UnitNode);
    });
    if (sameDomain.length === 1) return push(ctx, sameDomain[0]!.ctx);
    if (sameDomain.length > 1) {
      const order = (n: Node) => this.shown.indexOf(n);
      // Each branch's errors with their own paths (`to.email must be … or to must be non-empty`), as ArkType writes them.
      const messages = [...sameDomain]
        .sort((a, b) => order(a.branch) - order(b.branch))
        .map(({ ctx: attempt }) => attempt.errors.map((e) => e.message).join(' and '))
        .join(' or ');
      return ctx.fail({ code: 'union', expected: this.expected, problem: messages, message: messages, data: value });
    }
    const allUnits = this.branches.every((b) => b instanceof UnitNode);
    // Branches of one domain read as that domain's check (`(was NaN)`); of several, as a list of domains (`(was a number)`).
    const actual = allUnits || this.optionalValue ? printValue(value) : describeDomain(value, this.domain() !== null);
    return ctx.fail({ code: 'union', expected: this.expected, actual, data: value });
  }

  /** A required key every branch (an object) declares as a literal, a different one in each. */
  private discriminant(): { key: string; values: unknown[][] } | null {
    if (this.branches.length < 2 || !this.branches.every((b) => b instanceof ObjectNode)) return null;
    const objects = this.branches as ObjectNode[];
    for (const prop of objects[0]!.props) {
      if (prop.kind !== 'required') continue;
      const values = objects.map((o) => literals(o.get(prop.key)));
      if (values.every((v) => v !== null)) {
        const flat = values.flat();
        if (new Set(flat).size === flat.length) return { key: prop.key, values: values as unknown[][] };
      }
    }
    return null;
  }

  domain(): Domain | null {
    const domains = new Set(this.branches.map((b) => b.domain()));
    return domains.size === 1 ? [...domains][0]! : null;
  }

  jsonOf(js: JsonContext): JsonSchema {
    if (this.shown.every((b) => b instanceof UnitNode && b.value !== null && !b.meta && !b.description)) {
      const values = (this.shown as UnitNode[]).map((b) => b.value);
      if (values.length === 2 && values.includes(true) && values.includes(false)) return { type: 'boolean' };
      for (const v of values) unitJson(v, js);
      return values.length === 1 ? { const: values[0] } : { enum: values };
    }
    // `false` and `true` among other branches are one `boolean`, where `false` sorts.
    const schemas: JsonSchema[] = [];
    const isBool = (b: Node) => b instanceof UnitNode && typeof b.value === 'boolean' && !b.meta && !b.description;
    const both = this.shown.filter(isBool).length === 2;
    for (const branch of this.shown) {
      if (both && isBool(branch)) {
        if ((branch as UnitNode).value === false) schemas.push({ type: 'boolean' });
      } else schemas.push(branch.json(js));
    }
    return { anyOf: schemas };
  }
}

function literals(prop: Prop | undefined): unknown[] | null {
  if (!prop || prop.kind !== 'required') return null;
  const node = prop.value;
  if (node instanceof UnitNode) return [node.value];
  if (node instanceof UnionNode && node.branches.every((b) => b instanceof UnitNode)) return (node.branches as UnitNode[]).map((b) => b.value);
  return null;
}

function push(ctx: Ctx, from: Ctx): typeof FAIL {
  ctx.errors.push(...from.errors);
  return FAIL;
}

/** Both sides: a value passes the left, then what it became passes the right. */
export class IntersectionNode extends Node {
  readonly kind = 'intersection';
  sortKey(): string {
    return `1${this.members.map((m) => m.sortKey()).join('&')}`;
  }
  constructor(readonly members: readonly Node[]) {
    super();
    (this as { morphs: boolean }).morphs = members.some((m) => m.morphs);
  }
  get expression(): string {
    return this.members.map((m) => m.expression).join(' & ');
  }
  get expected(): string {
    return this.members.map(expectedOf).join(' and ');
  }
  run(value: unknown, ctx: Ctx): unknown {
    let out = value;
    let failed = false;
    for (const member of this.members) {
      const next = member.run(out, ctx);
      if (next === FAIL) failed = true;
      else out = next;
    }
    return failed ? FAIL : out;
  }
  domain(): Domain | null {
    for (const m of this.members) {
      const d = m.domain();
      if (d) return d;
    }
    return null;
  }
  jsonOf(js: JsonContext): JsonSchema {
    return { allOf: this.members.map((m) => m.json(js)) };
  }
}

export type Morph = (value: never, ctx: TraversalContext) => unknown;

/** A value that passes `input` becomes what `morph` returns, checked against `output` when there is one. */
export class MorphNode extends Node {
  readonly kind = 'morph';
  override get basis(): string {
    return this.input.basis;
  }
  sortKey(): string {
    return `5${this.input.sortKey()}`;
  }
  readonly morphs = true;
  constructor(
    readonly input: Node,
    readonly morph: Morph | null,
    readonly output: Node | null,
    /** False for a keyword's declared output (`string.trim` → trimmed): its JSON Schema, never checked. */
    readonly checkOutput = true,
  ) {
    super();
  }
  get expression(): string {
    return `(In: ${this.input.expression}) => Out<${this.output?.expression ?? 'unknown'}>`;
  }
  get expected(): string {
    return expectedOf(this.input);
  }
  run(value: unknown, ctx: Ctx): unknown {
    const input = this.input.run(value, ctx);
    if (input === FAIL) return FAIL;
    let out = input;
    if (this.morph) {
      const own: ArkError[] = [];
      out = (this.morph as (value: unknown, ctx: TraversalContext) => unknown)(input, traversalContext(ctx, own, input));
      if (out instanceof ArkError) own.push(out);
      else if (Array.isArray(out) && out.length > 0 && out.every((e) => e instanceof ArkError)) own.push(...(out as ArkError[]));
      if (own.length > 0) {
        ctx.errors.push(...own);
        return FAIL;
      }
    }
    return this.output && this.checkOutput ? this.output.run(out, ctx) : out;
  }
  domain(): Domain | null {
    return this.input.domain();
  }
  jsonOf(js: JsonContext): JsonSchema {
    if (js.side === 'in') return this.input.json(js);
    if (this.output) return this.output.json(js);
    return notConvertible(`The output of ${this.input.expression}`);
  }
}

/** A Standard Schema from elsewhere — a real ArkType Type, Zod, Valibot, another copy of this package. */
export class StandardNode extends Node {
  readonly kind = 'standard';
  sortKey(): string {
    return `6${this.expression}`;
  }
  readonly morphs = true;
  readonly expression: string;
  readonly expected: string;
  constructor(readonly schema: StandardSchemaLike) {
    super();
    const named = schema as { expression?: unknown; description?: unknown };
    this.expression = typeof named.expression === 'string' ? named.expression : schema['~standard'].vendor;
    this.expected = typeof named.description === 'string' ? named.description : 'valid';
  }
  run(value: unknown, ctx: Ctx): unknown {
    const result = this.schema['~standard'].validate(value);
    if (result instanceof Promise) throw new TypeError(`[durable-db] ${this.schema['~standard'].vendor} schema validates asynchronously; a definition can only nest synchronous schemas`);
    if (!result.issues) return result.value;
    for (const issue of result.issues) {
      const path = (issue.path ?? []).map((p) => (typeof p === 'object' && p !== null ? (p as { key: PathKey }).key : p));
      ctx.fail({ code: 'predicate', path, problem: issue.message });
    }
    return FAIL;
  }
  jsonOf(js: JsonContext): JsonSchema {
    const converter = this.schema['~standard'].jsonSchema;
    if (!converter) return notConvertible(`A ${this.schema['~standard'].vendor} schema`);
    const schema = converter[js.side === 'in' ? 'input' : 'output']({ target: js.target });
    const { $schema: _dialect, ...rest } = schema as JsonSchema;
    return rest;
  }
}

export interface StandardSchemaLike {
  '~standard': {
    version: 1;
    vendor: string;
    validate(value: unknown): { value?: unknown; issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PathKey | { key: PathKey }> }> } | Promise<unknown>;
    jsonSchema?: {
      input(options: { target: string }): Record<string, unknown>;
      output(options: { target: string }): Record<string, unknown>;
    };
  };
}

export function isStandardSchema(value: unknown): value is StandardSchemaLike {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && '~standard' in value;
}

/** A Type made with other rules, nested in this one: it validates as it would on its own. */
export class ConfiguredNode extends Node {
  readonly kind = 'configured';
  override get basis(): string {
    return this.inner.basis;
  }
  constructor(
    readonly inner: Node,
    readonly config: TypeConfig,
  ) {
    super();
    (this as { morphs: boolean }).morphs = inner.morphs;
  }
  get expression(): string {
    return this.inner.expression;
  }
  get expected(): string {
    return expectedOf(this.inner);
  }
  sortKey(): string {
    return this.inner.sortKey();
  }
  run(value: unknown, ctx: Ctx): unknown {
    const outer = ctx.config;
    ctx.config = this.config;
    try {
      return this.inner.run(value, ctx);
    } finally {
      ctx.config = outer;
    }
  }
  domain(): Domain | null {
    return this.inner.domain();
  }
  jsonOf(js: JsonContext): JsonSchema {
    return this.inner.json({ ...js, config: this.config });
  }
}
