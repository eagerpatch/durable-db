import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Snapshot } from './snapshot';
import {
  createEmptySnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  generateSnapshotId,
  snapshotsEqual,
} from './snapshot';

/**
 * Result of migration generation
 */
export interface MigrationResult {
  /** Whether changes were detected */
  hasChanges: boolean;
  /** Generated SQL statements */
  statements: string[];
  /** Migration name/identifier */
  migrationName: string | null;
  /** New snapshot (after migration) */
  snapshot: Snapshot;
  /** Previous snapshot (before migration) */
  previousSnapshot: Snapshot;
}

/**
 * Options for migration generation
 */
export interface GenerateMigrationOptions {
  /** Directory to store migrations and snapshots */
  migrationsDir: string;
  /** Drizzle schema objects */
  schema: Record<string, unknown>;
  /** Optional custom migration name */
  migrationName?: string;
  /** Whether to write files (default: true) */
  write?: boolean;
}

/**
 * Snapshot file name
 */
const SNAPSHOT_FILE = '_snapshot.json';

/**
 * Load the previous snapshot from the migrations directory
 */
export function loadSnapshot(migrationsDir: string): Snapshot {
  const snapshotPath = path.join(migrationsDir, SNAPSHOT_FILE);

  if (!fs.existsSync(snapshotPath)) {
    return createEmptySnapshot();
  }

  try {
    const content = fs.readFileSync(snapshotPath, 'utf-8');
    return JSON.parse(content) as Snapshot;
  } catch {
    console.warn(`[migrations] Failed to load snapshot from ${snapshotPath}, starting fresh`);
    return createEmptySnapshot();
  }
}

/**
 * Save a snapshot to the migrations directory
 */
export function saveSnapshot(migrationsDir: string, snapshot: Snapshot): void {
  fs.mkdirSync(migrationsDir, { recursive: true });
  const snapshotPath = path.join(migrationsDir, SNAPSHOT_FILE);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Generate a timestamp-based migration name
 */
export function generateMigrationName(suffix?: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);

  return suffix ? `${timestamp}_${suffix}` : timestamp;
}

/**
 * Generate a migration from schema changes
 *
 * This compares the current schema to the stored snapshot and generates
 * the necessary SQL statements to migrate the database.
 *
 * @example
 * ```ts
 * import { users, posts } from './schema';
 *
 * const result = await generateMigration({
 *   migrationsDir: './migrations',
 *   schema: { users, posts },
 * });
 *
 * if (result.hasChanges) {
 *   console.log('Migration generated:', result.migrationName);
 * }
 * ```
 */
export async function generateMigration(
  options: GenerateMigrationOptions
): Promise<MigrationResult> {
  const { migrationsDir, schema, migrationName, write = true } = options;

  // Load previous snapshot
  const previousSnapshot = loadSnapshot(migrationsDir);

  // Generate new snapshot from schema
  const newSnapshot = await generateSnapshotFromSchema(schema);

  // Update snapshot metadata
  newSnapshot.id = generateSnapshotId();
  newSnapshot.prevId = previousSnapshot.id;

  // Check if there are changes
  if (snapshotsEqual(previousSnapshot, newSnapshot)) {
    return {
      hasChanges: false,
      statements: [],
      migrationName: null,
      snapshot: newSnapshot,
      previousSnapshot,
    };
  }

  // Generate migration SQL
  const statements = await generateMigrationStatements(previousSnapshot, newSnapshot);

  // Generate migration name
  const name = migrationName ?? generateMigrationName('auto');

  if (write && statements.length > 0) {
    // Ensure directory exists
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Write migration SQL file
    const sqlPath = path.join(migrationsDir, `${name}.sql`);
    const sqlContent = statements.map(s => s.endsWith(';') ? s : `${s};`).join('\n\n');
    fs.writeFileSync(sqlPath, sqlContent);

    // Update snapshot
    saveSnapshot(migrationsDir, newSnapshot);

    console.log(`[migrations] Generated migration: ${name}`);
    console.log(`[migrations] Statements: ${statements.length}`);
  }

  return {
    hasChanges: true,
    statements,
    migrationName: name,
    snapshot: newSnapshot,
    previousSnapshot,
  };
}

