// ArkType's keywords, with its regexes and descriptions — each node built the
// first time a definition names it, never at import.
import {
  BooleanNode,
  DomainNode,
  MorphNode,
  NeverNode,
  type Node,
  ProtoNode,
  RefinedNode,
  UnionNode,
  UnitNode,
  UnknownNode,
  divisorRefinement,
  maxRefinement,
  minRefinement,
  patternRefinement,
  predicateRefinement,
  type TraversalContext,
} from './nodes';

function globalConstructor(name: string): Node {
  const ctor = (globalThis as Record<string, unknown>)[name];
  if (typeof ctor !== 'function') throw new TypeError(`${name} is not defined in this runtime`);
  return new ProtoNode(ctor as new () => unknown, name);
}

const string = () => new DomainNode('string');
const number = () => new DomainNode('number');

const regexString = (regex: RegExp, description: string, format?: string) =>
  new RefinedNode(string(), [patternRefinement(regex, description, format)]);

const predicateString = (predicate: (s: string, ctx: TraversalContext) => boolean, description: string, json?: (schema: Record<string, unknown>) => void) =>
  new RefinedNode(string(), [predicateRefinement(predicate as never, description, json)]);

/** A morph from a string: `input` validated, then `morph`; `output` is what it declares it gives (its JSON Schema), not checked. */
const parse = (input: Node, morph: (s: string, ctx: TraversalContext) => unknown, output: Node | null) => new MorphNode(input, morph as never, output, false);

