import { type } from 'arktype';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import type {
  DatabaseConfig,
  DatabaseDefinition,
  ActionConfig,
  Action,
  ArgsSchema,
  InferArgs
} from './types';

/**
 * Non-enumerable property the source `action()` stashes on the function it
 * returns, carrying the original `{ args, handler }` config plus the compiled
 * arktype validator. The production Vite transform replaces `action()`
 * call-sites entirely, so this only ever exists in the UNTRANSFORMED world —
 * i.e. tests. The `durable-db/testing` harness reads it to run a handler
 * against a real in-memory database. See src/testing/index.ts.
 */
export const ACTION_TEST_META = Symbol.for('durable-db.actionTestMeta');

/** Shape stashed under {@link ACTION_TEST_META}. */
export interface ActionTestMeta {
  args: ArgsSchema;
  handler: (db: any, args: any, ctx?: any) => unknown;
  validator: ReturnType<typeof type>;
}

/**
 * Define a database with its schema and migrations.
 *
 * This function is transformed at build time by the durable-db Vite plugin.
 * At runtime, the actions returned will be RPC stubs that call into the
 * generated Durable Object.
 *
 * @example
 * ```ts
 * import { defineDatabase } from 'durable-db';
 * import { users, posts } from './schema';
 *
 * export const { action } = defineDatabase({
 *   schema: { users, posts },
 * });
 *
 * export const createUser = action({
 *   args: { name: 'string', email: 'string.email' },
 *   handler: async (db, args) => {
 *     return db.insertInto('users').values({
 *       id: crypto.randomUUID(),
 *       name: args.name,
 *       email: args.email
 *     }).returningAll().executeTakeFirst();
 *   },
 * });
 * ```
 */
export function defineDatabase<TSchema extends Record<string, SQLiteTableWithColumns<any>>>(
  _config: DatabaseConfig<TSchema>
): DatabaseDefinition<TSchema> {
  // This is the "source" implementation that exists in user code.
  // The Vite plugin will:
  // 1. Extract all action() calls and their handlers
  // 2. Generate a Durable Object class with these handlers as methods
  // 3. Replace this file's exports with RPC stubs

  const action = <TArgs extends ArgsSchema, TResult>(
    actionConfig: ActionConfig<TArgs, TResult, TSchema>
  ): Action<InferArgs<TArgs>, TResult> => {
    // Create the validator from the args schema
    // ArkType's type() returns a validator function
    const validator = type(actionConfig.args as Record<string, unknown>);

    // Summarize the args schema so placeholder errors carry enough info
    // to identify which action fired. We don't know the export name here
    // (it's assigned downstream), so the shape is the best hint.
    const argKeys = Object.keys(actionConfig.args as Record<string, unknown>);
    const argsHint = argKeys.length > 0
      ? `args: { ${argKeys.join(', ')} }`
      : 'args: {}';

    // This is a placeholder that will be replaced by the Vite plugin
    // with an RPC stub. During static analysis, we just need this to
    // be a valid function.
    const actionFn = async (args: InferArgs<TArgs>): Promise<TResult> => {
      // Validate args
      const result = validator(args);
      if (result instanceof type.errors) {
        throw new Error(`Invalid args for action (${argsHint}): ${result.summary}`);
      }

      // This error helps catch cases where the transform didn't run
      throw new Error(
        `Action (${argsHint}) called without transformation. ` +
        'Make sure the durable-db plugin is configured in your Vite config.'
      );
    };

    // Stash the handler + validator so the test harness can run this action
    // against a real in-memory db (the production transform never reaches this
    // code path — it rewrites the call-site). Non-enumerable so it stays
    // invisible to anything iterating the function's own keys.
    Object.defineProperty(actionFn, ACTION_TEST_META, {
      value: {
        args: actionConfig.args,
        handler: actionConfig.handler,
        validator,
      } satisfies ActionTestMeta,
      enumerable: false,
      configurable: true,
    });

    return actionFn;
  };

  const destroyDatabase = async (): Promise<void> => {
    throw new Error(
      'destroyDatabase() called without transformation. ' +
      'Make sure the durable-db plugin is configured in your Vite config.'
    );
  };

  return { action, destroyDatabase } as unknown as DatabaseDefinition<TSchema>;
}
