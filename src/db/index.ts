// Core database functionality
export { defineDatabase } from './defineDatabase.js';
export { SqliteDurableObject, createKyselyFromSql } from './SqliteDurableObject.js';
export type { Migration, Migrations, CreateKyselyOptions, SqlExecutor } from './SqliteDurableObject.js';

// Plugins
export {
  DrizzleSchemaPlugin,
  DateSerializePlugin,
  dateSerializers,
  createDrizzlePlugins
} from './plugins.js';

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
} from './types.js';

// Re-export Kysely types users will need
export type { Kysely, CompiledQuery, QueryResult, KyselyPlugin } from 'kysely';
export { CamelCasePlugin } from 'kysely';

// Re-export arktype for users who want custom validation
export { type } from 'arktype';
