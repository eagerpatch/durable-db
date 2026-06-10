import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadDevState,
  saveDevState,
  generateEpoch,
  clearDatabaseDevState,
  getDevPaths,
} from './state';
import { discoverDatabases } from './shared';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface ResetContext {
  projectRoot?: string;
  databasesDir?: string;
  migrationsDir?: string;
  verbose?: boolean;
}

export interface ResetOptions {
  /** Only reset this database */
  database?: string;
  /** Don't bump the epoch (only clear dev migrations) */
  keepEpoch?: boolean;
  /**
   * Also delete workerd's persisted DO storage under .wrangler/.
   *
   * Not needed for a fresh start — the epoch bump already rotates every
   * database to a brand-new DO instance. This only reclaims the disk space
   * of the orphaned instances, and requires the dev server to be stopped.
   */
  purgeLocalStorage?: boolean;
}

export interface ResetResult {
  /** New epoch value (null if keepEpoch was true) */
  newEpoch: string | null;
  /** Databases that were reset */
  databases: string[];
  /** Local DO storage directories that were deleted (under .wrangler/) */
  clearedStorageDirs: string[];
}

// ============================================================================
// Local DO Storage (.wrangler)
// ============================================================================

/**
 * Path where wrangler/miniflare persist local Durable Object storage.
 * Both `wrangler dev` and the Cloudflare Vite plugin use this layout.
 */
function localDoStorageDir(projectRoot: string): string {
  return path.join(projectRoot, '.wrangler', 'state', 'v3', 'do');
}

/**
 * Delete workerd's persisted Durable Object storage.
 *
 * Opt-in via `--purge-local-storage`: a normal reset doesn't need this —
 * the epoch bump gives every database a fresh DO instance — but the old
 * instances' SQLite files stay on disk until purged. Must not run while
 * the dev server is up: workerd keeps deleted storage open and the DO
 * breaks until restart.
 *
 * When `className` is given, only storage directories whose name contains
 * that database's DO class name are removed; otherwise the whole DO
 * storage directory is removed.
 *
 * Returns the directories that were deleted.
 */
export function clearLocalDoStorage(projectRoot: string, className?: string): string[] {
  const doDir = localDoStorageDir(projectRoot);
  if (!fs.existsSync(doDir)) {
    return [];
  }

  if (!className) {
    fs.rmSync(doDir, { recursive: true, force: true });
    debugCli('Cleared local DO storage: %s', doDir);
    return [doDir];
  }

  // Miniflare persists each DO namespace in a directory that embeds the
  // class name (e.g. `<worker>-MainDatabaseDO`). Match on that.
  const cleared: string[] = [];
  for (const entry of fs.readdirSync(doDir)) {
    if (entry.includes(className)) {
      const dir = path.join(doDir, entry);
      fs.rmSync(dir, { recursive: true, force: true });
      debugCli('Cleared local DO storage: %s', dir);
      cleared.push(dir);
    }
  }
  return cleared;
}

// ============================================================================
// Reset Command
// ============================================================================

/**
 * Reset dev state and optionally bump the epoch
 *
 * This command:
 * 1. Bumps the epoch (unless keepEpoch is true)
 * 2. Clears all dev migrations
 * 3. Clears dev snapshots
 *
 * When the epoch changes, all local DO instances will use a new
 * instance key suffix, effectively giving you fresh databases.
 *
 * This is useful when:
 * - You want to start fresh with a clean database
 * - Your local DB is in a broken state
 * - Someone else committed migrations and you pulled
 */
export async function reset(
  ctx: ResetContext = {},
  options: ResetOptions = {}
): Promise<ResetResult> {
  const { projectRoot = process.cwd(), databasesDir = 'src/databases' } = ctx;
  const { database: targetDb, keepEpoch = false, purgeLocalStorage = false } = options;

  const result: ResetResult = {
    newEpoch: null,
    databases: [],
    clearedStorageDirs: [],
  };

  // Load current dev state
  const devState = loadDevState(projectRoot);

  // Bump epoch if requested
  if (!keepEpoch) {
    const newEpoch = generateEpoch();
    devState.epoch = newEpoch;
    result.newEpoch = newEpoch;
    debugCli('New epoch: %s', newEpoch);
  }

  // If targeting specific database, only reset that one
  if (targetDb) {
    clearDatabaseDevState(projectRoot, targetDb);
    delete devState.databases[targetDb];
    result.databases.push(targetDb);
    debugCli('Reset %s', targetDb);

    if (purgeLocalStorage) {
      const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir: 'migrations', database: targetDb });
      const className = databases[0]?.className;
      if (className) {
        result.clearedStorageDirs = clearLocalDoStorage(projectRoot, className);
      }
    }
  } else {
    // Discover all databases and reset them
    const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir: 'migrations' });

    for (const db of databases) {
      clearDatabaseDevState(projectRoot, db.name);
      delete devState.databases[db.name];
      result.databases.push(db.name);
      debugCli('Reset %s', db.name);
    }

    // Also clear any orphaned database dev state
    const paths = getDevPaths(projectRoot);
    const databasesPath = `${paths.cacheDir}/databases`;
    if (fs.existsSync(databasesPath)) {
      const dirs = fs.readdirSync(databasesPath);
      for (const dir of dirs) {
        if (!result.databases.includes(dir)) {
          clearDatabaseDevState(projectRoot, dir);
          delete devState.databases[dir];
          debugCli('Cleaned up orphaned: %s', dir);
        }
      }
    }

    if (purgeLocalStorage) {
      result.clearedStorageDirs = clearLocalDoStorage(projectRoot);
    }
  }

  // Save updated dev state
  saveDevState(projectRoot, devState);

  return result;
}

/**
 * Reset everything and re-run push
 * Convenience function that combines reset + push
 */
export async function resetAndPush(
  ctx: ResetContext = {},
  options: ResetOptions = {}
): Promise<{ reset: ResetResult; push: import('./push').PushResult[] }> {
  const { push } = await import('./push');

  const resetResult = await reset(ctx, options);
  const pushResults = await push(ctx);

  return {
    reset: resetResult,
    push: pushResults,
  };
}
