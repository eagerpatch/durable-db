export { defineDatabase } from './defineDatabase';
export { relationsOf, relationOf } from './relations';
export type { AnySchema, Relation, RelationMap, Relations, RelationType } from './relations';
export { RelatedExpression, createRelated } from './related';
export type { AnyRelated, Related, RelatedOptions, RelatedSpec, RelatedWhere } from './related';
export { SqliteDurableObject, createKyselyFromSql, MigrationSchemaConflictError } from './SqliteDurableObject';
export { outboxSink, queueOutboxSink, tenantOfInstanceKey } from './outbox';
export type { Outbox, OutboxEnvelope, OutboxMessage, OutboxSink, OutboxSinkContext, OutboxSinkModule } from './outbox';
export {
  RemovedDatabaseDurableObject,
  RemovedDatabaseError,
  removedDatabaseMessage,
  type DeleteClassMigration,
} from './RemovedDatabaseDurableObject';
export type { Migration, Migrations, CreateKyselyOptions, SqlExecutor, MigrationAttemptInfo } from './SqliteDurableObject';

// Re-export Outerbase Studio helper for worker-level UI route
export { studio } from '@outerbase/browsable-durable-object';

// Plugins
export {
  SchemaPlugin,
  DrizzleDefaultsPlugin,
  DateSerializePlugin,
  dateSerializers,
  createDrizzlePlugins,
  createJsonPlugins,
  parseJsonValue,
  type JsonPluginOptions
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
export { type } from '../arktypeConfig'; // jitless `type` — eval-free for Workers
