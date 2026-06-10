import * as crypto from 'node:crypto';
import {
  saveDevMigration,
  loadDevMigrations,
  clearDevMigrations,
} from './state';
import { discoverDatabases, loadSchema, diffSchema } from './shared';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface PushContext {
  projectRoot?: string;
  databasesDir?: string;
  migrationsDir?: string;
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
 * Dev migrations are stored in node_modules/.cache/durable-db/
 * and are ephemeral - they're cleared when running `db:generate` or `db:reset`
 */
export async function push(ctx: PushContext = {}): Promise<PushResult[]> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', migrationsDir = 'migrations' } = ctx;
  const results: PushResult[] = [];

  const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir });

  if (databases.length === 0) {
    debugCli('No databases found');
    return results;
  }

  for (const db of databases) {
    const result = await pushDatabase(projectRoot, db);
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
): Promise<PushResult> {
  const result: PushResult = {
    database: db.name,
    hasChanges: false,
    statements: [],
    migrationName: null,
  };

  const schema = await loadSchema(db);
  if (!schema) {
    return result;
  }

  const diff = await diffSchema(schema, db.migrationsDir);

  if (!diff.hasChanges) {
    debugCli('No changes for %s', db.name);
    return result;
  }

  // Dev migrations use IF NOT EXISTS for safety — the squashed migration
  // may overlay tables from a previous dev migration the DO already applied
  const safeStatements = diff.statements.map(s =>
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
    debugCli('Migration %s already exists for %s, skipping', migrationName, db.name);
    return result;
  }

  // Clear old dev migrations and save the new squashed migration
  clearDevMigrations(projectRoot, db.name);
  saveDevMigration(projectRoot, db.name, migrationName, safeStatements);

  result.hasChanges = true;
  result.statements = diff.statements;
  result.migrationName = migrationName;

  debugCli('Generated %s for %s (%d statements)', migrationName, db.name, diff.statements.length);

  return result;
}

/**
 * Push a single database by name
 * Useful when you only want to push one specific database
 */
export async function pushOne(ctx: PushContext = {}, dbName: string): Promise<PushResult | null> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', migrationsDir = 'migrations' } = ctx;

  const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir, database: dbName });

  if (databases.length === 0) {
    return null;
  }

  return await pushDatabase(projectRoot, databases[0]);
}
