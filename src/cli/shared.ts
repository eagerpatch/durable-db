import * as path from 'node:path';
import {
  analyzeMigrationRisks,
  formatRename,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  parseRenameSpec,
  renamesFromStatements,
  SchemaRenameRequiredError,
  snapshotsEqual,
  unusedRenames,
} from '../migrations/snapshot';
import type { MigrationResolution, MigrationRisk, RenameAnswer, Snapshot } from '../migrations/snapshot';
import { loadSnapshot, buildAndLoadSchema } from '../migrations/generator';
import { discoverDatabaseFiles, readFile, resolveImportPath } from '../vite/modules/discovery';
import type { DatabaseSource } from '../vite/modules/discovery';
import { loadViteAliases } from '../vite/modules/aliasResolver';
import { declaresSchema, parseDatabaseFile } from '../vite/modules/parser';
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
  /** A directory, or several with name prefixes — see DiscoveryOptions. */
  databasesDir: string | DatabaseSource[];
  migrationsDir: string;
  /** Only return databases matching this name */
  database?: string;
}

export interface DiffResult {
  hasChanges: boolean;
  statements: string[];
  prodSnapshot: Snapshot;
  currentSnapshot: Snapshot;
  /** What the statements risk on a database that has rows (see analyzeMigrationRisks). */
  risks: MigrationRisk[];
}

// ============================================================================
// Database selection
// ============================================================================

/** A `--database` filter that names no discovered database. */
export class UnknownDatabaseError extends Error {
  constructor(readonly database: string, readonly known: string[]) {
    super(
      known.length > 0
        ? `Unknown database '${database}'. Databases: ${known.join(', ')}.`
        : `Unknown database '${database}': no databases were found.`
    );
    this.name = 'UnknownDatabaseError';
  }
}

/**
 * The databases a command works on: every discovered one, or the one a
 * `--database` filter names — an unknown name throws
 * {@link UnknownDatabaseError} listing the valid ones, instead of quietly
 * matching nothing ("No databases found.", exit 0).
 */
export function selectDatabases(opts: DiscoverOptions): DatabaseInfo[] {
  const { database, ...rest } = opts;
  const all = discoverDatabases(rest);
  if (!database) return all;
  const selected = all.filter((db) => db.name === database);
  if (selected.length === 0) {
    throw new UnknownDatabaseError(database, all.map((db) => db.name).sort());
  }
  return selected;
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
    const parsed = parseDatabaseFile(file.absolutePath, code, { namePrefix: file.prefix });

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

/** What to read from a database's schema module: the const that is the schema, or each listed table. */
function schemaExportNames(db: DatabaseInfo): string[] {
  return db.schemaExport ? [db.schemaExport] : db.schemaTableNames;
}

/** The tables in what the schema module answered for `schemaExportNames(db)`. */
function schemaTablesFrom(
  db: DatabaseInfo,
  loaded: Record<string, unknown>,
  schemaPath: string
): Record<string, unknown> {
  if (!db.schemaExport) return loaded;

  const schema = loaded[db.schemaExport];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    const what = db.schemaExport === 'default' ? 'the default export' : `the export '${db.schemaExport}'`;
    throw new Error(
      `[db] Database '${db.name}': ${what} of schema module ${schemaPath} is not an object of ` +
      `tables. defineDatabase({ schema }) is given that export, so it must be the tables by ` +
      `name — e.g. export const schema = { users, posts }.`
    );
  }
  return { ...(schema as Record<string, unknown>) };
}

/**
 * The tables of a database's schema, built from the schema module at
 * `schemaPath`: the tables `defineDatabase({ schema: { … } })` lists, or the
 * const the module exports as the whole schema (`db.schemaExport`).
 */
export async function loadSchemaTables(
  db: DatabaseInfo,
  schemaPath: string
): Promise<Record<string, unknown>> {
  return schemaTablesFrom(db, await buildAndLoadSchema(schemaPath, schemaExportNames(db)), schemaPath);
}

/**
 * Load and validate schema for a database.
 *
 * Returns null only when the database genuinely declares no schema tables.
 * Every other failure mode (inline tables, unresolvable import, build error,
 * missing exports) throws — silently skipping a database is how a typo in
 * schema.ts becomes "why is my migration empty" 20 minutes later, or worse,
 * a generated migration that DROPs tables that still exist in production.
 *
 * `projectRoot` enables alias resolution for non-relative schema imports
 * (e.g. `@/databases/schema`): the project's Vite `resolve.alias` is loaded
 * (cached) and used as the source of truth. Omit it to resolve relative
 * imports only.
 */
