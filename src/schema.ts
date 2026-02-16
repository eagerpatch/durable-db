// Re-export drizzle-orm SQLite schema builders so consumers
// don't need a direct drizzle-orm dependency.
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