/**
 * Breakpoint marker in SQL files
 * Use: --> breakpoint
 */
const BREAKPOINT_MARKER = /^-->\s*breakpoint\s*$/im;

/**
 * Parse SQL content into chunks (split by breakpoints) and statements
 *
 * @param content - Raw SQL file content
 * @returns Array of chunks, where each chunk is an array of SQL statements
 */
export function parseSqlMigration(content: string): string[][] {
  // Split by breakpoint markers
  const chunks = content.split(BREAKPOINT_MARKER);

  return chunks.map(chunk => {
    // Remove comment lines
    const withoutComments = chunk
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    // Split into individual statements
    // Handle both ";\n" and just ";" at end of file
    const statements = withoutComments
      .split(/;(?:\s*\n|\s*$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    return statements;
  }).filter(chunk => chunk.length > 0); // Remove empty chunks
}

/**
 * Migration data structure for embedding in generated code
 */
export interface MigrationData {
  name: string;
  chunks: string[][];
}

/**
 * Load all migration SQL files from a directory
 * Returns migrations sorted by name (timestamp order) with breakpoint parsing
 */
export function loadMigrationFiles(migrationsDir: string): Map<string, string[][]> {
  const migrations = new Map<string, string[][]>();

  if (!fs.existsSync(migrationsDir)) {
    return migrations;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Sort by name (timestamp order)

  for (const file of files) {
    const name = file.replace('.sql', '');
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const chunks = parseSqlMigration(content);

    if (chunks.length > 0) {
      migrations.set(name, chunks);
    }
  }

  return migrations;
}

/**
 * Load a schema module using dynamic import
 * Works with both ESM and CJS modules
 */
export async function loadSchemaModule(
  schemaPath: string,
  tableNames: string[]
): Promise<Record<string, unknown>> {
  // Convert to file URL for dynamic import
  const fileUrl = pathToFileURL(schemaPath).href;

  try {
    const module = await import(fileUrl);
    const schema: Record<string, unknown> = {};

    for (const name of tableNames) {
      if (module[name]) {
        schema[name] = module[name];
      } else if (module.default?.[name]) {
        schema[name] = module.default[name];
      }
    }

    return schema;
  } catch (error) {
    throw new Error(`Failed to load schema from ${schemaPath}: ${error}`);
  }
}

/**
 * Build schema module with esbuild and return the exports
 * This is useful when the schema is TypeScript and needs transpilation
 */
export async function buildAndLoadSchema(
  schemaPath: string,
  tableNames: string[]
): Promise<Record<string, unknown>> {
  // Dynamic import esbuild
  const esbuild = await import('esbuild');

  // Build to memory
  const result = await esbuild.build({
    entryPoints: [schemaPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external', // Don't bundle dependencies
    target: 'node18',
  });

  if (result.outputFiles?.length !== 1) {
    throw new Error(`Unexpected esbuild output for ${schemaPath}`);
  }

  // Write to temp file
  const tempDir = path.dirname(schemaPath);
  const tempFile = path.join(tempDir, `_schema_temp_${Date.now()}.mjs`);

  try {
    fs.writeFileSync(tempFile, result.outputFiles[0].text);
    const module = await import(pathToFileURL(tempFile).href);

    const schema: Record<string, unknown> = {};
    for (const name of tableNames) {
      if (module[name]) {
        schema[name] = module[name];
      } else if (module.default?.[name]) {
        schema[name] = module.default[name];
      }
    }

    return schema;
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Generate SQL to create all tables from scratch
 * Useful for initial setup or testing
 */
export async function generateCreateTableSQL(
  schema: Record<string, unknown>
): Promise<string[]> {
  const emptySnapshot = createEmptySnapshot();
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  return generateMigrationStatements(emptySnapshot, currentSnapshot);
}
