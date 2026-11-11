// Database definition
export { relationsOf, relationOf } from './db/relations';
export type { AnySchema, Relation, RelationMap, Relations, RelationType } from './db/relations';
export { RelatedExpression, createRelated } from './db/related';
export type { AnyRelated, Related, RelatedOptions, RelatedSpec } from './db/related';
export { defineDatabase } from './db/defineDatabase';

// Schema builders (re-exported from ./schema with auto-snake_case table names)
export {
  table,
  text,
  integer,
  real,
  blob,
  numeric,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
} from './schema';
export type { AnySQLiteColumn } from './schema';

// What an action is, read from the function (a library that maps actions to an API)
export { describeAction } from './db/describeAction';
export type { ActionDescription } from './db/describeAction';

// Tenant context
export {
  setTenantIdResolver,
  getTenantId,
  hasTenantId,
} from './context';

// Kysely re-exports
export type { Kysely } from 'kysely';

// Arktype re-export — jitless (eval-free) `type` so Workers don't 500 on
// request-time validator codegen. See ./arktypeConfig.
export { type } from './arktypeConfig';

// Types
export type {
  DatabaseConfig,
  DatabaseDefinition,
  ActionConfig,
  Action,
  ActionContext,
  DrizzleToKysely,
  InferArgs,
} from './db/types';
export type { Outbox, OutboxEnvelope, OutboxMessage, OutboxSink, OutboxSinkContext, OutboxSinkModule } from './db/outbox';
