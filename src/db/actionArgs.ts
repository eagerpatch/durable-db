import { type } from '../arktypeConfig'; // jitless `type` — eval-free for Workers

/**
 * A plain-object `args` without its `undefined`-valued keys (a shallow copy,
 * only when one has to go); anything else is returned as is.
 *
 * ArkType checks an optional key as TypeScript's `exactOptionalPropertyTypes`
 * would: `'photoKey?': 'string'` rejects `{ photoKey: undefined }`, while the
 * inferred `{ photoKey?: string }` accepts it under TypeScript's default
 * settings — so `addReview({ …, photoKey: maybeKey })` type-checks and then
 * fails at runtime. An `undefined` value means "not given", so it is dropped
 * before validation; a required key passed as `undefined` still fails (as
 * missing).
 */
export function dropUndefinedKeys<T>(args: T): T {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const proto = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) return args;

  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    if ((args as Record<string, unknown>)[key] === undefined) {
      copy ??= { ...(args as Record<string, unknown>) };
      delete copy[key];
    }
  }
  return (copy ?? args) as T;
}

// Typed loosely: the pipe's static types are irrelevant here, the result is
// cast back to `type`'s signature below.
const unknownInput = type('unknown') as unknown as {
  pipe(morph: (input: unknown) => unknown, next: unknown): unknown;
};

/**
 * ArkType's `type`, for an action's `args` schema: the compiled validator
 * drops `undefined`-valued keys from a plain-object input
 * ({@link dropUndefinedKeys}) before it validates. Accepts every form an
 * action's `args` takes — an object definition or an existing `type(…)`.
 *
 * The action transform compiles `args` with this (it is the `type` that
 * `durable-db/registry` exports), for the RPC stub and the Durable Object
 * alike; the untransformed `action()` and the test harness use it too.
 */
export const actionArgsType = ((...definition: unknown[]) =>
  unknownInput.pipe(
    dropUndefinedKeys,
    (type as unknown as (...args: unknown[]) => ReturnType<typeof type>)(...definition)
  )) as unknown as typeof type;
