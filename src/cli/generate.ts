import type { DatabaseSource } from '../vite/modules/discovery';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadDevState,
  saveDevState,
  clearDatabaseDevState,
  forgetDatabaseDevState,
} from './state';
import { type MigrationRisk, type Snapshot } from '../migrations/snapshot';
import { saveSnapshot, generateMigrationName, loadMigrationFiles, parseSqlMigration } from '../migrations/generator';
import { replayWithRows, type RowsDatabaseConstructor, type RowsFinding } from '../migrations/withRows';
import {
  selectDatabases,
  diffDatabases,
  UnknownDatabaseError,
  type DiffResult,
  type RenameResolutionOptions,
} from './shared';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface GenerateContext {
  projectRoot?: string;
  databasesDir?: string | DatabaseSource[];
  migrationsDir?: string;
  verbose?: boolean;
}

export interface GenerateOptions extends RenameResolutionOptions {
  /** Custom migration name suffix (e.g., 'add_user_bio') */
  name?: string;
  /** Only generate for this database (an unknown name throws UnknownDatabaseError) */
  database?: string;
  /**
   * Write the migration even when it is not safe on a database that has rows
   * — a statement that fails on every table with rows (a NOT NULL column
   * without a default), or what the replay on rows finds (a foreign key over
   * rows that reference nothing, a unique index over rows that repeat).
   * Writing is not accepting: `db validate` still refuses it, until the
   * migration repairs the rows or the finding is accepted there.
   */
  force?: boolean;
}

export interface GenerateResult {
  database: string;
  hasChanges: boolean;
  statements: string[];
  migrationName: string | null;
  migrationPath: string | null;
  /**
   * What the migration risks on a database that has rows: dropped columns and
   * tables (data loss), columns made NOT NULL, and — with `force` — the
   * statements that fail on every table with rows.
   */
  warnings: string[];
}

/**
 * `db generate` refuses a migration that fails on every table that has rows.
 * Per-tenant databases migrate lazily, so the failure would surface after the
 * deploy, once per tenant with data, each of them broken until a fixed
 * migration ships — and `db validate` cannot catch it: it replays migrations
 * on an empty database.
 */
export class UnsafeMigrationError extends Error {
  constructor(readonly risks: Array<MigrationRisk & { database: string }>) {
    super(
      'Refusing to write a migration that fails on every table that has rows:\n' +
      risks.map((risk) => `  ${risk.database}: ${risk.message}`).join('\n') +
      '\nFix the schema and run generate again, or pass --force if every such table is empty everywhere.'
    );
    this.name = 'UnsafeMigrationError';
  }
}

/**
 * `db generate` refuses a migration that is not safe on a database that has
 * rows: one the replay on rows (migrations/withRows.ts) sees fail, or take
 * rows or values along. Nothing is written — unless `force`, for a migration
 * that is going to be repaired by hand before it ships.
 */
export class MigrationFailsOnRowsError extends Error {
  constructor(readonly findings: Array<RowsFinding & { database: string }>) {
    super(
      'Refusing to write a migration that is not safe on a database that has rows:\n' +
      findings.map((finding) => `  ${finding.database}: it ${finding.message}`).join('\n') +
      "\nEvery tenant's database migrates on its own, after the deploy: a migration has to pass on any rows the schema before it allows." +
      '\nChange the schema, or write it and repair the rows in it: generate --force, edit the migration, then db validate.'
    );
    this.name = 'MigrationFailsOnRowsError';
  }
}

/** The migration `db generate` is about to write, among the ones a replay runs. */
const NEW_MIGRATION = '(this migration)';

/** A migration's statements as its file holds them. */
const sqlOf = (statements: string[]): string => statements.map((s) => (s.endsWith(';') ? s : `${s};`)).join('\n\n');

/**
 * What each pending migration does to a database that has rows: the
 * production migrations replayed, then the new one, each on rows the schema
 * before it allows. Without libsql there is nothing to replay on: said, and
 * the migration is written unchecked.
 */
