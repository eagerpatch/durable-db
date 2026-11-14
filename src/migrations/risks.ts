import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import { applyRenames, shape, type RenameAnswer } from './renames';

type Snapshot = DrizzleSQLiteSnapshotJSON;

// ============================================================================
// Migration risks
// ============================================================================
//
// A migration replayed on an empty database (what `db validate` does) proves
// little about the tenants that have rows: per-tenant Durable Objects migrate
// lazily, so a statement that only fails on a non-empty table surfaces after
// the deploy, once per tenant with data — and that tenant's database stays
// broken until a fixed migration ships. These checks read the schema change
// itself, so they hold whatever SQL drizzle-kit chose (an ALTER, or a table
// recreation that copies the rows).

export type MigrationRiskKind =
  | 'add-not-null-without-default'
  | 'set-not-null'
  | 'add-foreign-key'
  | 'drop-column'
  | 'drop-table';

export interface MigrationRisk {
  kind: MigrationRiskKind;
  /** `error`: fails on every table that has rows. `warning`: loses data, or may fail. */
  severity: 'error' | 'warning';
  table: string;
  column?: string;
  message: string;
}

/** What a foreign key references, as one string: the same key before and after is no change. */
const referenceOf = (key: { tableTo: string; columnsFrom: string[]; columnsTo: string[] }): string =>
  `${key.columnsFrom.join(',')}->${key.tableTo}(${key.columnsTo.join(',')})`;

/** The remedy `db generate` prints when it refuses a NOT NULL column without a default. */
export const NOT_NULL_WITHOUT_DEFAULT_HINT =
  'fails on every table that has rows: add .default(...) or add it nullable and backfill';

/**
 * What the change `prev` → `cur` risks on a database that has rows, given the
 * renames it performs (pass {@link renamesFromStatements} of the generated
 * SQL, so interactive answers count too).
 */
export function analyzeMigrationRisks(
  prevSnapshot: Snapshot,
  curSnapshot: Snapshot,
  renames: RenameAnswer[] = []
): MigrationRisk[] {
  const before = shape(renames.length > 0 ? applyRenames(prevSnapshot, curSnapshot, renames).snapshot : prevSnapshot);
  const cur = shape(curSnapshot);
  const risks: MigrationRisk[] = [];

  for (const [name, table] of Object.entries(before.tables ?? {})) {
    const after = cur.tables?.[name];
    if (!after) {
      risks.push({
        kind: 'drop-table',
        severity: 'warning',
        table: name,
        message: `table ${name} is dropped — its rows are lost`,
      });
      continue;
    }

    for (const column of Object.keys(table.columns)) {
      if (!(column in after.columns)) {
        risks.push({
          kind: 'drop-column',
          severity: 'warning',
          table: name,
          column,
          message: `${name}.${column} is dropped — its data is lost`,
        });
      }
    }

    for (const [column, definition] of Object.entries(after.columns)) {
      const existing = table.columns[column];
      const hasDefault = definition.default !== undefined;
      if (!existing) {
        // An INTEGER PRIMARY KEY is the rowid: SQLite fills it in.
        const rowid = definition.primaryKey && definition.type.toLowerCase() === 'integer';
        if (definition.notNull && !hasDefault && !definition.generated && !rowid) {
          risks.push({
            kind: 'add-not-null-without-default',
            severity: 'error',
            table: name,
            column,
            message: `${name}.${column} is added NOT NULL without a default — the migration ${NOT_NULL_WITHOUT_DEFAULT_HINT}`,
          });
        }
      } else if (definition.notNull && !existing.notNull && !definition.primaryKey) {
        risks.push({
          kind: 'set-not-null',
          severity: 'warning',
          table: name,
          column,
          message:
            `${name}.${column} becomes NOT NULL — the migration fails on a database where a row ` +
            `holds NULL there: backfill it first`,
        });
      }
    }

    // A foreign key that a table with rows did not have: the table is rebuilt
    // with it, and a row that references nothing fails the copy. A database
    // whose migration fails answers no call until a fixed one ships.
    const had = new Set(Object.values(table.foreignKeys ?? {}).map(referenceOf));
    for (const key of Object.values(after.foreignKeys ?? {})) {
      if (had.has(referenceOf(key))) continue;
      const from = key.columnsFrom.join(', ');
      risks.push({
        kind: 'add-foreign-key',
        severity: 'warning',
        table: name,
        ...(key.columnsFrom.length === 1 ? { column: key.columnsFrom[0] } : {}),
        message:
          `${name}.${from} now references ${key.tableTo}.${key.columnsTo.join(', ')} — the migration fails on a database ` +
          `where a row of ${name} references a row of ${key.tableTo} that is not there, and that database answers nothing ` +
          `until it passes: remove or repair those rows in a migration before this one`,
      });
    }
  }

  return risks;
}
