import { type } from '../arktypeConfig'; // jitless `type` — eval-free for Workers
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { actionArgsType } from './actionArgs';
import type {
  DatabaseConfig,
  DatabaseDefinition,
  ActionConfig,
  Action,
  ArgsSchema,
  InferArgs
} from './types';

type Schema = Record<string, SQLiteTableWithColumns<any>>;

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
  /** The schema of the action's database (`defineDatabase({ schema })`). */
  schema: Schema;
}

/**
 * A database the `durable-db/testing` harness created (`createTestDatabase`),
 * published so an untransformed action call — code under test calling an
 * action directly — runs against the test database holding its tables.
 */
export interface LiveTestDatabase {
  /** The tables the test database was created with. */
  tables: ReadonlySet<unknown>;
  /** Run an action against it: validate its args, invoke its handler. */
  run(action: (args: any) => Promise<unknown>, args: unknown): Promise<unknown>;
  /** Drop every row: what `destroyDatabase()` does to a Durable Object. */
  clear(): void;
}

/**
 * Where the live test databases are listed, newest last. On `globalThis`, not
 * module state: a test run can load `durable-db` (the app's actions) and
 * `durable-db/testing` as separate module copies.
 */
export const LIVE_TEST_DATABASES = Symbol.for('durable-db.liveTestDatabases');

/** The live test databases (created on first use). */
export function liveTestDatabases(): LiveTestDatabase[] {
  const store = globalThis as Record<symbol, LiveTestDatabase[] | undefined>;
  return (store[LIVE_TEST_DATABASES] ??= []);
}

/** The newest live test database holding every table of `schema`, if any. */
function testDatabaseFor(schema: Schema): LiveTestDatabase | undefined {
  const tables = Object.values(schema);
  if (tables.length === 0) return undefined;
  const live = (globalThis as Record<symbol, LiveTestDatabase[] | undefined>)[LIVE_TEST_DATABASES];
  if (!live) return undefined;
  for (let i = live.length - 1; i >= 0; i--) {
    if (tables.every((table) => live[i].tables.has(table))) return live[i];
  }
  return undefined;
}

/** `createTestDatabase({ schema: { a, b } })` for this database, for messages. */
function testDatabaseHint(schema: Schema): string {
  const names = Object.keys(schema);
  return `createTestDatabase({ schema: { ${names.length > 0 ? names.join(', ') : '…'} } })`;
}

/**
 * Define a database with its schema and migrations.
 *
 * This function is transformed at build time by the durable-db Vite plugin.
 * At runtime, the actions returned will be RPC stubs that call into the
 * generated Durable Object.
 *
 * Outside the build — code under test calling an action directly — an action
 * runs against the test database `createTestDatabase()` created for its
 * database's tables (the newest one, when there are several); without one it
 * throws.
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
  config: DatabaseConfig<TSchema>
): DatabaseDefinition<TSchema> {
  // This is the "source" implementation that exists in user code.
  // The Vite plugin will:
  // 1. Extract all action() calls and their handlers
  // 2. Generate a Durable Object class with these handlers as methods
  // 3. Replace this file's exports with RPC stubs
  const schema: Schema = config?.schema ?? {};

  const action = <TArgs extends ArgsSchema, TResult>(
    actionConfig: ActionConfig<TArgs, TResult, TSchema>
  ): Action<InferArgs<TArgs>, TResult> => {
    // Create the validator from the args schema, exactly as the transform
    // does (undefined-valued keys dropped before validation).
    const validator = actionArgsType(actionConfig.args as Record<string, unknown>);

    // Summarize a plain-object args schema so errors identify the action (its
    // export name is assigned downstream). An args given as `type({...})` is
    // an ArkType function whose own keys are internals: no hint then.
    const argsDefinition = actionConfig.args as unknown;
    const argKeys = argsDefinition !== null && typeof argsDefinition === 'object'
      ? Object.keys(argsDefinition)
      : null;
    const argsHint = argKeys
      ? ` (args: ${argKeys.length > 0 ? `{ ${argKeys.join(', ')} }` : '{}'})`
      : '';

    const actionFn = async (args: InferArgs<TArgs>): Promise<TResult> => {
      // Under test: run against the test database made for these tables.
      const testDatabase = testDatabaseFor(schema);
      if (testDatabase) {
        return (await testDatabase.run(actionFn, args)) as TResult;
      }

      const result = validator(args);
      if (result instanceof type.errors) {
        throw new Error(`Invalid args for action${argsHint}: ${result.summary}`);
      }

      // Not transformed, and no test database to run against.
      throw new Error(
        `Action${argsHint} called without transformation: action() call sites are transformed ` +
        `by the build; in tests, create the database with ${testDatabaseHint(schema)} ` +
        `and call the action, or use db.run(action, args).`
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
        schema,
      } satisfies ActionTestMeta,
      enumerable: false,
      configurable: true,
    });

    return actionFn;
  };

  const destroyDatabase = async (): Promise<void> => {
    const testDatabase = testDatabaseFor(schema);
    if (testDatabase) {
      testDatabase.clear();
      return;
    }
    throw new Error(
      'destroyDatabase() called without transformation: it is transformed by the build; ' +
      `in tests, create the database with ${testDatabaseHint(schema)} first.`
    );
  };

  return { action, destroyDatabase } as unknown as DatabaseDefinition<TSchema>;
}