const wellFormedInteger = /^(?:(?!^-0$)-?(?:(?:0|[1-9]\d*)))$/;
const wellFormedNumber = /^(?:(?!^-0\.?0*$)(?:-?(?:(?:0|[1-9]\d*)(?:\.\d+)?)|\.\d+?))$/;
const iso8601 =
  /^([+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))(T((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([,.]\d+(?!:))?)?(\17[0-5]\d([,.]\d+)?)?([Zz]|([+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;
const ipv4Segment = '(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])';
const ipv4Address = `(${ipv4Segment}[.]){3}${ipv4Segment}`;
const ipv6Segment = '(?:[0-9a-fA-F]{1,4})';
const ipv6 = new RegExp(
  '^(' +
    `(?:${ipv6Segment}:){7}(?:${ipv6Segment}|:)|` +
    `(?:${ipv6Segment}:){6}(?:${ipv4Address}|:${ipv6Segment}|:)|` +
    `(?:${ipv6Segment}:){5}(?::${ipv4Address}|(:${ipv6Segment}){1,2}|:)|` +
    `(?:${ipv6Segment}:){4}(?:(:${ipv6Segment}){0,1}:${ipv4Address}|(:${ipv6Segment}){1,3}|:)|` +
    `(?:${ipv6Segment}:){3}(?:(:${ipv6Segment}){0,2}:${ipv4Address}|(:${ipv6Segment}){1,4}|:)|` +
    `(?:${ipv6Segment}:){2}(?:(:${ipv6Segment}){0,3}:${ipv4Address}|(:${ipv6Segment}){1,5}|:)|` +
    `(?:${ipv6Segment}:){1}(?:(:${ipv6Segment}){0,4}:${ipv4Address}|(:${ipv6Segment}){1,6}|:)|` +
    `(?::((?::${ipv6Segment}){0,5}:${ipv4Address}|(?::${ipv6Segment}){1,7}|:))` +
    ')(%[0-9a-zA-Z.]{1,})?$',
);
const uuidVersioned = /^[\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[1-8][\dA-Fa-f]{3}-[89ABab][\dA-Fa-f]{3}-[\dA-Fa-f]{12}$/;
const uuidVersion = (v: number) => new RegExp(`^[\\dA-Fa-f]{8}-[\\dA-Fa-f]{4}-${v}[\\dA-Fa-f]{3}-[89ABab][\\dA-Fa-f]{3}-[\\dA-Fa-f]{12}$`);
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;
const creditCardMatcher =
  /^(?:4\d{12}(?:\d{3,6})?|5[1-5]\d{14}|(222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)\d{12}|6(?:011|5\d\d)\d{12,15}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|(?:2131|1800|35\d{3})\d{11}|6[27]\d{14}|^(81\d{14,17}))$/;

// https://github.com/validatorjs/validator.js/blob/master/src/lib/isLuhnNumber.js (as ArkType has it)
function isLuhnValid(input: string): boolean {
  const sanitized = input.replace(/[ -]+/g, '');
  let sum = 0;
  let shouldDouble = false;
  for (let i = sanitized.length - 1; i >= 0; i--) {
    let digit = Number.parseInt(sanitized.substring(i, i + 1), 10);
    if (shouldDouble) {
      digit *= 2;
      sum += digit >= 10 ? (digit % 10) + 1 : digit;
    } else sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0 && sanitized !== '';
}

const jsonStringDescription = 'a JSON string';
const date = () => new ProtoNode(Date);
const MIN_EPOCH = -8640000000000000;
const MAX_EPOCH = 8640000000000000;

const epochNumber = () => {
  const base = number();
  base.description = 'a number representing a Unix timestamp';
  const min = { ...minRefinement(MIN_EPOCH, false, 'value'), expected: `a Unix timestamp after ${MIN_EPOCH}` };
  const max = { ...maxRefinement(MAX_EPOCH, false, 'value'), expected: `a Unix timestamp before ${MAX_EPOCH}` };
  const node = new RefinedNode(base, [divisorRefinement(1, 'an integer representing a Unix timestamp'), min, max], 'an integer representing a safe Unix timestamp');
  node.meta = { description: 'an integer representing a safe Unix timestamp' };
  return node;
};

/** A node with a description: its messages' expected, its JSON Schema's `description`; `meta` on each branch of a union too (ArkType's `@`). */
function described<T extends Node>(node: T, description: string, meta: Record<string, unknown> = {}): T {
  node.description = description;
  node.meta = { description, ...meta };
  if (node instanceof UnionNode) {
    for (const branch of node.branches) {
      branch.meta = { description, ...branch.meta, ...meta };
      if (branch instanceof UnitNode) branch.meta = { ...branch.meta, ...meta };
    }
    node.meta = { description, ...meta };
  }
  return node;
}

const stringInteger = () => regexString(wellFormedInteger, 'a well-formed integer string');
const stringNumeric = () => regexString(wellFormedNumber, 'a well-formed numeric string');
const stringIso = () => regexString(iso8601, 'an ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ) date');
const stringEpoch = () =>
  new RefinedNode(
    string(),
    [
      patternRefinement(wellFormedInteger, 'a well-formed integer string'),
      predicateRefinement(((s: string) => {
        const n = Number.parseInt(s);
        return n >= MIN_EPOCH && n <= MAX_EPOCH;
      }) as never, 'an integer string representing a safe Unix timestamp'),
    ],
    'an integer string representing a safe Unix timestamp',
  );
const parsableDate = () => predicateString((s) => !Number.isNaN(new Date(s).valueOf()), 'a parsable date');
const url = () => predicateString((s) => URL.canParse(s), 'a URL string', (schema) => (schema.format = 'uri'));

const normalizeForms = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const;

const KEYWORDS: Record<string, () => Node> = {
  string,
  number,
  bigint: () => new DomainNode('bigint'),
  boolean: () => new BooleanNode(),
  symbol: () => new DomainNode('symbol'),
  object: () => new DomainNode('object'),
  null: () => new UnitNode(null),
  undefined: () => new UnitNode(undefined),
  true: () => new UnitNode(true),
  false: () => new UnitNode(false),
  unknown: () => new UnknownNode(),
  any: () => new UnknownNode(),
  never: () => new NeverNode(),
  Date: date,
  Array: () => new ProtoNode(Array, 'Array'),
  // Read from globalThis when named, never at import (in Node, touching `Response` or `FormData` loads undici).
  ...Object.fromEntries(
    (['Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'Promise', 'ArrayBuffer', 'Function', 'URL', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'Uint8Array'] as const).map(
      (name) => [name, () => globalConstructor(name)],
    ),
  ),
  Key: () => new UnionNode([string(), new DomainNode('symbol')]),
  NaN: () => new UnitNode(Number.NaN),
  Infinity: () => new UnitNode(Number.POSITIVE_INFINITY),
  NegativeInfinity: () => new UnitNode(Number.NEGATIVE_INFINITY),

  'number.integer': () => new RefinedNode(number(), [divisorRefinement(1)]),
  'number.safe': () =>
    new RefinedNode(number(), [minRefinement(Number.MIN_SAFE_INTEGER, false, 'value'), maxRefinement(Number.MAX_SAFE_INTEGER, false, 'value')]),
  'number.epoch': epochNumber,
  'number.NaN': () => new UnitNode(Number.NaN),
  'number.Infinity': () => new UnitNode(Number.POSITIVE_INFINITY),
  'number.NegativeInfinity': () => new UnitNode(Number.NEGATIVE_INFINITY),

  'string.alpha': () => regexString(/^[A-Za-z]*$/, 'only letters'),
  'string.alphanumeric': () => regexString(/^[\dA-Za-z]*$/, 'only letters and digits 0-9'),
  'string.digits': () => regexString(/^\d*$/, 'only digits 0-9'),
  'string.hex': () => regexString(/^[\dA-Fa-f]+$/, 'hex characters only'),
  'string.base58': () => regexString(/^[1-9A-HJ-NP-Za-km-z]+$/, 'base58-encoded'),
  'string.base64': () => regexString(/^(?:[\d+/A-Za-z]{4})*(?:[\d+/A-Za-z]{2}==|[\d+/A-Za-z]{3}=)?$/, 'base64-encoded'),
  'string.base64.url': () => regexString(/^(?:[\w-]{4})*(?:[\w-]{2}(?:==|%3D%3D)?|[\w-]{3}(?:=|%3D)?)?$/, 'base64url-encoded'),
  'string.email': () => regexString(/^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/, 'an email address', 'email'),
  'string.semver': () => regexString(semver, 'a semantic version (see https://semver.org/)'),
  'string.creditCard': () =>
    new RefinedNode(string(), [patternRefinement(creditCardMatcher, 'a credit card number'), predicateRefinement(isLuhnValid as never, 'a credit card number')], 'a credit card number'),
  'string.ip': () => {
    const node = described(new UnionNode([regexString(new RegExp(`^${ipv4Address}$`), 'an IPv4 address', 'ipv4'), regexString(ipv6, 'an IPv6 address', 'ipv6')]), 'an IP address');
    node.meta = { description: 'an IP address' };
    return node;
  },
  'string.ip.v4': () => regexString(new RegExp(`^${ipv4Address}$`), 'an IPv4 address', 'ipv4'),
  'string.ip.v6': () => regexString(ipv6, 'an IPv6 address', 'ipv6'),
  'string.uuid': () =>
    described(
      new UnionNode([
        regexString(uuidVersioned, 'a UUID'),
        new UnitNode('00000000-0000-0000-0000-000000000000'),
        new UnitNode('ffffffff-ffff-ffff-ffff-ffffffffffff'),
      ]),
      'a UUID',
      { format: 'uuid' },
    ),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((v) => [`string.uuid.v${v}`, () => regexString(uuidVersion(v), `a UUIDv${v}`)])),
  'string.regex': () =>
    predicateString((s, ctx) => {
      try {
        new RegExp(s);
        return true;
      } catch (error) {
        return ctx.reject({ expected: 'a regex pattern', problem: String(error) });
      }
    }, 'a regex pattern', (schema) => (schema.format = 'regex')),
  'string.json': () =>
    predicateString((s, ctx) => {
      try {
        JSON.parse(s);
        return true;
      } catch (error) {
        return ctx.reject({ expected: jsonStringDescription, problem: `must be ${jsonStringDescription} (${error})` });
      }
    }, jsonStringDescription),
  'string.json.parse': () =>
    parse(string(), (s, ctx) => {
      if (s.length === 0) return ctx.error({ expected: jsonStringDescription, actual: 'empty' });
      try {
        return JSON.parse(s);
      } catch (error) {
        return ctx.error({ expected: jsonStringDescription, problem: `must be ${jsonStringDescription} (${error})` });
      }
    }, null),
  'string.url': url,
  'string.url.parse': () =>
    parse(url(), (s, ctx) => {
      try {
        return new URL(s);
      } catch {
        return ctx.error('a URL string');
      }
    }, new ProtoNode(URL)),
  'string.integer': stringInteger,
  'string.integer.parse': () =>
    parse(stringInteger(), (s, ctx) => {
      const parsed = Number.parseInt(s);
      return Number.isSafeInteger(parsed) ? parsed : ctx.error('an integer in the range Number.MIN_SAFE_INTEGER to Number.MAX_SAFE_INTEGER');
    }, new RefinedNode(number(), [divisorRefinement(1)])),
  'string.numeric': stringNumeric,
  'string.numeric.parse': () => parse(stringNumeric(), (s) => Number.parseFloat(s), number()),
  'string.date': parsableDate,
  'string.date.parse': () =>
    parse(string(), (s, ctx) => {
      const parsed = new Date(s);
      return Number.isNaN(parsed.valueOf()) ? ctx.error('a parsable date') : parsed;
    }, date()),
  'string.date.iso': stringIso,
  'string.date.iso.parse': () => parse(stringIso(), (s) => new Date(s), date()),
  'string.date.epoch': stringEpoch,
  'string.date.epoch.parse': () => parse(stringEpoch(), (s) => new Date(Number.parseInt(s)), date()),
  'string.trim': () => parse(string(), (s) => s.trim(), regexString(/^\S.*\S$|^\S?$/, 'trimmed')),
  'string.trim.preformatted': () => regexString(/^\S.*\S$|^\S?$/, 'trimmed'),
  'string.lower': () => parse(string(), (s) => s.toLowerCase(), regexString(/^[a-z]*$/, 'only lowercase letters')),
  'string.lower.preformatted': () => regexString(/^[a-z]*$/, 'only lowercase letters'),
  'string.upper': () => parse(string(), (s) => s.toUpperCase(), regexString(/^[A-Z]*$/, 'only uppercase letters')),
  'string.upper.preformatted': () => regexString(/^[A-Z]*$/, 'only uppercase letters'),
  'string.capitalize': () => parse(string(), (s) => s.charAt(0).toUpperCase() + s.slice(1), regexString(/^[A-Z].*$/, 'capitalized')),
  'string.capitalize.preformatted': () => regexString(/^[A-Z].*$/, 'capitalized'),
  'string.normalize': () => parse(string(), (s) => s.normalize('NFC'), null),
  ...Object.fromEntries(
    normalizeForms.flatMap((form) => [
      [`string.normalize.${form}`, () => parse(string(), (s) => s.normalize(form), null)],
      [`string.normalize.${form}.preformatted`, () => predicateString((s) => s.normalize(form) === s, `${form}-normalized unicode`)],
    ]),
  ),
};

// A module's name alone is its root: `string.date` is a parsable date string.
KEYWORDS['number.root'] = number;
KEYWORDS['string.root'] = string;

/** The node a keyword names, or null when ArkType knows it but this does not (yet). */
export function keyword(name: string): Node | null {
  const make = KEYWORDS[name];
  return make ? make() : null;
}

