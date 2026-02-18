// Re-export drizzle-orm SQLite schema builders so consumers
// don't need a direct drizzle-orm dependency.
//
// `table` wraps Drizzle's `sqliteTable` to auto-convert table names to
// snake_case, so `table('userProfiles', {...})` creates table `user_profiles`.
// Column names without explicit strings are also auto-snake_cased by
// drizzle-kit's casing option during migration generation.
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { toSnakeCase } from 'drizzle-orm/casing';

export const table: typeof sqliteTable = ((
  name: string,
  columns: any,
  extraConfig?: any,
) => sqliteTable(toSnakeCase(name), columns, extraConfig)) as any;

export {
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