async function checkOnRows(diffs: Array<{ db: DatabaseInfo; diff: DiffResult | null }>): Promise<Map<string, { findings: RowsFinding[]; note?: string }>> {
  const checked = new Map<string, { findings: RowsFinding[]; note?: string }>();
  const pending = diffs.filter(({ diff }) => diff?.hasChanges);
  if (pending.length === 0) return checked;
  let Database: RowsDatabaseConstructor;
  try {
    const mod = await import('libsql');
    Database = (mod.default ?? mod) as unknown as RowsDatabaseConstructor;
  } catch {
    for (const { db } of pending) {
      checked.set(db.name, { findings: [], note: 'libsql is not installed: the migration was not replayed on a database that has rows (pnpm add -D libsql)' });
    }
    return checked;
  }
  for (const { db, diff } of pending) {
    const before = loadMigrationFiles(db.migrationsDir);
    const migrations = [...before.keys()].sort().map((name) => [name, before.get(name)!] as const);
    try {
      const replay = replayWithRows(Database, [...migrations, [NEW_MIGRATION, parseSqlMigration(sqlOf(diff!.statements))] as const]);
      checked.set(db.name, { findings: replay.findings.filter((finding) => finding.migration === NEW_MIGRATION) });
    } catch (error) {
      // The replay is a check, not the generator: what it cannot run it says, and the migration is written.
      checked.set(db.name, { findings: [], note: `the migration was not replayed on a database that has rows: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return checked;
}

// ============================================================================
// Generate Command
// ============================================================================

/**
 * Generate production migrations from schema changes
 *
 * This command:
 * 1. Compares current schema to production snapshot
 * 2. Generates a single migration file with all changes
 * 3. Updates the production snapshot
 * 4. Clears dev migrations (they're now consolidated)
 *
 * Unlike `push`, this writes to the actual migrations directory
 * that gets committed to git.
 */
export async function generate(
  ctx: GenerateContext = {},
  options: GenerateOptions = {}
): Promise<GenerateResult[]> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', migrationsDir = 'migrations' } = ctx;
  const { name: customName, database: targetDb, force = false } = options;
  const results: GenerateResult[] = [];

  // Load global dev state
  const devState = loadDevState(projectRoot);

  const databases = selectDatabases({ projectRoot, databasesDir, migrationsDir, database: targetDb });

  if (databases.length === 0) {
    debugCli('No databases found');
    return results;
  }

  // Every diff (and every refusal) before the first file is written.
  const diffs = await diffDatabases(projectRoot, databases, options);

  const blocking = diffs.flatMap(({ db, diff }) =>
    (diff?.risks ?? [])
      .filter((risk) => risk.severity === 'error')
      .map((risk) => ({ ...risk, database: db.name }))
  );
  if (blocking.length > 0 && !force) {
    throw new UnsafeMigrationError(blocking);
  }

  // And what each does to a database that has rows — replayed, not read off the schema change.
  const onRows = await checkOnRows(diffs);
  const unsafe = diffs.flatMap(({ db }) => (onRows.get(db.name)?.findings ?? []).map((finding) => ({ ...finding, database: db.name })));
  if (unsafe.length > 0 && !force) {
    throw new MigrationFailsOnRowsError(unsafe);
  }

  for (const { db, diff } of diffs) {
    const result = writeMigration(db, diff, customName);
    const checked = onRows.get(db.name);
    for (const finding of checked?.findings ?? []) {
      result.warnings.push(`it ${finding.message} — db validate refuses it until the migration repairs the rows, or it is accepted there (db validate --accept)`);
    }
    if (checked?.note) result.warnings.push(checked.note);
    results.push(result);

    // Clear dev state for this database if migration was generated
    if (result.hasChanges) {
      clearDatabaseDevState(projectRoot, db.name);
      forgetDatabaseDevState(devState, db.name);
    }
  }

  // Save updated dev state
  saveDevState(projectRoot, devState);

  return results;
}

/**
 * Write a database's migration file and its new production snapshot
 */
function writeMigration(
  db: DatabaseInfo,
  diff: DiffResult | null,
  customName: string | undefined,
): GenerateResult {
  const result: GenerateResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
    migrationPath: null,
    warnings: [],
  };

  if (!diff || !diff.hasChanges) {
    debugCli('No changes for %s', db.name);
    return result;
  }

  // Generate migration name
  const migrationName = generateMigrationName(customName ?? 'migration');

  // Ensure migrations directory exists
  fs.mkdirSync(db.migrationsDir, { recursive: true });

  // Write migration file
  const migrationPath = path.join(db.migrationsDir, `${migrationName}.sql`);
  const sqlContent = sqlOf(diff.statements);
  fs.writeFileSync(migrationPath, sqlContent);

  // Update production snapshot
  const newSnapshot: Snapshot = {
    ...diff.currentSnapshot,
    id: Date.now().toString(36).padStart(13, '0'),
    prevId: diff.prodSnapshot.id,
  };
  saveSnapshot(db.migrationsDir, newSnapshot);

  result.hasChanges = true;
  result.statements = diff.statements;
  result.migrationName = migrationName;
  result.migrationPath = migrationPath;
  result.warnings = diff.risks.map((risk) => risk.message);

  debugCli('Generated %s for %s (%d statements)', migrationName, db.name, diff.statements.length);
  debugCli('Migration path: %s', migrationPath);

  return result;
}

/**
 * Generate migration for a single database by name
 */
export async function generateOne(
  ctx: GenerateContext,
  dbName: string,
  options: Omit<GenerateOptions, 'database'> = {}
): Promise<GenerateResult | null> {
  try {
    const results = await generate(ctx, { ...options, database: dbName });
    return results.length > 0 ? results[0] : null;
  } catch (error) {
    if (error instanceof UnknownDatabaseError) return null;
    throw error;
  }
}
