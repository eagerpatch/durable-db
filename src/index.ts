// Database definition
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

// Tenant context
export {
  setTenantIdResolver,
  getTenantId,
  hasTenantId,
} from './context';

// Kysely re-exports
export type { Kysely } from 'kysely';

// Arktype re-export
export { type } from 'arktype';

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
