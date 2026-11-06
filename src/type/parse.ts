// ArkType's definition syntax → nodes: strings (`'string | number'`,
// `'number.integer >= 0'`, `'0 < number <= 10'`, `"'a' | 'b'"`, `'/^a+$/'`,
// `'string[]'`, `'Record<string, number>'`), objects (`'key?'`, `'[string]'`,
// `'+'`, `'...'`, `'number = 0'`), tuples and tuple expressions (`[def, '[]']`,
// `[def, '|', def]`, `[def, '=>', fn]`, `[def, ':', fn]`, `['===', …]`,
// `['instanceof', C]`, `['keyof', def]`). What it does not know fails with a
// ParseError naming it — never a validator that checks something else.
import { keyword } from './keywords';
import {
  ArrayNode,
  BooleanNode,
  DomainNode,
  IntersectionNode,
  MorphNode,
  type Morph,
  Node,
  ObjectNode,
  type Predicate,
  type Prop,
  ProtoNode,
  RefinedNode,
  type Refinement,
  StandardNode,
  TupleNode,
  UnionNode,
  UnitNode,
  divisorRefinement,
  exactLengthRefinement,
  isStandardSchema,
  maxRefinement,
  minRefinement,
  patternRefinement,
  predicateRefinement,
} from './nodes';

export class ParseError extends Error {
  override readonly name = 'ParseError';
}

export interface ParseContext {
  /** The node of one of this package's Types, or null for anything else. */
  unwrap(value: unknown): Node | null;
}

const cache = new Map<string, Node>();

/** A definition's node. */
export function parseDefinition(def: unknown, ctx: ParseContext): Node {
  if (typeof def === 'string') {
    let node = cache.get(def);
    if (!node) cache.set(def, (node = parseString(def, ctx)));
    return node;
  }
  const own = ctx.unwrap(def);
  if (own) return own;
  if (isStandardSchema(def)) return new StandardNode(def);
  if (def instanceof RegExp) return new RefinedNode(new DomainNode('string'), [patternRefinement(def)]);
  if (Array.isArray(def)) return parseTuple(def, ctx);
  if (typeof def === 'object' && def !== null) return parseObject(def as Record<string, unknown>, ctx);
  throw new ParseError(`${typeof def === 'function' ? 'A function' : String(def)} is not a valid definition`);
}

// ── Objects ─────────────────────────────────────────────────────────────

interface PropValue {
  node: Node;
  optional: boolean;
  default?: { value: unknown };
}

/** An object value: `'string?'`, `'number = 0'`, `[def, '?']`, `[def, '=', 0]`, or any definition. */
function parsePropValue(value: unknown, ctx: ParseContext): PropValue {
  if (typeof value === 'string') {
    const text = value.trim();
    const split = defaultSplit(text);
    if (split) return { node: parseDefinition(split.def, ctx), optional: true, default: { value: parseLiteralValue(split.value) } };
    if (text.endsWith('?')) return { node: parseDefinition(text.slice(0, -1).trimEnd(), ctx), optional: true };
    return { node: parseDefinition(value, ctx), optional: false };
  }
  if (Array.isArray(value) && value.length === 2 && value[1] === '?') return { node: parseDefinition(value[0], ctx), optional: true };
  if (Array.isArray(value) && value.length === 3 && value[1] === '=') {
    return { node: parseDefinition(value[0], ctx), optional: true, default: { value: value[2] } };
  }
  return { node: parseDefinition(value, ctx), optional: false };
}

