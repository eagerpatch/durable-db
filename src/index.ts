// Database definition
export { defineDatabase } from './db/defineDatabase';

// Schema builders (from drizzle-orm/sqlite-core)
export {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  numeric,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
export type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// Tenant context
export {
  setTenantIdResolver,
  getTenantId,
  runWithTenantId,
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
