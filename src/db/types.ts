import type { Kysely } from 'kysely';
import type { Kyselify } from 'drizzle-orm/kysely';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { type as arkType } from 'arktype';

/**
 * Configuration for defineDatabase
 */
export interface DatabaseConfig<
  TSchema extends Record<string, SQLiteTableWithColumns<any>>,
> {
  /** Path to migrations directory, relative to the database file */
  migrationsDir: string;
  /** Drizzle schema tables */
  schema: TSchema;
  /** Instance strategy - 'per-shop' (default) or 'global' */
  instance?: 'per-shop' | 'global';
}

/**
 * Convert a Drizzle schema to Kysely database types using drizzle-kysely
 */
export type DrizzleToKysely<
  TSchema extends Record<string, SQLiteTableWithColumns<any>>,
> = {
  [K in keyof TSchema]: TSchema[K] extends SQLiteTableWithColumns<any>
    ? Kyselify<TSchema[K]>
    : never;
};

/**
 * ArkType helpers – mirror Ark's own API:
 *   - arkType.validate<Def>  → definition shape with DSL validation/autocomplete
 *   - arkType.infer<Def>     → inferred output type
 */
export type ArkDef<Def> = arkType.validate<Def>;
export type InferArgs<Def> = arkType.infer<Def>;

/**
 * Context passed to action handlers
 */
export interface ActionContext<TEnv = unknown> {
  /** Environment bindings (DO bindings, KV, etc.) */
  env: TEnv;
  /**
   * The instance key used to address this Durable Object.
   * For per-shop databases, this is the shop ID.
   * For global databases, this is 'global'.
   */
  instanceKey: string;
}

/**
 * Configuration for an action
 *
 * `Def` is "the ArkType definition" – whatever you'd normally pass to `type(...)`:
 *   { name: "string", email: "string.email" }
 *   unions, tuples, ranges, etc. all work.
 */
export interface ActionConfig<
  Def,
  TResult,
  TSchema extends Record<string, SQLiteTableWithColumns<any>>,
  TEnv = unknown,
> {
  /**
   * ArkType definition for args.
   * Typed as `arkType.validate<Def>` so you get the SAME DSL autocomplete
   * as when you do `type(Def)` directly.
   */
  args: ArkDef<Def>;

  /**
   * The action handler
   */
  handler: (
    db: Kysely<DrizzleToKysely<TSchema>>,
    args: InferArgs<Def>,
    ctx: ActionContext<TEnv>,
  ) => Promise<TResult>;
}

/**
 * An action function that can be called from routes or other actions
 */
export type Action<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

/**
 * Return type of defineDatabase
 */
export interface DatabaseDefinition<
  TSchema extends Record<string, SQLiteTableWithColumns<any>>,
> {
  /**
   * Define an action that runs within the database context
   *
   * NOTE: the `const Def` *here* is crucial – it matches ArkType's own
   * `<const def>(def: type.validate<def>)` pattern and is what makes
   * `"string.email"` etc. behave properly.
   */
  action: <const Def, TResult, TEnv = unknown>(
    config: ActionConfig<Def, TResult, TSchema, TEnv>,
  ) => Action<InferArgs<Def>, TResult>;
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