function parseObject(def: Record<string, unknown>, ctx: ParseContext): ObjectNode {
  let props: Prop[] = [];
  const index: Array<{ key: Node; value: Node }> = [];
  let undeclared: 'ignore' | 'reject' | 'delete' | undefined;
  for (const key of Object.keys(def)) {
    const value = def[key];
    if (key === '+') {
      if (value !== 'ignore' && value !== 'reject' && value !== 'delete') throw new ParseError(`'+' must be 'ignore', 'reject' or 'delete' (was ${String(value)})`);
      undeclared = value;
      continue;
    }
    if (key === '...') {
      const spread = parseDefinition(value, ctx);
      if (!(spread instanceof ObjectNode)) throw new ParseError(`'...' must spread an object (was ${spread.expression})`);
      props = mergeProps(props, spread.props);
      index.push(...spread.index);
      continue;
    }
    if (key.length > 2 && key.startsWith('[') && key.endsWith(']')) {
      index.push({ key: parseDefinition(key.slice(1, -1), ctx), value: parseDefinition(value, ctx) });
      continue;
    }
    let name = key;
    let optionalKey = false;
    if (name.endsWith('\\?')) name = `${name.slice(0, -2)}?`;
    else if (name.endsWith('?')) {
      name = name.slice(0, -1);
      optionalKey = true;
    }
    if (name.startsWith('\\')) name = name.slice(1);
    const parsed = parsePropValue(value, ctx);
    if (optionalKey && parsed.default) throw new ParseError(`'${name}' cannot be optional and have a default`);
    props = mergeProps(props, [
      {
        key: name,
        value: parsed.node,
        kind: optionalKey || parsed.optional ? 'optional' : 'required',
        ...(parsed.default ? { default: parsed.default } : {}),
      },
    ]);
  }
  return new ObjectNode(props, index, undeclared);
}

/** Later props replace earlier ones with the same key (`'...'`, `.merge()`). */
export function mergeProps(base: readonly Prop[], over: readonly Prop[]): Prop[] {
  const keys = new Set(over.map((p) => p.key));
  return [...base.filter((p) => !keys.has(p.key)), ...over];
}

/** `'number = 5'` → `{ def: 'number', value: '5' }`: the top-level `=` that is not `<=`, `>=` or `==`. */
function defaultSplit(text: string): { def: string; value: string } | null {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '/') quote = c;
    else if (c === '(' || c === '<' || c === '[') depth++;
    else if (c === ')' || c === '>' || c === ']') depth--;
    else if (c === '=' && depth <= 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev === '<' || prev === '>' || prev === '=' || next === '=' || next === '>') continue;
      return { def: text.slice(0, i).trim(), value: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseLiteralValue(text: string): unknown {
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
  if (/^-?\d+n$/.test(text)) return BigInt(text.slice(0, -1));
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return unquote(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text === 'undefined') return undefined;
  throw new ParseError(`Default value ${text} must be a literal (a number, string, boolean, null or undefined)`);
}

function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/g, '$1');
}

// ── Tuples and tuple expressions ────────────────────────────────────────

function parseTuple(def: readonly unknown[], ctx: ParseContext): Node {
  const [first, second] = def;
  if (first === '===') return union(def.slice(1).map((value) => new UnitNode(value)));
  if (first === 'instanceof') {
    return union(
      def.slice(1).map((ctor) => {
        if (typeof ctor !== 'function') throw new ParseError(`instanceof needs a constructor (was ${String(ctor)})`);
        return new ProtoNode(ctor as new () => unknown);
      }),
    );
  }
  if (first === 'keyof') return keyofNode(parseDefinition(second, ctx));
  if (def.length === 2 && second === '[]') return new ArrayNode(parseDefinition(first, ctx));
  if (def.length === 3 && typeof second === 'string') {
    const third = def[2];
    switch (second) {
      case '|':
        return union([parseDefinition(first, ctx), parseDefinition(third, ctx)]);
      case '&':
        return intersect(parseDefinition(first, ctx), parseDefinition(third, ctx));
      case '=>':
        if (typeof third !== 'function') throw new ParseError(`'=>' needs a function`);
        return new MorphNode(parseDefinition(first, ctx), third as Morph, null);
      case '|>':
        return new MorphNode(parseDefinition(first, ctx), null, parseDefinition(third, ctx));
      case ':':
        if (typeof third !== 'function') throw new ParseError(`':' needs a function`);
        return refine(parseDefinition(first, ctx), predicateRefinement(third as Predicate));
      case '@':
        return describe(parseDefinition(first, ctx), typeof third === 'string' ? third : (third as { description?: string; expected?: string })?.description ?? (third as { expected?: string })?.expected);
      case '=':
        throw new ParseError(`A default ([def, '=', value]) is only valid as an object's value`);
    }
  }
  if (def.length === 2 && second === '?') throw new ParseError(`An optional value ([def, '?']) is only valid as an object's value`);
  // A tuple: `['string', 'number?']`, `['string', '...', 'number[]']`.
  const required: Node[] = [];
  const optional: Node[] = [];
  let rest: Node | null = null;
  for (let i = 0; i < def.length; i++) {
    const element = def[i];
    if (element === '...') {
      if (rest) throw new ParseError('A tuple has one variadic element');
      if (i !== def.length - 2) throw new ParseError('A variadic element must be last');
      const spread = parseDefinition(def[++i], ctx);
      if (!(spread instanceof ArrayNode)) throw new ParseError(`'...' must spread an array (was ${spread.expression})`);
      rest = spread.element;
      continue;
    }
    const parsed = parsePropValue(element, ctx);
    if (parsed.default) throw new ParseError('A tuple element cannot have a default');
    if (parsed.optional) optional.push(parsed.node);
    else if (optional.length > 0) throw new ParseError('A required element cannot follow an optional one');
    else required.push(parsed.node);
  }
  return new TupleNode(required, optional, rest);
}

