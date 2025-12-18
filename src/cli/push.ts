import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadDevState,
  saveDevState,
  getDatabaseDevState,
  hasProdSnapshotChanged,
  clearDatabaseDevState,
  saveDevMigration,
  loadDevSnapshot,
  saveDevSnapshot,
  getDevPaths,
} from './state';
import {
  loadSnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
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

export interface PushContext {
  projectRoot?: string;
  databasesDir?: string;
  verbose?: boolean;
}

export interface PushResult {
  database: string;
  hasChanges: boolean;
  statements: string[];
  migrationName: string | null;
  /** Whether the dev state was reset due to prod snapshot change */
  wasReset: boolean;
}

// ============================================================================
// Push Command
// ============================================================================

/**
 * Push schema changes to dev migrations
 *
 * This command:
 * 1. Discovers all databases in the project
 * 2. For each database, compares current schema to dev snapshot
 * 3. If changes detected, generates a new dev migration
 * 4. Updates dev snapshot
 *
 * Dev migrations are stored in node_modules/.cache/@shoplayer/database/
 * and are ephemeral - they're cleared when running `db:generate` or `db:reset`
 */
export async function push(ctx: PushContext = {}): Promise<PushResult[]> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', verbose = false } = ctx;
  const results: PushResult[] = [];

  // Load global dev state
  const devState = loadDevState(projectRoot);
  const paths = getDevPaths(projectRoot);

  // Discover databases
  const files = discoverDatabaseFiles({ projectRoot, databasesDir });
  
  if (files.length === 0) {
    if (verbose) {
      console.log('[db:push] No databases found');
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
    const result = await pushDatabase(projectRoot, db, devState, verbose);
    results.push(result);
  }

  // Save updated dev state
  saveDevState(projectRoot, devState);

  return results;
}

/**
 * Push a single database
 */
async function pushDatabase(
  projectRoot: string,
  db: DatabaseInfo,
  devState: ReturnType<typeof loadDevState>,
  verbose: boolean
): Promise<PushResult> {
  const result: PushResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
    wasReset: false,
  };

  // Skip if no schema defined
  if (!db.schemaImport || db.schemaTableNames.length === 0) {
    if (verbose) {
      console.log(`[db:push] Skipping ${db.name}: no schema defined`);
    }
    return result;
  }

  // Resolve schema path
  const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
  if (!schemaPath) {
    if (verbose) {
      console.log(`[db:push] Skipping ${db.name}: could not resolve schema path`);
    }
    return result;
  }

  // Load the schema
  let schema: Record<string, unknown>;
  try {
    schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
  } catch (error) {
    console.warn(`[db:push] Failed to load schema for ${db.name}: ${error}`);
    return result;
  }

  if (Object.keys(schema).length === 0) {
    if (verbose) {
      console.log(`[db:push] Skipping ${db.name}: empty schema`);
    }
    return result;
  }

  // Load production snapshot
  const prodMigrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);
  const prodSnapshot = loadSnapshot(prodMigrationsDir);
  const prodSnapshotHash = hashSnapshot(prodSnapshot);

  // Check if prod snapshot changed (someone else committed migrations)
  if (hasProdSnapshotChanged(devState, db.name, prodSnapshotHash)) {
    if (verbose) {
      console.log(`[db:push] Production snapshot changed for ${db.name}, resetting dev state`);
    }
    clearDatabaseDevState(projectRoot, db.name);
    result.wasReset = true;
  }

  // Get/initialize database dev state
  const dbDevState = getDatabaseDevState(devState, db.name, prodSnapshotHash);

  // Determine the "from" snapshot - either dev snapshot or prod snapshot
  const devSnapshot = loadDevSnapshot(projectRoot, db.name) as Snapshot | null;
  const fromSnapshot = devSnapshot ?? prodSnapshot;

  // Generate current schema snapshot
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  // Check if there are changes
  if (snapshotsEqual(fromSnapshot, currentSnapshot)) {
    if (verbose) {
      console.log(`[db:push] No changes for ${db.name}`);
    }
    return result;
  }

  // Generate migration statements
  const statements = await generateMigrationStatements(fromSnapshot, currentSnapshot);

  if (statements.length === 0) {
    if (verbose) {
      console.log(`[db:push] No SQL changes for ${db.name}`);
    }
    return result;
  }

  // Increment migration counter and save
  dbDevState.devMigrationCount++;
  dbDevState.lastPush = new Date().toISOString();

  const migrationName = saveDevMigration(
    projectRoot,
    db.name,
    dbDevState.devMigrationCount,
    statements
  );

  // Save updated dev snapshot
  saveDevSnapshot(projectRoot, db.name, currentSnapshot);

  result.hasChanges = true;
  result.statements = statements;
  result.migrationName = migrationName;

  if (verbose) {
    console.log(`[db:push] Generated ${migrationName} for ${db.name} (${statements.length} statements)`);
  }

  return result;
}

/**
 * Push a single database by name
 * Useful when you only want to push one specific database
 */
export async function pushOne(ctx: PushContext = {}, dbName: string): Promise<PushResult | null> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', verbose = false } = ctx;

  const files = discoverDatabaseFiles({ projectRoot, databasesDir });
  
  for (const file of files) {
    const code = readFile(file.absolutePath);
    const parsed = parseDatabaseFile(file.absolutePath, code);

    if (parsed.database?.name === dbName) {
      const devState = loadDevState(projectRoot);
      const result = await pushDatabase(projectRoot, parsed.database, devState, verbose);
      saveDevState(projectRoot, devState);
      return result;
    }
  }

  return null;
}
