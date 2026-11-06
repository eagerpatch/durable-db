// `durable-db/type`: ArkType's `type()` — the same definitions, the same
// inferred types and editor errors (its own type-level parser, imported as
// types only), the same error messages — on a small runtime that builds
// nothing until a definition is parsed. ArkType initialises its whole scope of
// keywords when it is imported (~40 ms of CPU in a worker's cold start, every
// isolate, every Durable Object); this parses a definition into plain
// closures in microseconds.
//
// The Types it returns are callable like ArkType's (`T(data)` → the value or
// `ArkErrors`), Standard Schemas (oRPC, any `~standard` consumer) with their
// JSON Schema, and nest in each other and in ArkType's own definitions.
// ArkType's scopes, generics, `match` and `fn` are not here; a definition it
// does not know fails with a ParseError naming it.
import type { distill, Out, type as ark } from 'arktype';
import { ArkError, ArkErrors, TraversalError, arkErrors } from './errors';
import {
  ArrayNode,
  ConfiguredNode,
  Ctx,
  DEFAULT_CONFIG,
  FAIL,
  type JsonContext,
  type JsonSchema,
  MorphNode,
  type Morph,
  type Node,
  ObjectNode,
  type Predicate,
  type Prop as PropNode,
  type TraversalContext,
  type TypeConfig,
  RefinedNode,
  UnitNode,
  divisorRefinement,
  expectedOf,
  patternRefinement,
  predicateRefinement,
} from './nodes';
import { ParseError, bound, describe, intersect, keyofNode, mergeProps, parseDefinition, refine, union, withRule, type Comparator, type ParseContext } from './parse';

export { ArkError, ArkErrors, TraversalError, ParseError };
export { ToJsonSchemaError } from './nodes';
export type { JsonSchema, TraversalContext, TypeConfig };

// ── Types ───────────────────────────────────────────────────────────────

export interface TypeMeta {
  description?: string;
  expected?: string;
}

export interface ToJsonSchemaOptions {
  target?: 'draft-2020-12' | 'draft-07';
  /** Leave `$schema` out (for a schema nested in another document). */
  dialect?: null;
}

export interface Prop<t = unknown> {
  readonly key: string;
  readonly kind: 'required' | 'optional';
  readonly value: Type<t>;
}

type merged<base, props> = Omit<base, keyof props> & props extends infer o ? { [k in keyof o]: o[k] } : never;

/** What a Standard Schema consumer reads (https://standardschema.dev), with its JSON Schema converter. */
export interface StandardProps<input, output> {
  readonly version: 1;
  readonly vendor: string;
  validate(value: unknown): { readonly value: output; readonly issues?: undefined } | { readonly issues: readonly ArkError[] };
  readonly types?: { readonly input: input; readonly output: output };
  readonly jsonSchema: {
    input(options: { readonly target: string }): Record<string, unknown>;
    output(options: { readonly target: string }): Record<string, unknown>;
  };
}

/**
 * A validator: call it with a value for the value (or what a morph makes of
 * it) or an `ArkErrors`. `t` is ArkType's own representation of what it
 * accepts and gives back, so ArkType's types read it as one of theirs.
 */