export function keyofNode(node: Node): Node {
  if (!(node instanceof ObjectNode)) throw new ParseError(`keyof needs an object (was ${node.expression})`);
  const keys: Node[] = node.props.map((p) => new UnitNode(p.key));
  keys.push(...node.index.map((sig) => sig.key));
  return union(keys);
}

// ── Composition ─────────────────────────────────────────────────────────

export function union(branches: readonly Node[]): Node {
  const flat = branches.flatMap((b) =>
    b instanceof UnionNode && !b.description ? b.branches : b instanceof BooleanNode && !b.description && branches.length > 1 ? b.units : [b],
  );
  // `x | x`, `'a' | 'a'`: once.
  const unique = flat.filter((b, i) => flat.findIndex((o) => o === b || (o instanceof UnitNode && b instanceof UnitNode && Object.is(o.value, b.value))) === i);
  if (unique.length === 0) throw new ParseError('A union needs a branch');
  return unique.length === 1 ? unique[0]! : new UnionNode(unique);
}

/** `a & b`: one object of both's keys, one base with both's rules, or both checks in turn. */
export function intersect(a: Node, b: Node): Node {
  if (a instanceof ObjectNode && b instanceof ObjectNode) {
    const props = [...a.props];
    for (const prop of b.props) {
      const i = props.findIndex((p) => p.key === prop.key);
      if (i < 0) props.push(prop);
      else {
        const existing = props[i]!;
        props[i] = {
          key: prop.key,
          value: intersect(existing.value, prop.value),
          kind: existing.kind === 'required' || prop.kind === 'required' ? 'required' : 'optional',
        };
      }
    }
    return new ObjectNode(props, [...a.index, ...b.index], b.undeclared ?? a.undeclared);
  }
  const baseOf = (n: Node) => (n instanceof RefinedNode ? n.base : n);
  const rulesOf = (n: Node) => (n instanceof RefinedNode ? n.refinements : []);
  if ((a instanceof RefinedNode || b instanceof RefinedNode) && sameBase(baseOf(a), baseOf(b))) {
    return new RefinedNode(baseOf(a), [...rulesOf(a), ...rulesOf(b)]);
  }
  return new IntersectionNode([a, b]);
}

function sameBase(a: Node, b: Node): boolean {
  if (a === b) return true;
  if (a instanceof DomainNode && b instanceof DomainNode) return a.name === b.name;
  if (a instanceof ProtoNode && b instanceof ProtoNode) return a.ctor === b.ctor;
  return false;
}

export function refine(node: Node, refinement: Refinement): Node {
  if (node instanceof RefinedNode && !node.description) return node.with(refinement);
  return new RefinedNode(node, [refinement]);
}

/** A copy of a node with its own description (the expected in its messages). */
export function describe(node: Node, description: string | undefined): Node {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(node)) as Node, node);
  copy.description = description;
  return copy;
}

// ── Strings ─────────────────────────────────────────────────────────────

type Comparator = '<' | '<=' | '>' | '>=' | '==';

class StringParser {
  private i = 0;
  /** Inside `Record<…>`: a `>` closes it, never a bound. */
  private generics = 0;
  constructor(
    private readonly src: string,
    private readonly ctx: ParseContext,
  ) {}

