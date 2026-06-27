import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadDevState,
  saveDevState,
  clearDatabaseDevState,
} from './state';
import { type Snapshot } from '../migrations/snapshot';
import { saveSnapshot, generateMigrationName } from '../migrations/generator';
import { discoverDatabases, loadSchema, diffSchema } from './shared';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface GenerateContext {
  projectRoot?: string;
  databasesDir?: string;
  migrationsDir?: string;
  verbose?: boolean;
}

export interface GenerateOptions {
  /** Custom migration name suffix (e.g., 'add_user_bio') */
  name?: string;
  /** Only generate for this database */
  database?: string;
}

export interface GenerateResult {
  database: string;
  hasChanges: boolean;
  statements: string[];
  migrationName: string | null;
  migrationPath: string | null;
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
  const { name: customName, database: targetDb } = options;
  const results: GenerateResult[] = [];

  // Load global dev state
  const devState = loadDevState(projectRoot);

  const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir, database: targetDb });

  if (databases.length === 0) {
    debugCli('No databases found');
    return results;
  }

  for (const db of databases) {
    const result = await generateDatabase(db, customName, projectRoot);
    results.push(result);

    // Clear dev state for this database if migration was generated
    if (result.hasChanges) {
      clearDatabaseDevState(projectRoot, db.name);
      if (devState.databases[db.name]) {
        delete devState.databases[db.name];
      }
    }
  }

  // Save updated dev state
  saveDevState(projectRoot, devState);

  return results;
}

/**
 * Generate migration for a single database
 */
async function generateDatabase(
  db: DatabaseInfo,
  customName: string | undefined,
  projectRoot: string,
): Promise<GenerateResult> {
  const result: GenerateResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
    migrationPath: null,
  };

  const schema = await loadSchema(db, projectRoot);
  if (!schema) {
    return result;
  }

  const diff = await diffSchema(schema, db.migrationsDir);

  if (!diff.hasChanges) {
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
  const results = await generate(ctx, { ...options, database: dbName });
  return results.length > 0 ? results[0] : null;
}