export interface Type<t = unknown> extends ark.cast<t> {
  (data: unknown): distill.Out<t> | ArkErrors;
  /** What it gives back (`typeof User.infer`). */
  readonly infer: distill.Out<t>;
  readonly inferIn: distill.In<t>;
  readonly inferOut: distill.Out<t>;
  readonly t: t;
  readonly expression: string;
  /** What a value must be, as its messages say it: `a string`, `non-negative`. */
  readonly description: string;
  readonly json: JsonSchema;
  toJsonSchema(options?: ToJsonSchemaOptions): JsonSchema;
  assert(data: unknown): distill.Out<t>;
  allows(data: unknown): data is distill.In<t>;
  from(data: distill.In<t>): distill.Out<t>;
  array(): Type<t[]>;
  or<const def, r = Type<t | ark.infer<def>>>(def: ark.validate<def>): r extends infer _ ? _ : never;
  and<const def, r = Type<t & ark.infer<def>>>(def: ark.validate<def>): r extends infer _ ? _ : never;
  merge<const def, r = Type<merged<t, ark.infer<def>>>>(def: ark.validate<def>): r extends infer _ ? _ : never;
  pick<const k extends keyof t & string>(...keys: k[]): Type<Pick<t, k>>;
  omit<const k extends keyof t & string>(...keys: k[]): Type<Omit<t, k>>;
  partial(): Type<Partial<t>>;
  required(): Type<Required<t>>;
  keyof(): Type<keyof t & string>;
  get<const k extends keyof t & string>(key: k): Type<t[k]>;
  /** As an object's value: the key may be left out. */
  optional(): [this, '?'];
  /** As an object's value: the key may be left out, and gets `value`. */
  default<const v extends distill.Out<t> | (() => distill.Out<t>)>(value: v): [this, '=', v];
  narrow(predicate: (data: distill.Out<t>, ctx: TraversalContext) => boolean): Type<t>;
  pipe<r>(morph: (data: distill.Out<t>, ctx: TraversalContext) => r): Type<(In: distill.In<t>) => Out<Exclude<r, ArkError | ArkErrors>>>;
  to<const def, r = Type<(In: distill.In<t>) => Out<ark.infer.Out<def>>>>(def: ark.validate<def>): r extends infer _ ? _ : never;
  describe(description: string): Type<t>;
  configure(meta: TypeMeta): Type<t>;
  brand<const id extends string>(id: id): Type<ark.brand<t, id>>;
  onUndeclaredKey(behavior: 'ignore' | 'reject' | 'delete'): Type<t>;
  // Bounds, as ArkType's number, string, array and Date Types have them.
  atLeast(limit: number): Type<t>;
  atMost(limit: number): Type<t>;
  moreThan(limit: number): Type<t>;
  lessThan(limit: number): Type<t>;
  divisibleBy(divisor: number): Type<t>;
  atLeastLength(length: number): Type<t>;
  atMostLength(length: number): Type<t>;
  moreThanLength(length: number): Type<t>;
  lessThanLength(length: number): Type<t>;
  exactlyLength(length: number): Type<t>;
  matching(regex: RegExp | string): Type<t>;
  laterThan(date: Date | number | string): Type<t>;
  earlierThan(date: Date | number | string): Type<t>;
  atOrAfter(date: Date | number | string): Type<t>;
  atOrBefore(date: Date | number | string): Type<t>;
  readonly props: readonly Prop[];
  readonly '~standard': StandardProps<distill.In<t>, distill.Out<t>>;
}

export interface TypeParser {
  /**
   * A Type from a definition: `type({ name: 'string', 'age?': 'number.integer >= 0' })`.
   * (`r … extends infer _`, as ArkType's own signature has it: a call written
   * where a definition is expected — `action({ args: type({…}) })` — would
   * otherwise infer its `def` from that context, and its type collapse to never.)
   */
  <const def, r = Type<ark.infer<def>>>(def: ark.validate<def>): r extends infer _ ? _ : never;
  /** The class of what an invalid value gives back: `if (out instanceof type.errors)`. */
  readonly errors: typeof ArkErrors;
  /** A Type from a definition, with no type-level checking or inference. */
  raw(def: unknown): Type<any>;
  /** Exactly `value` (===). */
  unit<const t>(value: t): Type<t>;
  /** Exactly one of `values` (===). */
  enumerated<const values extends readonly unknown[]>(...values: values): Type<values[number]>;
  or<const a, const b, r = Type<ark.infer<a> | ark.infer<b>>>(a: ark.validate<a>, b: ark.validate<b>): r extends infer _ ? _ : never;
  and<const a, const b, r = Type<ark.infer<a> & ark.infer<b>>>(a: ark.validate<a>, b: ark.validate<b>): r extends infer _ ? _ : never;
}

// ── Runtime ─────────────────────────────────────────────────────────────

const NODE = Symbol('durable-db/type: node');
const CONFIG = Symbol('durable-db/type: config');

interface Internals {
  [NODE]: Node;
  [CONFIG]: TypeConfig;
  (data: unknown): unknown;
}

const contexts = new WeakMap<TypeConfig, ParseContext>();

/** How Types made with `config` read a nested Type: as itself, or with its own rules when they are not these. */
function contextFor(config: TypeConfig): ParseContext {
  let ctx = contexts.get(config);
  if (!ctx) {
    ctx = {
      unwrap(value) {
        if (typeof value !== 'function' || !(NODE in value)) return null;
        const nested = value as Internals;
        return nested[CONFIG] === config ? nested[NODE] : new ConfiguredNode(nested[NODE], nested[CONFIG]);
      },
    };
    contexts.set(config, ctx);
  }
  return ctx;
}

const isOwnType = (value: unknown): value is Internals => typeof value === 'function' && NODE in value;

function run(node: Node, config: TypeConfig, data: unknown): unknown {
  const ctx = new Ctx(config);
  const out = node.run(data, ctx);
  return out === FAIL ? arkErrors(ctx.errors) : out;
}

const DIALECTS = {
  'draft-2020-12': 'https://json-schema.org/draft/2020-12/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
} as const;

function jsonSchema(node: Node, config: TypeConfig, side: JsonContext['side'], options: ToJsonSchemaOptions = {}): JsonSchema {
  const target = options.target ?? 'draft-2020-12';
  const schema = node.json({ side, target, config });
  if (node.description && schema.description === undefined) schema.description = node.description;
  return options.dialect === null ? schema : { $schema: DIALECTS[target], ...schema };
}