export async function loadSchema(
  db: DatabaseInfo,
  projectRoot?: string
): Promise<Record<string, unknown> | null> {
  if (!declaresSchema(db)) {
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

  const aliases = projectRoot ? await loadViteAliases(projectRoot) : undefined;
  const schemaPath = resolveImportPath(db.filePath, db.schemaImport, aliases);
  if (!schemaPath) {
    throw new Error(
      `[db] Database '${db.name}': could not resolve schema import '${db.schemaImport}' ` +
      `from ${db.filePath}.` +
      (db.schemaImport.startsWith('.')
        ? ''
        : ` '${db.schemaImport}' looks like an alias — ensure it's defined in the project's ` +
          `Vite config (resolve.alias / tsconfig paths wired into Vite).`)
    );
  }

  let loaded: Record<string, unknown>;
  try {
    loaded = await buildAndLoadSchema(schemaPath, schemaExportNames(db));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugCli('Failed to load schema for %s: %O', db.name, error);
    throw new Error(
      `[db] Could not build schema for database '${db.name}' (${schemaPath}): ${message}`,
      { cause: error }
    );
  }

  const schema = schemaTablesFrom(db, loaded, schemaPath);
  if (db.schemaExport) {
    // The const says which tables there are: none is `schema: {}`.
    if (Object.keys(schema).length === 0) {
      debugCli('Skipping %s: its schema (%s) has no tables', db.name, db.schemaExport);
      return null;
    }
    return schema;
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
 * Returns whether there are changes, the SQL statements, both snapshots and
 * what the statements risk on a database with rows. `resolution` answers
 * drizzle-kit's rename questions (see MigrationResolution); an unanswered
 * one without a terminal throws SchemaRenameRequiredError.
 */
export async function diffSchema(
  schema: Record<string, unknown>,
  migrationsDir: string,
  resolution: MigrationResolution = {},
): Promise<DiffResult> {
  const prodSnapshot = loadSnapshot(migrationsDir);
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  if (snapshotsEqual(prodSnapshot, currentSnapshot)) {
    return { hasChanges: false, statements: [], prodSnapshot, currentSnapshot, risks: [] };
  }

  const statements = await generateMigrationStatements(prodSnapshot, currentSnapshot, resolution);
  const risks = statements.length > 0
    ? analyzeMigrationRisks(prodSnapshot, currentSnapshot, renamesFromStatements(statements))
    : [];

  return {
    hasChanges: statements.length > 0,
    statements,
    prodSnapshot,
    currentSnapshot,
    risks,
  };
}

// ============================================================================
// Diffing several databases
// ============================================================================

/** How push/generate answer drizzle-kit's rename questions (see MigrationResolution). */
export interface RenameResolutionOptions {
  /** `<table>.<old>=<new>` (column) / `<old>=<new>` (table) answers, or parsed ones. */
  renames?: Array<string | RenameAnswer>;
  /** Answer every remaining question with "create" (the vanished one is dropped). */
  noRenames?: boolean;
  /** Whether drizzle-kit may prompt. Default: when stdin and stdout are TTYs. */
  interactive?: boolean;
}

export interface DatabaseDiff {
  db: DatabaseInfo;
  /** null when the database declares no schema tables. */
  diff: DiffResult | null;
}

/**
 * Diff every database before anything is written, so a refusal (an unanswered
 * rename, an unused `--rename`, an unsafe statement) leaves every file as it
 * was. A rename answer applies to the database(s) where it matches; one that
 * matches no pending change anywhere is an error.
 */
export async function diffDatabases(
  projectRoot: string,
  databases: DatabaseInfo[],
  resolution: RenameResolutionOptions = {},
): Promise<DatabaseDiff[]> {
  const answers = (resolution.renames ?? []).map((r) => (typeof r === 'string' ? parseRenameSpec(r) : r));
  const diffs: DatabaseDiff[] = [];

  for (const db of databases) {
    const schema = await loadSchema(db, projectRoot);
    if (!schema) {
      diffs.push({ db, diff: null });
      continue;
    }
    try {
      const diff = await diffSchema(schema, db.migrationsDir, {
        renames: answers,
        noRenames: resolution.noRenames,
        interactive: resolution.interactive,
      });
      diffs.push({ db, diff });
    } catch (error) {
      if (error instanceof SchemaRenameRequiredError) throw error.forDatabase(db.name);
      throw error;
    }
  }

  const performed = diffs.flatMap(({ diff }) => (diff ? renamesFromStatements(diff.statements) : []));
  const unused = unusedRenames(answers, performed);
  if (unused.length > 0) {
    throw new Error(
      `--rename ${unused.map(formatRename).join(', ')} matches no pending change ` +
      `(a column or table that the schema no longer has, and a new one it gained).`
    );
  }

  return diffs;
}
