import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadDevState,
  saveDevState,
  clearDatabaseDevState,
  getDevPaths,
} from './state';
import {
  loadSnapshot,
  saveSnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  generateMigrationName,
  snapshotsEqual,
  hashSnapshot,
  type Snapshot,
} from '../migrations';
import { discoverDatabaseFiles, readFile, resolveImportPath } from '../vite/modules/discovery';
import { parseDatabaseFile } from '../vite/modules/parser';
import { buildAndLoadSchema } from '../migrations/generator';
import type { DatabaseInfo } from '../db';

// ============================================================================
// Types
// ============================================================================

export interface GenerateContext {
  projectRoot?: string;
  databasesDir?: string;
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
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', verbose = false } = ctx;
  const { name: customName, database: targetDb } = options;
  const results: GenerateResult[] = [];

  // Load global dev state
  const devState = loadDevState(projectRoot);

  // Discover databases
  const files = discoverDatabaseFiles({ projectRoot, databasesDir });
  
  if (files.length === 0) {
    if (verbose) {
      console.log('[db:generate] No databases found');
    }
    return results;
  }

  // Parse and process each database
  for (const file of files) {
    const code = readFile(file.absolutePath);
    const parsed = parseDatabaseFile(file.absolutePath, code);

    if (!parsed.database) {
      continue;
    }

    const db = parsed.database;

    // Skip if targeting specific database
    if (targetDb && db.name !== targetDb) {
      continue;
    }

    const result = await generateDatabase(projectRoot, db, customName, verbose);
    results.push(result);

    // Clear dev state for this database if migration was generated
    if (result.hasChanges) {
      clearDatabaseDevState(projectRoot, db.name);
      // Update dev state to track new prod snapshot
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
  projectRoot: string,
  db: DatabaseInfo,
  customName: string | undefined,
  verbose: boolean
): Promise<GenerateResult> {
  const result: GenerateResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
    migrationPath: null,
  };

  // Skip if no schema defined
  if (!db.schemaImport || db.schemaTableNames.length === 0) {
    if (verbose) {
      console.log(`[db:generate] Skipping ${db.name}: no schema defined`);
    }
    return result;
  }

  // Resolve schema path
  const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
  if (!schemaPath) {
    if (verbose) {
      console.log(`[db:generate] Skipping ${db.name}: could not resolve schema path`);
    }
    return result;
  }

  // Load the schema
  let schema: Record<string, unknown>;
  try {
    schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
  } catch (error) {
    console.warn(`[db:generate] Failed to load schema for ${db.name}: ${error}`);
    return result;
  }

  if (Object.keys(schema).length === 0) {
    if (verbose) {
      console.log(`[db:generate] Skipping ${db.name}: empty schema`);
    }
    return result;
  }

  // Load production snapshot
  const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);
  const prodSnapshot = loadSnapshot(migrationsDir);

  // Generate current schema snapshot
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  // Check if there are changes
  if (snapshotsEqual(prodSnapshot, currentSnapshot)) {
    if (verbose) {
      console.log(`[db:generate] No changes for ${db.name}`);
    }
    return result;
  }

  // Generate migration statements
  const statements = await generateMigrationStatements(prodSnapshot, currentSnapshot);

  if (statements.length === 0) {
    if (verbose) {
      console.log(`[db:generate] No SQL changes for ${db.name}`);
    }
    return result;
  }

  // Generate migration name
  const migrationName = generateMigrationName(customName ?? 'migration');

  // Ensure migrations directory exists
  fs.mkdirSync(migrationsDir, { recursive: true });

  // Write migration file
  const migrationPath = path.join(migrationsDir, `${migrationName}.sql`);
  const sqlContent = statements.map(s => s.endsWith(';') ? s : `${s};`).join('\n\n');
  fs.writeFileSync(migrationPath, sqlContent);

  // Update production snapshot
  const newSnapshot: Snapshot = {
    ...currentSnapshot,
    id: Date.now().toString(36).padStart(13, '0'),
    prevId: prodSnapshot.id,
  };
  saveSnapshot(migrationsDir, newSnapshot);

  result.hasChanges = true;
  result.statements = statements;
  result.migrationName = migrationName;
  result.migrationPath = migrationPath;

  if (verbose) {
    console.log(`[db:generate] Generated ${migrationName} for ${db.name} (${statements.length} statements)`);
    console.log(`[db:generate] Migration path: ${migrationPath}`);
  }

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