/** A bound on what the node measures — a number's value, a length, a Date's time — or a TypeError when it measures something else. */
function bounded(t: Internals, comparator: Comparator, limit: number, measure: 'value' | 'length' | 'time'): Type<any> {
  const node = t[NODE];
  const out = bound(node, comparator, limit, node.expression);
  const kinds = { value: ['min', 'max'], length: ['minLength', 'maxLength', 'exactLength'], time: ['after', 'before'] }[measure];
  const added = out instanceof RefinedNode ? out.refinements.filter((r) => !(node instanceof RefinedNode && node.refinements.includes(r))) : [];
  if (!added.every((r) => kinds.includes(r.kind))) throw new TypeError(`This bound needs ${measure === 'value' ? 'a number' : measure === 'length' ? 'a string or an array' : 'a Date'} (was ${node.expression})`);
  return makeType(out, t[CONFIG]);
}

function objectNode(t: Internals, method: string): ObjectNode {
  const node = t[NODE];
  if (!(node instanceof ObjectNode)) throw new TypeError(`.${method}() needs an object Type (was ${node.expression})`);
  return node;
}

function withProps(t: Internals, props: PropNode[]): Type<any> {
  const node = objectNode(t, 'props');
  return makeType(new ObjectNode(props, node.index, node.undeclared), t[CONFIG]);
}

const prototype: ThisType<Internals> & Record<string, unknown> = {
  get expression() {
    return this[NODE].expression;
  },
  get description() {
    return expectedOf(this[NODE]);
  },
  get json() {
    return jsonSchema(this[NODE], this[CONFIG], 'in', { dialect: null });
  },
  toJsonSchema(options?: ToJsonSchemaOptions) {
    return jsonSchema(this[NODE], this[CONFIG], 'in', options);
  },
  assert(data: unknown) {
    const out = this(data);
    if (out instanceof ArkErrors) throw new TraversalError(out);
    return out;
  },
  allows(data: unknown) {
    return this[NODE].allows(data, this[CONFIG]);
  },
  from(data: unknown) {
    return (this as unknown as { assert(data: unknown): unknown }).assert(data);
  },
  array() {
    return makeType(new ArrayNode(this[NODE]), this[CONFIG]);
  },
  or(def: unknown) {
    return makeType(union([this[NODE], parseDefinition(def, contextFor(this[CONFIG]))]), this[CONFIG]);
  },
  and(def: unknown) {
    return makeType(intersect(this[NODE], parseDefinition(def, contextFor(this[CONFIG]))), this[CONFIG]);
  },
  merge(def: unknown) {
    const node = objectNode(this, 'merge');
    const other = parseDefinition(def, contextFor(this[CONFIG]));
    if (!(other instanceof ObjectNode)) throw new TypeError(`.merge() needs an object (was ${other.expression})`);
    return makeType(new ObjectNode(mergeProps(node.props, other.props), [...node.index, ...other.index], other.undeclared ?? node.undeclared), this[CONFIG]);
  },
  pick(...keys: string[]) {
    return withProps(this, objectNode(this, 'pick').props.filter((p) => keys.includes(p.key)));
  },
  omit(...keys: string[]) {
    return withProps(this, objectNode(this, 'omit').props.filter((p) => !keys.includes(p.key)));
  },
  partial() {
    return withProps(this, objectNode(this, 'partial').props.map((p) => ({ ...p, kind: 'optional' as const })));
  },
  required() {
    return withProps(this, objectNode(this, 'required').props.map(({ default: _default, ...p }) => ({ ...p, kind: 'required' as const })));
  },
  keyof() {
    return makeType(keyofNode(this[NODE]), this[CONFIG]);
  },
  get(key: string) {
    const prop = objectNode(this, 'get').get(key);
    if (!prop) throw new TypeError(`${this[NODE].expression} has no key ${JSON.stringify(key)}`);
    return makeType(prop.value, this[CONFIG]);
  },
  optional() {
    return [this, '?'];
  },
  default(value: unknown) {
    return [this, '=', value];
  },
  narrow(predicate: Predicate) {
    return makeType(refine(this[NODE], predicateRefinement(predicate)), this[CONFIG]);
  },
  pipe(morph: Morph | Internals) {
    const node = isOwnType(morph) ? new MorphNode(this[NODE], null, contextFor(this[CONFIG]).unwrap(morph)) : new MorphNode(this[NODE], morph as Morph, null);
    return makeType(node, this[CONFIG]);
  },
  to(def: unknown) {
    return makeType(new MorphNode(this[NODE], null, parseDefinition(def, contextFor(this[CONFIG]))), this[CONFIG]);
  },
  describe(description: string) {
    return makeType(describe(this[NODE], description), this[CONFIG]);
  },
  configure(meta: TypeMeta) {
    return makeType(describe(this[NODE], meta.description ?? meta.expected), this[CONFIG]);
  },
  brand() {
    return this;
  },
  onUndeclaredKey(behavior: 'ignore' | 'reject' | 'delete') {
    const node = objectNode(this, 'onUndeclaredKey');
    return makeType(new ObjectNode(node.props, node.index, behavior), this[CONFIG]);
  },
  atLeast(limit: number) {
    return bounded(this, '>=', limit, 'value');
  },
  atMost(limit: number) {
    return bounded(this, '<=', limit, 'value');
  },
  moreThan(limit: number) {
    return bounded(this, '>', limit, 'value');
  },
  lessThan(limit: number) {
    return bounded(this, '<', limit, 'value');
  },
  divisibleBy(divisor: number) {
    return makeType(withRule(this[NODE], 'value', divisorRefinement(divisor), this[NODE].expression), this[CONFIG]);
  },
  atLeastLength(length: number) {
    return bounded(this, '>=', length, 'length');
  },
  atMostLength(length: number) {
    return bounded(this, '<=', length, 'length');
  },
  moreThanLength(length: number) {
    return bounded(this, '>', length, 'length');
  },
  lessThanLength(length: number) {
    return bounded(this, '<', length, 'length');
  },
  exactlyLength(length: number) {
    return bounded(this, '==', length, 'length');
  },
  matching(regex: RegExp | string) {
    return makeType(refine(this[NODE], patternRefinement(typeof regex === 'string' ? new RegExp(regex) : regex)), this[CONFIG]);
  },
  laterThan(date: Date | number | string) {
    return bounded(this, '>', new Date(date).valueOf(), 'time');
  },
  earlierThan(date: Date | number | string) {
    return bounded(this, '<', new Date(date).valueOf(), 'time');
  },
  atOrAfter(date: Date | number | string) {
    return bounded(this, '>=', new Date(date).valueOf(), 'time');
  },
  atOrBefore(date: Date | number | string) {
    return bounded(this, '<=', new Date(date).valueOf(), 'time');
  },
  get props() {
    return objectNode(this, 'props').props.map((p) => ({ key: p.key, kind: p.kind, value: makeType(p.value, this[CONFIG]) }));
  },
  get '~standard'() {
    const node = this[NODE];
    const config = this[CONFIG];
    return {
      version: 1,
      vendor: 'durable-db',
      validate: (value: unknown) => {
        const out = run(node, config, value);
        return out instanceof ArkErrors ? { issues: out } : { value: out };
      },
      jsonSchema: {
        input: ({ target }: { target: string }) => jsonSchema(node, config, 'in', { target: target as ToJsonSchemaOptions['target'] }),
        output: ({ target }: { target: string }) => jsonSchema(node, config, 'out', { target: target as ToJsonSchemaOptions['target'] }),
      },
    };
  },
  toString() {
    return `Type<${this[NODE].expression}>`;
  },
};
Object.setPrototypeOf(prototype, Function.prototype);

