import { createTypeParser } from '../type';

/**
 * `type` (durable-db/type: ArkType's definitions and types), for an
 * action's `args` schema, with an optional key accepting `undefined`.
 *
 * ArkType checks an optional key as TypeScript's `exactOptionalPropertyTypes`
 * would by default: `'photoKey?': 'string'` rejects `{ photoKey: undefined }`,
 * while the inferred `{ photoKey?: string }` accepts it under TypeScript's
 * default settings — so `addReview({ …, photoKey: maybeKey })` type-checks and
 * then fails at runtime. This scope turns ArkType's
 * `exactOptionalPropertyTypes` off: an optional key, at any depth, admits
 * `undefined`, and a required key stays required (`'note': 'string |
 * undefined'` must be present, as TypeScript says). The validator is a plain
 * object Type — `.props`, `.toJsonSchema()` and `.assert()` work as usual; in
 * JSON Schema the `undefined` an optional key admits is `{ not: {} }` (a JSON
 * document never holds it), so `'photoKey?': 'string'` is still a string.
 *
 * An `args` given as a ready `type(…)` keeps the rules of the scope that made
 * it.
 *
 * The action transform compiles `args` with this (it is the `type` that
 * `durable-db/registry` exports), for the RPC stub and the Durable Object
 * alike; the untransformed `action()` and the test harness use it too.
 */
export const actionArgsType = createTypeParser({
  exactOptionalPropertyTypes: false,
  // Other units (a symbol, a bigint) fail as they do by default.
  jsonSchemaUnit: (unit) => {
    if (unit === undefined) return { not: {} };
    throw new Error(`${String(unit)} is not convertible to JSON Schema`);
  },
});
