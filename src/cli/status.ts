import * as path from 'node:path';
import {
  loadDevState,
  loadDevMigrations,
  getDevPaths,
} from './state';
import {
  loadSnapshot,
  loadMigrationFiles,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  snapshotsEqual,
  hashSnapshot,
} from '../migrations';
import { discoverDatabaseFiles, readFile, resolveImportPath } from '../vite/modules/discovery';
import { parseDatabaseFile } from '../vite/modules/parser';
import { buildAndLoadSchema } from '../migrations/generator';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface StatusContext {
  projectRoot?: string;
  databasesDir?: string;
  migrationsDir?: string;
  verbose?: boolean;
}

export interface DatabaseStatus {
  name: string;
  /** Number of production migrations */
  prodMigrationCount: number;
  /** Number of dev migrations */
  devMigrationCount: number;
  /** Whether schema has uncommitted changes */
  hasUncommittedChanges: boolean;
  /** SQL statements that would be generated */
  pendingStatements: string[];
  /** Whether prod snapshot changed (needs reset) */
  prodSnapshotChanged: boolean;
  /** Current dev epoch */
  epoch: string;
  /** Last push timestamp */
  lastPush: string | null;
}

export interface StatusResult {
  /** Current dev epoch */
  epoch: string;
  /** Per-database status */
  databases: DatabaseStatus[];
}

// ============================================================================
// Status Command
// ============================================================================

/**
 * Get the current status of all databases
 *
 * Shows:
 * - Number of production migrations
 * - Number of dev migrations
 * - Whether there are uncommitted schema changes
 * - What SQL would be generated
 */
export async function status(ctx: StatusContext = {}): Promise<StatusResult> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', migrationsDir = 'migrations' } = ctx;

  const devState = loadDevState(projectRoot);
  const result: StatusResult = {
    epoch: devState.epoch,
    databases: [],
  };

  // Discover databases
  const files = discoverDatabaseFiles({ projectRoot, databasesDir });

  if (files.length === 0) {
    debugCli('No databases found');
    return result;
  }

  // Get status for each database
  for (const file of files) {
    const code = readFile(file.absolutePath);
    const parsed = parseDatabaseFile(file.absolutePath, code);

    if (!parsed.database) {
      continue;
    }

    parsed.database.migrationsDir = path.resolve(projectRoot, migrationsDir, parsed.database.name);
    const dbStatus = await getDatabaseStatus(projectRoot, parsed.database, devState);
    result.databases.push(dbStatus);
  }

  return result;
}

/**
 * Get status for a single database
 */
async function getDatabaseStatus(
  projectRoot: string,
  db: DatabaseInfo,
  devState: ReturnType<typeof loadDevState>,
): Promise<DatabaseStatus> {
  const status: DatabaseStatus = {
    name: db.name,
    prodMigrationCount: 0,
    devMigrationCount: 0,
    hasUncommittedChanges: false,
    pendingStatements: [],
    prodSnapshotChanged: false,
    epoch: devState.epoch,
    lastPush: devState.databases[db.name]?.lastPush ?? null,
  };

  // Count production migrations
  const prodMigrationsDir = db.migrationsDir;
  const prodMigrations = loadMigrationFiles(prodMigrationsDir);
  status.prodMigrationCount = prodMigrations.size;

  // Count dev migrations
  const devMigrations = loadDevMigrations(projectRoot, db.name);
  status.devMigrationCount = devMigrations.size;

  // Check for schema changes
  if (!db.schemaImport || db.schemaTableNames.length === 0) {
    return status;
  }

  const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
  if (!schemaPath) {
    return status;
  }

  let schema: Record<string, unknown>;
  try {
    schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
  } catch (error) {
    debugCli('Failed to load schema for %s: %O', db.name, error);
    return status;
  }

  if (Object.keys(schema).length === 0) {
    return status;
  }

  // Load production snapshot
  const prodSnapshot = loadSnapshot(prodMigrationsDir);
  const prodSnapshotHash = hashSnapshot(prodSnapshot);

  // Check if prod snapshot changed
  const dbDevState = devState.databases[db.name];
  if (dbDevState && dbDevState.prodSnapshotHash !== prodSnapshotHash) {
    status.prodSnapshotChanged = true;
  }

  // Generate current schema snapshot
  const currentSnapshot = await generateSnapshotFromSchema(schema);

  // Check for changes against prod snapshot (matches what push would do)
  if (!snapshotsEqual(prodSnapshot, currentSnapshot)) {
    status.hasUncommittedChanges = true;
    try {
      status.pendingStatements = await generateMigrationStatements(prodSnapshot, currentSnapshot);
    } catch (error) {
      debugCli('Failed to generate pending statements for %s: %O', db.name, error);
    }
  }

  return status;
}

/**
 * Format status for display
 */
export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];

  lines.push(`Dev Epoch: ${result.epoch}`);
  lines.push('');

  if (result.databases.length === 0) {
    lines.push('No databases found.');
    return lines.join('\n');
  }

  for (const db of result.databases) {
    lines.push(`\u{1F4E6} ${db.name}`);
    lines.push(`   Production migrations: ${db.prodMigrationCount}`);
    lines.push(`   Dev migrations: ${db.devMigrationCount}`);

    if (db.prodSnapshotChanged) {
      lines.push(`   \u26A0\uFE0F  Production snapshot changed - run 'db:reset' to sync`);
    }

    if (db.hasUncommittedChanges) {
      lines.push(`   \u{1F4DD} Uncommitted changes: ${db.pendingStatements.length} statement(s)`);
      if (db.pendingStatements.length > 0) {
        lines.push(`   Pending SQL:`);
        for (const stmt of db.pendingStatements.slice(0, 5)) {
          const shortStmt = stmt.length > 60 ? stmt.slice(0, 60) + '...' : stmt;
          lines.push(`     - ${shortStmt}`);
        }
        if (db.pendingStatements.length > 5) {
          lines.push(`     ... and ${db.pendingStatements.length - 5} more`);
        }
      }
    } else {
      lines.push(`   \u2713 Schema is up to date`);
    }

    if (db.lastPush) {
      lines.push(`   Last push: ${db.lastPush}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
