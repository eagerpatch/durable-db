import type { Kysely } from 'kysely';
import type { Kyselify } from 'drizzle-orm/kysely';
import type { SQLiteTableWithColumns, SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { type as arkType } from 'arktype';

/**
 * Configuration for defineDatabase
 */
export interface DatabaseConfig<TSchema extends Record<string, SQLiteTableWithColumns<any>>> {
  /** Path to migrations directory, relative to the database file */
  migrationsDir: string;
  /** Drizzle schema tables */
  schema: TSchema;
  /** Instance strategy - 'per-shop' (default) or 'global' */
  instance?: 'per-shop' | 'global';
}

/**
 * Convert a Drizzle schema to Kysely database types using drizzle-kysely
 * 
 * @example
 * ```ts
 * import { users, posts } from './schema';
 * 
 * type DB = DrizzleToKysely<{ users: typeof users; posts: typeof posts }>;
 * // DB = { users: Kyselify<typeof users>; posts: Kyselify<typeof posts> }
 * ```
 */
export type DrizzleToKysely<TSchema extends Record<string, SQLiteTableWithColumns<any>>> = {
  [K in keyof TSchema]: TSchema[K] extends SQLiteTableWithColumns<any>
    ? Kyselify<TSchema[K]>
    : never;
};

/**
 * ArkType schema for action args
 * Can be an object of type definitions or an ArkType type instance
 */
export type ArgsSchema = Record<string, unknown> | ReturnType<typeof arkType>;

/**
 * Infer the validated type from an ArkType schema
 * ArkType handles the actual inference, this is a simplified representation
 */
export type InferArgs<T> = T extends ReturnType<typeof arkType<infer U>> 
  ? U 
  : T extends Record<string, unknown>
    ? InferArgsFromObject<T>
    : never;

/**
 * Infer types from a plain object schema
 */
type InferArgsFromObject<T extends Record<string, unknown>> = {
  [K in keyof T]: InferArgType<T[K]>;
};

/**
 * Infer a single arg type from an ArkType definition string
 */
type InferArgType<T> = 
  T extends 'string' ? string :
  T extends 'number' ? number :
  T extends 'boolean' ? boolean :
  T extends 'string?' ? string | undefined :
  T extends 'number?' ? number | undefined :
  T extends 'boolean?' ? boolean | undefined :
  T extends 'string.email' ? string :
  T extends 'string.uuid' ? string :
  T extends 'string.url' ? string :
  T extends 'string.date' ? string :
  T extends `number > ${number}` ? number :
  T extends `number >= ${number}` ? number :
  T extends `number < ${number}` ? number :
  T extends `number <= ${number}` ? number :
  T extends `'${infer L}' | '${infer R}'` ? L | R :
  T extends `'${infer L}'` ? L :
  T extends { type: infer U } ? InferArgType<U> :
  unknown;

/**
 * Context passed to action handlers
 * Provides access to environment bindings for cross-DO calls
 */
export interface ActionContext<TEnv = unknown> {
  /** Environment bindings (DO bindings, KV, etc.) */
  env: TEnv;
  /** 
   * The instance key used to address this Durable Object.
   * For per-shop databases, this is the shop ID.
   * For global databases, this is 'global'.
   * Used internally for cross-database RPC calls.
   */
  instanceKey: string;
}

/**
 * Configuration for an action
 */
export interface ActionConfig<
  TArgs extends ArgsSchema,
  TResult,
  TSchema extends Record<string, SQLiteTableWithColumns<any>>,
  TEnv = unknown,
> {
  /** 
   * ArkType schema for args validation
   * Can be a plain object with string type definitions or an ArkType type instance
   */
  args: TArgs;
  /** 
   * The action handler - receives Kysely db instance typed from your Drizzle schema
   * @param db - Kysely database instance
   * @param args - Validated arguments
   * @param ctx - Context with env bindings (for cross-DO calls)
   */
  handler: (
    db: Kysely<DrizzleToKysely<TSchema>>, 
    args: InferArgs<TArgs>,
    ctx: ActionContext<TEnv>
  ) => Promise<TResult>;
}

/**
 * An action function that can be called from routes or other actions
 */
export type Action<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

/**
 * Return type of defineDatabase
 */
export interface DatabaseDefinition<TSchema extends Record<string, SQLiteTableWithColumns<any>>> {
  /**
   * Define an action that runs within the database context
   */
  action: <TArgs extends ArgsSchema, TResult>(
    config: ActionConfig<TArgs, TResult, TSchema>
  ) => Action<InferArgs<TArgs>, TResult>;
}

/**
 * Information about a parsed database file
 */
export interface DatabaseInfo {
  /** File path to the database definition file */
  filePath: string;
  /** Database name derived from filename */
  name: string;
  /** Class name for the Durable Object */
  className: string;
  /** Binding name for wrangler config */
  bindingName: string;
  /** Instance strategy */
  instance: 'per-shop' | 'global';
  /** Path to migrations directory */
  migrationsDir: string;
  /** Schema import source (relative path) */
  schemaImport: string | null;
  /** Names of schema tables */
  schemaTableNames: string[];
  /** Loaded migrations - Map of name -> SQL statements */
  migrations?: Map<string, string[]>;
}

/**
 * Information about a parsed action
 */
export interface ActionInfo {
  /** Export name of the action */
  exportName: string;
  /** The args schema (as source code string for codegen) */
  argsSchemaSource: string;
  /** The handler function (as source code string for codegen) */
  handlerSource: string;
  /** The database this action belongs to */
  databaseName: string;
  /** File where the action is defined */
  sourceFile: string;
  /** Names of other actions from the SAME database called within this handler (transformed to this.x()) */
  internalActionCalls: string[];
  /** Names of actions from OTHER databases called within this handler (need special handling) */
  crossDbActionCalls: string[];
}

/**
 * Result of parsing a database file
 */
export interface ParsedDatabaseFile {
  /** Absolute file path */
  filePath: string;
  /** Database configuration if this file has defineDatabase */
  database: DatabaseInfo | null;
  /** Actions defined in this file */
  actions: ActionInfo[];
  /** Local imports (for dependency resolution) */
  localImports: Map<string, { source: string; imported: string }>;
}