  parse(): Node {
    const node = this.pipe();
    this.ws();
    if (this.i < this.src.length) this.error(`Unexpected '${this.src.slice(this.i)}'`);
    return node;
  }

  private error(message: string): never {
    throw new ParseError(`${message} in '${this.src}'`);
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  private peek(text: string): boolean {
    this.ws();
    return this.src.startsWith(text, this.i);
  }

  private eat(text: string): boolean {
    if (!this.peek(text)) return false;
    this.i += text.length;
    return true;
  }

  /** `a |> b`: lowest precedence. */
  private pipe(): Node {
    let node = this.union();
    while (this.eat('|>')) node = new MorphNode(node, null, this.union());
    return node;
  }

  private union(): Node {
    const branches = [this.intersection()];
    while (this.peek('|') && !this.peek('|>')) {
      this.i++;
      branches.push(this.intersection());
    }
    return union(branches);
  }

  private intersection(): Node {
    let node = this.bounded();
    while (this.eat('&')) node = intersect(node, this.bounded());
    return node;
  }

  /** `number >= 0`, `0 < number <= 10`, `string > 0`, `number % 2`, `Date < d'2020-01-01'`. */
  private bounded(): Node {
    this.ws();
    let left: { limit: number; comparator: Comparator } | null = null;
    const start = this.i;
    const limit = this.limit();
    if (limit !== null) {
      const comparator = this.comparator();
      if (comparator) {
        if (comparator !== '<' && comparator !== '<=') this.error(`A left bound must be < or <= (was ${comparator})`);
        left = { limit, comparator };
      } else this.i = start;
    }
    let node = this.postfix();
    if (left) node = bound(node, left.comparator === '<' ? '>' : '>=', left.limit, this.src);
    const comparator = this.comparator();
    if (comparator) {
      const right = this.limit();
      if (right === null) this.error(`Expected a limit after ${comparator}`);
      if (left && comparator !== '<' && comparator !== '<=') this.error(`A range must be written low < x <= high`);
      node = bound(node, comparator, right, this.src);
    } else if (this.eat('%')) {
      this.ws();
      const match = /^\d+/.exec(this.src.slice(this.i));
      if (!match) this.error(`Expected a divisor after %`);
      this.i += match[0].length;
      node = withRule(node, 'value', divisorRefinement(Number(match[0])), this.src);
    }
    return node;
  }

  private comparator(): Comparator | null {
    this.ws();
    for (const c of ['<=', '>=', '==', '<', '>'] as const) {
      if (c === '>' && this.generics > 0) continue;
      if (this.src.startsWith(c, this.i)) {
        this.i += c.length;
        return c;
      }
    }
    return null;
  }

  /** A number, or a date literal `d'2020-01-01'` as its time. */
  private limit(): number | null {
    this.ws();
    const rest = this.src.slice(this.i);
    const date = /^d(['"])(.*?)\1/.exec(rest);
    if (date) {
      this.i += date[0].length;
      const time = new Date(date[2]!).valueOf();
      if (Number.isNaN(time)) this.error(`${date[0]} is not a valid date`);
      return time;
    }
    const n = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?![\w.])/i.exec(rest);
    if (!n) return null;
    this.i += n[0].length;
    return Number(n[0]);
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.eat('[]')) node = new ArrayNode(node);
    return node;
  }

  private primary(): Node {
    this.ws();
    const c = this.src[this.i];
    if (c === undefined) this.error('Expected a definition');
    if (c === '(') {
      this.i++;
      const inner = this.pipe();
      if (!this.eat(')')) this.error(`Missing ')'`);
      return inner;
    }
    if (c === "'" || c === '"') return new UnitNode(this.quoted(c));
    if (c === '/') return this.regex();
    const rest = this.src.slice(this.i);
    const literal = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(n?)(?![\w.])/i.exec(rest);
    if (literal) {
      this.i += literal[0].length;
      return new UnitNode(literal[2] ? BigInt(literal[1]!) : Number(literal[1]));
    }
    const name = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(rest);
    if (!name) this.error(`Unexpected '${c}'`);
    this.i += name[0].length;
    if (this.src[this.i] === '<') return this.generic(name[0]);
    const node = keyword(name[0]);
    if (!node) throw new ParseError(`'${name[0]}' is unresolvable${/^[a-z]/.test(name[0]) && name[0].includes('.') ? '' : ' (durable-db/type has no scopes: define it as a Type and nest it)'}`);
    return node;
  }

  private quoted(quote: string): string {
    let out = '';
    this.i++;
    while (this.i < this.src.length && this.src[this.i] !== quote) {
      if (this.src[this.i] === '\\') this.i++;
      out += this.src[this.i++];
    }
    if (this.src[this.i] !== quote) this.error(`Unterminated string literal`);
    this.i++;
    return out;
  }

  private regex(): Node {
    const match = /^\/((?:\\.|[^/\\])+)\/([dgimsuvy]*)/.exec(this.src.slice(this.i));
    if (!match) this.error('Unterminated regex');
    this.i += match[0].length;
    return new RefinedNode(new DomainNode('string'), [patternRefinement(new RegExp(match[1]!, match[2]))]);
  }

  /** `Record<string, number>`, `Array<string>`. */
  private generic(name: string): Node {
    this.i++; // <
    this.generics++;
    const args: Node[] = [this.pipe()];
    while (this.eat(',')) args.push(this.pipe());
    this.generics--;
    if (!this.eat('>')) this.error(`Missing '>'`);
    if (name === 'Array' && args.length === 1) return new ArrayNode(args[0]!);
    if (name === 'Record' && args.length === 2) return record(args[0]!, args[1]!);
    if (name === 'Exclude' && args.length === 2) return exclude(args[0]!, args[1]!, false);
    if (name === 'Extract' && args.length === 2) return exclude(args[0]!, args[1]!, true);
    return this.error(`${name}<…> is not supported`);
  }
}

function parseString(def: string, ctx: ParseContext): Node {
  return new StringParser(def, ctx).parse();
}

function record(key: Node, value: Node): Node {
  const units = key instanceof UnionNode ? key.branches : [key];
  if (units.every((u) => u instanceof UnitNode && typeof u.value === 'string')) {
    return new ObjectNode(units.map((u) => ({ key: (u as UnitNode).value as string, value, kind: 'required' as const })));
  }
  return new ObjectNode([], [{ key, value }]);
}

/** `Exclude<a | b, b>` on unions of units and domains. */
function exclude(from: Node, what: Node, keep: boolean): Node {
  const branches = from instanceof UnionNode ? from.branches : [from];
  const removed = what instanceof UnionNode ? what.branches : [what];
  const matches = (b: Node) => removed.some((r) => r.expression === b.expression);
  const left = branches.filter((b) => matches(b) === keep);
  return union(left.length > 0 ? left : [keyword('never')!]);
}

type Measure = 'value' | 'length' | 'time';

/** What a bound measures on this node: a number's value, a string's or array's length, a Date's time. */
function measureOf(node: Node): Measure | null {
  const base = node instanceof RefinedNode ? node.base : node;
  if (base instanceof DomainNode) return base.name === 'number' ? 'value' : base.name === 'string' ? 'length' : null;
  if (base instanceof ArrayNode || base instanceof TupleNode) return 'length';
  if (base instanceof ProtoNode) return base.ctor === Array ? 'length' : base.ctor === Date ? 'time' : null;
  return null;
}

function withRule(node: Node, need: Measure | null, rule: Refinement, src: string): Node {
  const measure = measureOf(node);
  if (!measure || (need && measure !== need)) {
    throw new ParseError(`${need === 'value' ? 'A divisor' : 'A bound'} needs ${need === 'value' ? 'a number' : 'a number, string, array or Date'} (was ${node.expression}) in '${src}'`);
  }
  return refine(node, rule);
}

function bound(node: Node, comparator: Comparator, limit: number, src: string): Node {
  const measure = measureOf(node);
  if (!measure) throw new ParseError(`A bound needs a number, string, array or Date (was ${node.expression}) in '${src}'`);
  if (comparator === '==') {
    if (measure === 'length') return refine(node, exactLengthRefinement(limit));
    return refine(refine(node, minRefinement(limit, false, measure)), maxRefinement(limit, false, measure));
  }
  const rule = comparator === '>' || comparator === '>=' ? minRefinement(limit, comparator === '>', measure) : maxRefinement(limit, comparator === '<', measure);
  return refine(node, rule);
}
