// Re-export drizzle-orm SQLite schema builders so consumers
// don't need a direct drizzle-orm dependency.
//
// `table` wraps Drizzle's `sqliteTable` to auto-convert table names to
// snake_case, so `table('userProfiles', {...})` creates table `user_profiles`.
// Column names without explicit strings are also auto-snake_cased by
// drizzle-kit's casing option during migration generation.
import type { ColumnBuilderBaseConfig, ColumnBuilderExtraConfig, ColumnDataType } from 'drizzle-orm';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn, UpdateDeleteAction } from 'drizzle-orm/sqlite-core';
import { toSnakeCase } from 'drizzle-orm/casing';

// A foreign key is a relation, and its type should say so. Drizzle's
// `.references()` returns the builder unchanged: at the type level a column
// forgets what it points at. This overload keeps the target on the column
// (`_.references`), which is what `Relations<Schema>` reads — in both
// directions, with the nullability of the column. Nothing changes at runtime,
// and nothing that compiled before stops compiling.
//
// A table that references itself, or two that reference each other, still
// needs Drizzle's own escape — `(): AnySQLiteColumn => parent.id` — and such a
// reference is a relation at runtime but not in the types.
declare module 'drizzle-orm/sqlite-core/columns/common' {
  interface SQLiteColumnBuilder<
    T extends ColumnBuilderBaseConfig<ColumnDataType, string> = ColumnBuilderBaseConfig<ColumnDataType, string>,
    TRuntimeConfig extends object = object,
    TTypeConfig extends object = object,
    TExtraConfig extends ColumnBuilderExtraConfig = object,
  > {
    references<C extends AnySQLiteColumn>(
      ref: () => C,
      actions?: { onUpdate?: UpdateDeleteAction; onDelete?: UpdateDeleteAction },
    ): this & { _: { references: C } };
  }
}

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
