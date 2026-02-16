import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  saveDevMigration,
  loadDevMigrations,
  clearDevMigrations,
} from './state';
import {
  loadSnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  snapshotsEqual,
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
}

// ============================================================================
// Push Command
// ============================================================================

/**
 * Push schema changes to dev migrations
 *
 * This command:
 * 1. Discovers all databases in the project
 * 2. For each database, diffs production snapshot against current schema
 * 3. If changes detected, generates a single squashed dev migration
 * 4. Uses content-hash naming so the same schema always produces the same
 *    migration name — the DO skips it if already applied
 *
 * Dev migrations are stored in node_modules/.cache/@shoplayer/database/
 * and are ephemeral - they're cleared when running `db:generate` or `db:reset`
 */
export async function push(ctx: PushContext = {}): Promise<PushResult[]> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', verbose = false } = ctx;
  const results: PushResult[] = [];

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

    const result = await pushDatabase(projectRoot, parsed.database, verbose);
    results.push(result);
  }

  return results;
}

/**
 * Push a single database
 *
 * Always diffs from the production snapshot to the current schema,
 * producing a single squashed dev migration with a deterministic
 * content-hash name.
 */
async function pushDatabase(
  projectRoot: string,
  db: DatabaseInfo,
  verbose: boolean
): Promise<PushResult> {
  const result: PushResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
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

  // Always diff from production snapshot to current schema
  const prodMigrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);
  const prodSnapshot = loadSnapshot(prodMigrationsDir);
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  if (snapshotsEqual(prodSnapshot, currentSnapshot)) {
    if (verbose) {
      console.log(`[db:push] No changes for ${db.name}`);
    }
    return result;
  }

  // Generate migration statements (prod → current)
  const statements = await generateMigrationStatements(prodSnapshot, currentSnapshot);

  if (statements.length === 0) {
    if (verbose) {
      console.log(`[db:push] No SQL changes for ${db.name}`);
    }
    return result;
  }

  // Dev migrations use IF NOT EXISTS for safety — the squashed migration
  // may overlay tables from a previous dev migration the DO already applied
  const safeStatements = statements.map(s =>
    s.replace(/\bCREATE TABLE\b(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE IF NOT EXISTS')
     .replace(/\bCREATE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE INDEX IF NOT EXISTS')
     .replace(/\bCREATE UNIQUE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS')
  );

  // Deterministic name based on content hash — same schema always
  // produces the same migration name, so the DO skips it on restart
  const hash = crypto.createHash('sha256')
    .update(safeStatements.join('\n'))
    .digest('hex')
    .slice(0, 8);
  const migrationName = `dev_${hash}`;

  // If this exact migration already exists, skip regeneration
  const existingMigrations = loadDevMigrations(projectRoot, db.name);
  if (existingMigrations.has(migrationName)) {
    if (verbose) {
      console.log(`[db:push] Migration ${migrationName} already exists for ${db.name}, skipping`);
    }
    return result;
  }

  // Clear old dev migrations and save the new squashed migration
  clearDevMigrations(projectRoot, db.name);
  saveDevMigration(projectRoot, db.name, migrationName, safeStatements);

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
      return await pushDatabase(projectRoot, parsed.database, verbose);
    }
  }

  return null;
}
