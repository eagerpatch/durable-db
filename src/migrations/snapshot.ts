import {
  DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';

import { createRequire } from 'node:module'
import {
  applyRenames,
  findAmbiguities,
  parseRenameSpec,
  SchemaRenameRequiredError,
  withoutRemoved,
  type RenameAnswer,
} from './renames';
const require = createRequire(import.meta.url)
const { generateSQLiteDrizzleJson, generateSQLiteMigration } = require('drizzle-kit/api') as typeof import('drizzle-kit/api')

export type Snapshot = DrizzleSQLiteSnapshotJSON;

export {
  applyRenames,
  describeAmbiguity,
  exampleRenames,
  findAmbiguities,
  formatRename,
  parseRenameSpec,
  renamesFromStatements,
  SchemaRenameRequiredError,
  unusedRenames,
  type RenameAnswer,
  type SchemaAmbiguity,
} from './renames';
export {
  analyzeMigrationRisks,
  NOT_NULL_WITHOUT_DEFAULT_HINT,
  type MigrationRisk,
  type MigrationRiskKind,
} from './risks';

/**
 * How to answer drizzle-kit's "created or renamed?" questions — asked when a
 * table (or a table's columns) has both a new and a vanished name.
 */
export interface MigrationResolution {
  /**
   * Renames, as `RenameAnswer`s or `<table>.<old>=<new>` / `<old>=<new>`
   * strings. Applied before drizzle-kit diffs, so it never asks about them.
   */
  renames?: Array<RenameAnswer | string>;
  /**
   * Answer every remaining question with "create": the vanished column/table
   * is dropped (its data is lost) and the new one created.
   */
  noRenames?: boolean;
  /**
   * Whether drizzle-kit may prompt for what is still unanswered. Default:
   * when stdin and stdout are TTYs. Without prompts an unanswered question
   * throws {@link SchemaRenameRequiredError} (instead of drizzle-kit's bare
   * "Interactive prompts require a TTY terminal").
   */
  interactive?: boolean;
}

/** Whether drizzle-kit's prompts can run (it checks the same). */
export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Create an empty snapshot (for initial migration from nothing)
 */
export function createEmptySnapshot(): Snapshot {
  return {
    views: {},
    version: '6',
    dialect: 'sqlite',
    id: '0000000000000',
    prevId: '',
    tables: {},
    enums: {},
    _meta: {
      tables: {},
      columns: {},
    }
  };
}

/**
 * Generate a unique snapshot ID based on timestamp
 */
export function generateSnapshotId(): string {
  return Date.now().toString(36).padStart(13, '0');
}

/**
 * Generate a snapshot from Drizzle schema objects
 *
 * @param schema - Object containing Drizzle table definitions
 * @returns Snapshot representing the current schema state
 *
 * @example
 * ```ts
 * import { users, posts } from './schema';
 * const snapshot = await generateSnapshotFromSchema({ users, posts });
 * ```
 */
export async function generateSnapshotFromSchema(
  schema: Record<string, unknown>
) {
  return generateSQLiteDrizzleJson(schema, undefined, 'snake_case');
}

/**
 * Generate SQL migration statements from two snapshots
 *
 * @param from - Previous schema state (or empty for initial migration)
 * @param to - Target schema state
 * @returns Array of SQL statements to migrate from `from` to `to`
 *
 * @example
 * ```ts
 * const statements = await generateMigrationStatements(prevSnapshot, newSnapshot);
 * // ['CREATE TABLE users (...)', 'CREATE INDEX ...']
 * ```
 */
export async function generateMigrationStatements(
  from: Snapshot,
  to: Snapshot,
  resolution: MigrationResolution = {}
): Promise<string[]> {
  const answers = (resolution.renames ?? []).map((r) => (typeof r === 'string' ? parseRenameSpec(r) : r));
  const renamed = answers.length > 0
    ? applyRenames(from, to, answers)
    : { snapshot: from, statements: [] as string[] };
  const ambiguities = findAmbiguities(renamed.snapshot, to);

  if (ambiguities.length === 0) {
    return [...renamed.statements, ...(await generateSQLiteMigration(renamed.snapshot, to))];
  }

  if (resolution.noRenames) {
    // Two diffs, neither of which has both a new and a vanished name.
    const dropped = withoutRemoved(renamed.snapshot, to);
    return [
      ...renamed.statements,
      ...(await generateSQLiteMigration(renamed.snapshot, dropped)),
      ...(await generateSQLiteMigration(dropped, to)),
    ];
  }

  if (!(resolution.interactive ?? canPrompt())) {
    throw new SchemaRenameRequiredError(ambiguities);
  }

  // drizzle-kit asks in the terminal.
  return [...renamed.statements, ...(await generateSQLiteMigration(renamed.snapshot, to))];
}

/**
 * Serialize the schema-relevant parts of a snapshot for comparison/hashing.
 * Includes tables, views, and enums so that changes to any of them are
 * detected — previously only `tables` was considered.
 */
function serializeSchemaShape(snapshot: Snapshot): string {
  return JSON.stringify({
    tables: snapshot.tables ?? {},
    views: snapshot.views ?? {},
    enums: snapshot.enums ?? {},
  });
}

/**
 * Check if two snapshots are equivalent (no migration needed)
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  return serializeSchemaShape(a) === serializeSchemaShape(b);
}

/**
 * Create a hash of a snapshot for quick comparison
 */
export function hashSnapshot(snapshot: Snapshot): string {
  const content = serializeSchemaShape(snapshot);
  // Simple hash for comparison purposes
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
