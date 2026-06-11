export { defineDatabase } from './defineDatabase';
export { SqliteDurableObject, createKyselyFromSql, MigrationSchemaConflictError } from './SqliteDurableObject';
export type { Migration, Migrations, CreateKyselyOptions, SqlExecutor, MigrationAttemptInfo } from './SqliteDurableObject';

// Re-export Outerbase Studio helper for worker-level UI route
export { studio } from '@outerbase/browsable-durable-object';

// Plugins
export {
  SchemaPlugin,
  DrizzleDefaultsPlugin,
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
