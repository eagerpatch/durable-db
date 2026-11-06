// The errors a validator returns, shaped like ArkType's: an `ArkErrors` array
// of `ArkError`s, each with its path, code, what was expected and what was
// there, and a message in ArkType's wording ("name must be a string (was a
// number)") — so code written against ArkType's errors reads these unchanged.

export type PathKey = string | number | symbol;

export interface ArkErrorInput {
  code: string;
  path?: readonly PathKey[];
  expected?: string;
  actual?: string | null;
  /** The whole problem, when it is not "must be <expected> (was <actual>)". */
  problem?: string;
  /** The whole message, path included, when it is not "<path> <problem>" (ArkType's `ctx.reject({ message })`). */
  message?: string;
  data?: unknown;
}

const identifier = /^[A-Za-z_$][\w$]*$/;

/** `['lines', 0, 'price']` → `lines[0].price`; `['a-b']` → `["a-b"]`. */
export function pathToString(path: readonly PathKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else if (typeof key === 'symbol') out += `[${String(key)}]`;
    else if (identifier.test(key)) out += out === '' ? key : `.${key}`;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out;
}

export class ArkError {
  readonly code: string;
  readonly path: PathKey[];
  readonly expected: string;
  readonly actual: string;
  readonly problem: string;
  readonly data: unknown;
  private readonly ownMessage?: string;

  constructor(input: ArkErrorInput) {
    this.code = input.code;
    this.path = [...(input.path ?? [])];
    this.expected = input.expected ?? '';
    this.actual = input.actual ?? '';
    this.data = input.data;
    this.problem = input.problem ?? `must be ${this.expected}${input.actual == null ? '' : ` (was ${input.actual})`}`;
    if (input.message !== undefined) this.ownMessage = input.message;
  }

  /** The path as ArkType prints it: `lines[0].price`. */
  get propString(): string {
    return pathToString(this.path);
  }

  /** The problem with its path: `name must be a string (was a number)`, `value at [1] must be …` at an array's root. */
  get message(): string {
    if (this.ownMessage !== undefined) return this.ownMessage;
    const at = this.propString;
    if (at === '') return this.problem;
    return at.startsWith('[') ? `value at ${at} ${this.problem}` : `${at} ${this.problem}`;
  }

  toString(): string {
    return this.message;
  }
}

/** Marks errors of every copy of this package (pnpm may install several): `instanceof` holds across them. */
const ERRORS = Symbol.for('durable-db/type: errors');

/** A failed validation's result: every error, in the order the value was checked. */
export class ArkErrors extends Array<ArkError> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /**
   * `out instanceof type.errors` holds for this copy's errors, another copy's
   * and a real ArkType Type's (its `' arkKind'` is `'errors'`).
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return (value as unknown as Record<symbol, unknown>)[ERRORS] === true || (value as { ' arkKind'?: unknown })[' arkKind'] === 'errors';
  }

  get [ERRORS](): true {
    return true;
  }

  /** Every message, one per line. */
  get summary(): string {
    return this.map((error) => error.message).join('\n');
  }

  get message(): string {
    return this.summary;
  }

  get count(): number {
    return this.length;
  }

  /** The errors as Standard Schema issues (each has `message` and `path`). */
  get issues(): readonly ArkError[] {
    return this;
  }

  /** The first error at each path, keyed by `propString`. */
  get byPath(): Record<string, ArkError> {
    const out: Record<string, ArkError> = {};
    for (const error of this) out[error.propString] ??= error;
    return out;
  }

  override toString(): string {
    return this.summary;
  }

  throw(): never {
    throw new TraversalError(this);
  }
}

/** What `assert()` throws: an Error carrying the errors. */
export class TraversalError extends Error {
  override readonly name = 'TraversalError';
  constructor(readonly arkErrors: ArkErrors) {
    super(arkErrors.length === 1 ? arkErrors[0]!.message : `\n${arkErrors.map((error) => `• ${error.message}`).join('\n')}`);
  }
}

/** Errors from a list (an `ArkErrors` is an array subclass; `new ArkErrors(n)` would make holes). */
export function arkErrors(errors: readonly ArkError[]): ArkErrors {
  const out = new ArkErrors();
  out.push(...errors);
  return out;
}
