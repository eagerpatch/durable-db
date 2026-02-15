export { defineDatabase } from './defineDatabase';
export { SqliteDurableObject, createKyselyFromSql } from './SqliteDurableObject';
export type { Migration, Migrations, CreateKyselyOptions, SqlExecutor } from './SqliteDurableObject';

// Plugins
export {
  SchemaPlugin,
  DateSerializePlugin,
  dateSerializers,
  createDrizzlePlugins
} from './plugins';

// Types
export type {
  // Config types
  DatabaseConfig,
  DatabaseDefinition,
  ActionConfig,
  Action,
  ArgsSchema,
  ActionContext,

  // Type utilities
  DrizzleToKysely,
  InferArgs,

  // Internal types (for plugin use)
  DatabaseInfo,
  ActionInfo,
  ParsedDatabaseFile,
} from './types';

// Re-export Kysely types users will need
export type { Kysely, CompiledQuery, QueryResult, KyselyPlugin } from 'kysely';
export { CamelCasePlugin } from 'kysely';

// Re-export arktype for users who want custom validation
export { type } from 'arktype';