function makeType(node: Node, config: TypeConfig): Type<any> {
  const validate = ((data: unknown) => run(node, config, data)) as unknown as Internals;
  Object.setPrototypeOf(validate, prototype);
  validate[NODE] = node;
  validate[CONFIG] = config;
  return validate as unknown as Type<any>;
}

/** A `type()` whose Types follow `config` (durable-db's action args admit `undefined` for an optional key). */
export function createTypeParser(config: Partial<TypeConfig> = {}): TypeParser {
  const resolved: TypeConfig = { ...DEFAULT_CONFIG, ...config };
  const context = contextFor(resolved);
  const parse = (def: unknown) => makeType(parseDefinition(def, context), resolved);
  const parser = ((...args: unknown[]) => parse(args.length === 1 ? args[0] : args)) as unknown as TypeParser & Record<string, unknown>;
  Object.assign(parser, {
    errors: ArkErrors,
    raw: parse,
    unit: (value: unknown) => makeType(new UnitNode(value), resolved),
    enumerated: (...values: unknown[]) => makeType(union(values.map((v) => new UnitNode(v))), resolved),
    or: (...defs: unknown[]) => makeType(union(defs.map((d) => parseDefinition(d, context))), resolved),
    and: (...defs: unknown[]) => makeType(defs.map((d) => parseDefinition(d, context)).reduce(intersect), resolved),
  });
  return parser;
}

/** `type()`: ArkType's definitions and types, without ArkType's start-up. */
export const type: TypeParser = createTypeParser();

/** Whether a value is one of this package's Types (from this copy of it). */
export function isType(value: unknown): value is Type {
  return isOwnType(value);
}
