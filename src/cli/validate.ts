import { resolveImportPath } from '../vite/modules/discovery';
import { loadViteAliases } from '../vite/modules/aliasResolver';
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
 * Extract and normalize non-table schema objects (indexes, views, triggers)
 * from a SQLite database. Returns a sorted list of CREATE statements from
 * sqlite_master.
 *
 * Tables are deliberately excluded: SQLite stores a table's CREATE statement
 * as the original text and rewrites it on `ALTER TABLE ... ADD COLUMN` (the
 * new column is spliced in before the closing paren), so the stored text of a
 * migrated table never string-matches a from-scratch CREATE even when the
 * schemas are identical. Tables are compared structurally instead — see
 * {@link extractTableStructures}.
 */
function extractNonTableSchema(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE type IN ('index', 'view', 'trigger')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
     ORDER BY type, name`
  ).all() as SqliteMasterRow[];

  return rows
    .filter(r => r.sql != null)
    .map(r => normalizeSql(r.sql!));
}

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PragmaIndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string; // 'c' = CREATE INDEX, 'u' = UNIQUE constraint, 'pk' = PRIMARY KEY
  partial: number;
}

interface PragmaForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

interface TableStructure {
  /** Column name → canonical descriptor ("text NOT NULL DEFAULT 'x' PK 1") */
  columns: Map<string, string>;
  /** Canonical signatures of UNIQUE constraints (from auto-indexes), sorted */
  uniques: string[];
  /** Canonical signatures of foreign keys, sorted */
  foreignKeys: string[];
}

/**
 * Extract the structural shape of every user table via PRAGMA introspection.
 *
 * This is the drift comparison for tables: it reflects what SQLite actually
 * enforces rather than the stored CREATE text, so it is immune to how the
 * table came to be (fresh CREATE vs. CREATE + ALTERs) and to column order,
 * which is irrelevant for the named-column access the framework generates.
 *
 * Not covered (not exposed by PRAGMAs): CHECK constraints, column collations,
 * and WITHOUT ROWID / STRICT table options.
 */
function extractTableStructures(db: SqliteDatabase): Map<string, TableStructure> {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
     ORDER BY name`
  ).all() as Array<{ name: string }>;

  const structures = new Map<string, TableStructure>();

  for (const { name } of tables) {
    const columns = new Map<string, string>();
    const columnRows = db.prepare(
      `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`
    ).all(name) as PragmaTableInfoRow[];
    for (const col of columnRows) {
      const parts = [col.type.replace(/\s+/g, ' ').trim().toLowerCase() || '(dynamic)'];
      if (col.notnull) parts.push('NOT NULL');
      if (col.dflt_value != null) parts.push(`DEFAULT ${col.dflt_value}`);
      if (col.pk) parts.push(`PK ${col.pk}`);
      columns.set(col.name, parts.join(' '));
    }

    const uniques: string[] = [];
    const indexRows = db.prepare(
      `SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?)`
    ).all(name) as PragmaIndexListRow[];
    for (const idx of indexRows) {
      // Only UNIQUE-constraint auto-indexes; CREATE INDEX statements keep
      // their sqlite_master text and are compared textually.
      if (idx.origin !== 'u') continue;
      const cols = (db.prepare(
        `SELECT name FROM pragma_index_info(?) ORDER BY seqno`
      ).all(idx.name) as Array<{ name: string | null }>)
        .map(c => c.name ?? '(expr)');
      uniques.push(`(${cols.join(', ')})`);
    }
    uniques.sort();

    const fkRows = db.prepare(
      `SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?)
       ORDER BY id, seq`
    ).all(name) as PragmaForeignKeyRow[];
    const fkGroups = new Map<number, PragmaForeignKeyRow[]>();
    for (const row of fkRows) {
      const group = fkGroups.get(row.id) ?? [];
      group.push(row);
      fkGroups.set(row.id, group);
    }
    const foreignKeys = [...fkGroups.values()].map(group => {
      const from = group.map(r => r.from).join(', ');
      const to = group.map(r => r.to ?? '(implicit pk)').join(', ');
      const { table, on_update, on_delete } = group[0];
      return `(${from}) → ${table}(${to}) ON UPDATE ${on_update} ON DELETE ${on_delete}`;
    }).sort();

    structures.set(name, { columns, uniques, foreignKeys });
  }

  return structures;
}

/**
 * Diff table structures. Returns a list of human-readable differences.
 */
function diffTableStructures(
  fromMigrations: Map<string, TableStructure>,
  fromSchema: Map<string, TableStructure>,
): string[] {
  const diffs: string[] = [];

  for (const [name, migrated] of fromMigrations) {
    const fresh = fromSchema.get(name);
    if (!fresh) {
      diffs.push(`Table only in migrations: ${name}`);
      continue;
    }

    for (const [col, descriptor] of migrated.columns) {
      const other = fresh.columns.get(col);
      if (other === undefined) {
        diffs.push(`Column ${name}.${col} only in migrations: ${descriptor}`);
      } else if (other !== descriptor) {
        diffs.push(`Column ${name}.${col} differs — migrations: ${descriptor}; schema: ${other}`);
      }
    }
    for (const [col, descriptor] of fresh.columns) {
      if (!migrated.columns.has(col)) {
        diffs.push(`Column ${name}.${col} only in schema: ${descriptor}`);
      }
    }

    if (migrated.uniques.join(' | ') !== fresh.uniques.join(' | ')) {
      diffs.push(
        `Unique constraints on ${name} differ — migrations: [${migrated.uniques.join(' | ') || 'none'}]; ` +
        `schema: [${fresh.uniques.join(' | ') || 'none'}]`
      );
    }

    if (migrated.foreignKeys.join(' | ') !== fresh.foreignKeys.join(' | ')) {
      diffs.push(
        `Foreign keys on ${name} differ — migrations: [${migrated.foreignKeys.join(' | ') || 'none'}]; ` +
        `schema: [${fresh.foreignKeys.join(' | ') || 'none'}]`
      );
    }
  }

  for (const name of fromSchema.keys()) {
    if (!fromMigrations.has(name)) {
      diffs.push(`Table only in schema: ${name}`);
    }
  }

  return diffs;
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
  // dev migration names (e.g. dev_a1b2c3d4) don't sort correctly relative
  // to prod timestamp names
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
      const aliases = await loadViteAliases(projectRoot);
      const schemaPath = resolveImportPath(db.filePath, db.schemaImport, aliases);

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

              // Compare schemas — tables structurally (PRAGMA-based, immune
              // to ALTER TABLE rewriting the stored CREATE text), everything
              // else textually.
              const diffs = [
                ...diffTableStructures(
                  extractTableStructures(migrationsDb),
                  extractTableStructures(schemaDb),
                ),
                ...diffSchemas(
                  extractNonTableSchema(migrationsDb),
                  extractNonTableSchema(schemaDb),
                ),
              ];

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
