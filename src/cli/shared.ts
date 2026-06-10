import * as path from 'node:path';
import { generateSnapshotFromSchema, generateMigrationStatements, snapshotsEqual } from '../migrations/snapshot';
import type { Snapshot } from '../migrations/snapshot';
import { loadSnapshot, buildAndLoadSchema } from '../migrations/generator';
import { discoverDatabaseFiles, readFile, resolveImportPath } from '../vite/modules/discovery';
import { parseDatabaseFile } from '../vite/modules/parser';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Error reporting
// ============================================================================

/**
 * Print a caught error to stderr. Always shows the message; when verbose
 * (flag or `DEBUG=*`) is set, also prints the stack so users can diagnose
 * unexpected failures without patching the CLI.
 */
export function reportCliError(error: unknown, verbose = false): void {
  const showStack = verbose || Boolean(process.env.DEBUG);
  if (error instanceof Error) {
    console.error('Error:', error.message);
    if (showStack && error.stack) {
      console.error(error.stack);
    }
    return;
  }
  console.error('Error:', error);
}

// ============================================================================
// Types
// ============================================================================

export interface DiscoverOptions {
  projectRoot: string;
  databasesDir: string;
  migrationsDir: string;
  /** Only return databases matching this name */
  database?: string;
}

export interface DiffResult {
  hasChanges: boolean;
  statements: string[];
  prodSnapshot: Snapshot;
  currentSnapshot: Snapshot;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover database files, parse them, and resolve migrationsDir.
 * Returns parsed DatabaseInfo[] with migrationsDir already set.
 */
export function discoverDatabases(opts: DiscoverOptions): DatabaseInfo[] {
  const { projectRoot, databasesDir, migrationsDir, database } = opts;

  const files = discoverDatabaseFiles({ projectRoot, databasesDir });
  const databases: DatabaseInfo[] = [];

  for (const file of files) {
    const code = readFile(file.absolutePath);
    const parsed = parseDatabaseFile(file.absolutePath, code);

    if (!parsed.database) {
      continue;
    }

    if (database && parsed.database.name !== database) {
      continue;
    }

    parsed.database.migrationsDir = path.resolve(projectRoot, migrationsDir, parsed.database.name);
    databases.push(parsed.database);
  }

  return databases;
}

// ============================================================================
// Schema Loading
// ============================================================================

/**
 * Load and validate schema for a database.
 *
 * Returns null only when the database genuinely declares no schema tables.
 * Every other failure mode (inline tables, unresolvable import, build error,
 * missing exports) throws — silently skipping a database is how a typo in
 * schema.ts becomes "why is my migration empty" 20 minutes later, or worse,
 * a generated migration that DROPs tables that still exist in production.
 */
export async function loadSchema(db: DatabaseInfo): Promise<Record<string, unknown> | null> {
  if (db.schemaTableNames.length === 0) {
    debugCli('Skipping %s: no schema defined', db.name);
    return null;
  }

  if (!db.schemaImport) {
    throw new Error(
      `[db] Database '${db.name}' declares ${db.schemaTableNames.length} schema table(s) ` +
      `(${db.schemaTableNames.join(', ')}) but none of them are imported from a schema module. ` +
      `Tables defined inline in ${path.basename(db.filePath)} cannot be loaded for migration ` +
      `generation — move them to a schema file (e.g. src/databases/schema.ts) and import them.`
    );
  }

  const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
  if (!schemaPath) {
    throw new Error(
      `[db] Database '${db.name}': could not resolve schema import '${db.schemaImport}' ` +
      `from ${db.filePath}.`
    );
  }

  let schema: Record<string, unknown>;
  try {
    schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugCli('Failed to load schema for %s: %O', db.name, error);
    throw new Error(
      `[db] Could not build schema for database '${db.name}' (${schemaPath}): ${message}`,
      { cause: error }
    );
  }

  const missing = db.schemaTableNames.filter((name) => !(name in schema));
  if (missing.length > 0) {
    throw new Error(
      `[db] Database '${db.name}': schema module ${schemaPath} does not export: ` +
      `${missing.join(', ')}. Every table referenced in defineDatabase({ schema }) must be ` +
      `exported from the same schema module.`
    );
  }

  return schema;
}

// ============================================================================
// Schema Diffing
// ============================================================================

/**
 * Diff a schema against the production snapshot in migrationsDir.
 * Returns whether there are changes, the SQL statements, and both snapshots.
 */
export async function diffSchema(
  schema: Record<string, unknown>,
  migrationsDir: string,
): Promise<DiffResult> {
  const prodSnapshot = loadSnapshot(migrationsDir);
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  if (snapshotsEqual(prodSnapshot, currentSnapshot)) {
    return { hasChanges: false, statements: [], prodSnapshot, currentSnapshot };
  }

  const statements = await generateMigrationStatements(prodSnapshot, currentSnapshot);

  return {
    hasChanges: statements.length > 0,
    statements,
    prodSnapshot,
    currentSnapshot,
  };
}
