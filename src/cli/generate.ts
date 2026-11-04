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
import { saveSnapshot, generateMigrationName } from '../migrations/generator';
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
   * Write the migration even when a statement fails on every table that has
   * rows (a NOT NULL column without a default) — e.g. a table known to be
   * empty in every tenant.
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

  for (const { db, diff } of diffs) {
    const result = writeMigration(db, diff, customName);
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
  const sqlContent = diff.statements.map(s => s.endsWith(';') ? s : `${s};`).join('\n\n');
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
