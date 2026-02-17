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
 * Define a database with its schema and migrations.
 *
 * This function is transformed at build time by the durable-db Vite plugin.
 * At runtime, the actions returned will be RPC stubs that call into the
 * generated Durable Object.
 *
 * @example
 * ```ts
 * import { defineDatabase } from '@eagerpatch/durable-db/db';
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

    // This is a placeholder that will be replaced by the Vite plugin
    // with an RPC stub. During static analysis, we just need this to
    // be a valid function.
    const actionFn = async (args: InferArgs<TArgs>): Promise<TResult> => {
      // Validate args
      const result = validator(args);
      if (result instanceof type.errors) {
        throw new Error(`Invalid args: ${result.summary}`);
      }

      // This error helps catch cases where the transform didn't run
      throw new Error(
        'Action called without transformation. ' +
        'Make sure the durable-db plugin is configured in your Vite config.'
      );
    };

    return actionFn;
  };

  return { action } as unknown as DatabaseDefinition<TSchema>;
}
