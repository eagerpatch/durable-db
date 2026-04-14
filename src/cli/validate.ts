import { resolveImportPath } from '../vite/modules/discovery';
import {
  loadMigrationFiles,
  buildAndLoadSchema,
  generateCreateTableSQL,
} from '../migrations/generator';
import { loadDevMigrations } from './state';
import { discoverDatabases } from './shared';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface ValidateContext {
  projectRoot?: string;
  databasesDir?: string;
  migrationsDir?: string;
  verbose?: boolean;
  /** Skip dev migrations, only validate prod */
  noDev?: boolean;
  /** Only validate this database */
  database?: string;
}

export interface ValidateError {
  migration: string;
  chunk: number;
  statement: string;
  error: string;
}

export interface ValidateResult {
  database: string;
  migrationsValid: boolean;
  errors: ValidateError[];
  schemaMatches: boolean;
  schemaDiffs: string[];
  migrationCount: number;
  includesDevMigrations: boolean;
}

// ============================================================================
// libsql database type (better-sqlite3-compatible API)
// ============================================================================

/** Minimal interface for the subset of the libsql/better-sqlite3 API we use */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: any[]): any[] };
  close(): void;
}

type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;

// ============================================================================
// Schema extraction from sqlite_master
// ============================================================================

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/**
 * Extract and normalize schema from a SQLite database.
 * Returns a sorted list of CREATE statements from sqlite_master.
 */
function extractSchema(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE type IN ('table', 'index', 'view', 'trigger')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
     ORDER BY type, name`
  ).all() as SqliteMasterRow[];

  return rows
    .filter(r => r.sql != null)
    .map(r => normalizeSql(r.sql!));
}

/**
 * Normalize SQL for comparison — collapse whitespace, remove trailing semicolons.
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * Diff two sorted schema arrays. Returns a list of human-readable differences.
 */
function diffSchemas(fromMigrations: string[], fromSchema: string[]): string[] {
  const diffs: string[] = [];
  const migrationSet = new Set(fromMigrations);
  const schemaSet = new Set(fromSchema);

  for (const stmt of fromMigrations) {
    if (!schemaSet.has(stmt)) {
      diffs.push(`Only in migrations: ${stmt}`);
    }
  }

  for (const stmt of fromSchema) {
    if (!migrationSet.has(stmt)) {
      diffs.push(`Only in schema: ${stmt}`);
    }
  }

  return diffs;
}

// ============================================================================
// Validate Command
// ============================================================================

/**
 * Dry-run all migrations against a local in-memory SQLite to catch errors
 * before deployment. Optionally compares the migrated schema against a
 * from-scratch schema build (dual-path verification).
 */
export async function validate(ctx: ValidateContext = {}): Promise<ValidateResult[]> {
  const {
    projectRoot = process.cwd(),
    databasesDir = 'src/databases',
    migrationsDir = 'migrations',
    noDev = false,
    database: onlyDatabase,
  } = ctx;

  // Try to load libsql (better-sqlite3-compatible API)
  let Database: SqliteDatabaseConstructor;
  try {
    const mod = await import('libsql');
    Database = (mod.default ?? mod) as unknown as SqliteDatabaseConstructor;
  } catch {
    throw new Error(
      'libsql is required for the validate command. ' +
      'Install it with: pnpm add -D libsql'
    );
  }

  const results: ValidateResult[] = [];

  const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir, database: onlyDatabase });

  if (databases.length === 0) {
    debugCli('No databases found');
    return results;
  }

  for (const db of databases) {
    const result = await validateDatabase(db, {
      projectRoot,
      noDev,
      Database,
    });
    results.push(result);
  }

  return results;
}

interface ValidateDatabaseOptions {
  projectRoot: string;
  noDev: boolean;
  Database: SqliteDatabaseConstructor;
}

async function validateDatabase(
  db: import('../db/types').DatabaseInfo,
  opts: ValidateDatabaseOptions,
): Promise<ValidateResult> {
  const { projectRoot, noDev, Database } = opts;

  const result: ValidateResult = {
    database: db.name,
    migrationsValid: true,
    errors: [],
    schemaMatches: true,
    schemaDiffs: [],
    migrationCount: 0,
    includesDevMigrations: false,
  };

  // ---- Path A: Migration replay ----
  const prodMigrationsDir = db.migrationsDir;
  const prodMigrations = loadMigrationFiles(prodMigrationsDir);

  let devMigrations = new Map<string, string[][]>();
  if (!noDev) {
    devMigrations = loadDevMigrations(projectRoot, db.name);
    if (devMigrations.size > 0) {
      result.includesDevMigrations = true;
    }
  }

  result.migrationCount = prodMigrations.size + devMigrations.size;

  // Apply migrations to in-memory SQLite
  // Apply prod migrations first (sorted), then dev migrations (sorted) —
  // dev migration names (e.g. 0001_dev) don't sort correctly relative to prod names
  const migrationsDb = new Database(':memory:');
  try {
    const sortedNames = [
      ...[...prodMigrations.keys()].sort(),
      ...[...devMigrations.keys()].sort(),
    ];
    const allMigrations = new Map<string, string[][]>([
      ...prodMigrations,
      ...devMigrations,
    ]);

    for (const migName of sortedNames) {
      const chunks = allMigrations.get(migName)!;

      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const statements = chunks[chunkIdx];

        for (const stmt of statements) {
          if (!stmt.trim()) continue;

          try {
            migrationsDb.exec(stmt);
            debugCli('[ok] %s[%d]: %s...', migName, chunkIdx, stmt.substring(0, 80));
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            result.migrationsValid = false;
            result.errors.push({
              migration: migName,
              chunk: chunkIdx,
              statement: stmt,
              error: errorMessage,
            });
            debugCli('[FAIL] %s[%d]: %s', migName, chunkIdx, errorMessage);
          }
        }
      }
    }

    // ---- Path B: Schema from scratch (dual-path comparison) ----
    if (db.schemaImport && db.schemaTableNames.length > 0) {
      const schemaPath = resolveImportPath(db.filePath, db.schemaImport);

      if (schemaPath) {
        try {
          const schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);

          if (Object.keys(schema).length > 0) {
            const createStatements = await generateCreateTableSQL(schema);

            const schemaDb = new Database(':memory:');
            try {
              for (const stmt of createStatements) {
                schemaDb.exec(stmt.endsWith(';') ? stmt : `${stmt};`);
              }

              // Compare schemas
              const migratedSchema = extractSchema(migrationsDb);
              const freshSchema = extractSchema(schemaDb);
              const diffs = diffSchemas(migratedSchema, freshSchema);

              if (diffs.length > 0) {
                result.schemaMatches = false;
                result.schemaDiffs = diffs;
              }
            } finally {
              schemaDb.close();
            }
          }
        } catch (err) {
          // Schema comparison is best-effort, but silently skipping it hides
          // real problems (e.g. a broken schema.ts). Warn with context so the
          // operator knows the drift check was skipped and why.
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[db] Schema drift check skipped for '${db.name}': ${message}. ` +
            `Migration replay still validated. Run with DEBUG=database:cli for a stack trace.`
          );
          debugCli('Could not build schema for dual-path comparison: %O', err);
        }
      }
    }
  } finally {
    migrationsDb.close();
  }

  return result;
}
