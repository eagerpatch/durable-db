import type { DatabaseSource } from '../vite/modules/discovery';
import {
  loadDevState,
  loadDevMigrations,
  getDatabaseEpoch,
} from './state';
import {
  describeAmbiguity,
  exampleRenames,
  hashSnapshot,
  SchemaRenameRequiredError,
  type SchemaAmbiguity,
} from '../migrations/snapshot';
import { loadSnapshot, loadMigrationFiles } from '../migrations/generator';
import { selectDatabases, loadSchema, diffSchema } from './shared';
import type { DatabaseInfo } from '../db';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface StatusContext {
  projectRoot?: string;
  databasesDir?: string | DatabaseSource[];
  migrationsDir?: string;
  verbose?: boolean;
  /** Only report this database (an unknown name throws UnknownDatabaseError). */
  database?: string;
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
  /**
   * The schema changed in a way drizzle-kit cannot diff without asking
   * whether a new name is a rename (status never prompts): the questions.
   * `hasUncommittedChanges` is true and `pendingStatements` empty.
   */
  needsRenameResolution: SchemaAmbiguity[];
  /** The schema changed but the pending SQL could not be computed: why. */
  pendingError: string | null;
  /** What the pending change risks on a database with rows (see `db generate`). */
  warnings: string[];
  /** This database's dev epoch (its own after `db reset --database`, else the project's) */
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

  const databases = selectDatabases({ projectRoot, databasesDir, migrationsDir, database: ctx.database });

  if (databases.length === 0) {
    debugCli('No databases found');
    return result;
  }

  for (const db of databases) {
    const dbStatus = await getDatabaseStatus(projectRoot, db, devState);
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
  const dbStatus: DatabaseStatus = {
    name: db.name,
    prodMigrationCount: 0,
    devMigrationCount: 0,
    hasUncommittedChanges: false,
    pendingStatements: [],
    prodSnapshotChanged: false,
    needsRenameResolution: [],
    pendingError: null,
    warnings: [],
    epoch: getDatabaseEpoch(devState, db.name),
    lastPush: devState.databases[db.name]?.lastPush ?? null,
  };

  // Count production migrations
  const prodMigrations = loadMigrationFiles(db.migrationsDir);
  dbStatus.prodMigrationCount = prodMigrations.size;

  // Count dev migrations
  const devMigrations = loadDevMigrations(projectRoot, db.name);
  dbStatus.devMigrationCount = devMigrations.size;

  // Load schema
  const schema = await loadSchema(db, projectRoot);
  if (!schema) {
    return dbStatus;
  }

  // Check if prod snapshot changed
  const prodSnapshot = loadSnapshot(db.migrationsDir);
  const prodSnapshotHash = hashSnapshot(prodSnapshot);
  const dbDevState = devState.databases[db.name];
  if (dbDevState?.prodSnapshotHash !== undefined && dbDevState.prodSnapshotHash !== prodSnapshotHash) {
    dbStatus.prodSnapshotChanged = true;
  }

  // Diff schema against prod snapshot. Never prompts: a change drizzle-kit
  // would ask about is reported as such. A failure never reads as "up to
  // date" — the snapshots differ, so something is pending.
  try {
    const diff = await diffSchema(schema, db.migrationsDir, { interactive: false });

    if (diff.hasChanges) {
      dbStatus.hasUncommittedChanges = true;
      dbStatus.pendingStatements = diff.statements;
      dbStatus.warnings = diff.risks.map((risk) => risk.message);
    }
  } catch (error) {
    dbStatus.hasUncommittedChanges = true;
    if (error instanceof SchemaRenameRequiredError) {
      dbStatus.needsRenameResolution = error.ambiguities;
    } else {
      dbStatus.pendingError = error instanceof Error ? error.message : String(error);
      debugCli('Failed to generate pending statements for %s: %O', db.name, error);
    }
  }

  return dbStatus;
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
    const ambiguities = db.needsRenameResolution ?? [];
    lines.push(`\u{1F4E6} ${db.name}`);
    lines.push(`   Production migrations: ${db.prodMigrationCount}`);
    lines.push(`   Dev migrations: ${db.devMigrationCount}`);
    if (db.epoch && db.epoch !== result.epoch) {
      lines.push(`   Dev epoch: ${db.epoch} (own, since 'db reset --database ${db.name}')`);
    }

    if (db.prodSnapshotChanged) {
      lines.push(`   \u26A0\uFE0F  Production snapshot changed - run 'db:reset' to sync`);
    }

    if (ambiguities.length > 0) {
      lines.push(`   \u{1F4DD} Changes pending — needs rename resolution:`);
      for (const ambiguity of ambiguities) {
        lines.push(`     - ${describeAmbiguity(ambiguity)}`);
      }
      const example = ambiguities.flatMap(exampleRenames)[0];
      lines.push(
        `   Answer when you push/generate: in a terminal (it asks), or with ` +
        `${example ? `--rename ${example} (a rename) or ` : ''}--no-renames (create + drop)`
      );
    } else if (db.pendingError) {
      lines.push(`   \u{1F4DD} Changes pending — the SQL could not be computed: ${db.pendingError}`);
    } else if (db.hasUncommittedChanges) {
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
      for (const warning of db.warnings ?? []) {
        lines.push(`   \u26A0\uFE0F  ${warning}`);
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
