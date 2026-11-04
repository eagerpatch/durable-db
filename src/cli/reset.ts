import type { DatabaseSource } from '../vite/modules/discovery';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadDevState,
  saveDevState,
  generateEpoch,
  clearDatabaseDevState,
  getDevPaths,
  forgetDatabaseDevState,
  runningDevServer,
  type DevState,
} from './state';
import { discoverDatabases, selectDatabases } from './shared';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface ResetContext {
  projectRoot?: string;
  databasesDir?: string | DatabaseSource[];
  migrationsDir?: string;
  verbose?: boolean;
}

export interface ResetOptions {
  /**
   * Only reset this database: it gets its own new dev epoch (fresh instances
   * for it alone — every other database keeps its data). An unknown name
   * throws UnknownDatabaseError.
   */
  database?: string;
  /** Don't bump the epoch (only clear dev migrations) */
  keepEpoch?: boolean;
  /**
   * Also delete workerd's persisted DO storage under .wrangler/.
   *
   * Not needed for a fresh start — the epoch bump already rotates every
   * database to a brand-new DO instance. This only reclaims the disk space
   * of the orphaned instances, and refuses while a dev server runs (workerd
   * keeps the deleted files open: every database request fails until it
   * restarts) unless `force` is set.
   */
  purgeLocalStorage?: boolean;
  /** Purge even when a dev server appears to be running. */
  force?: boolean;
}

/** `--purge-local-storage` while the project's dev server runs. */
export class DevServerRunningError extends Error {
  constructor(readonly pid: number) {
    super(
      `A dev server is running for this project (pid ${pid}). Purging local Durable Object storage under it ` +
      `breaks every database request until it restarts (workerd keeps the deleted files open). ` +
      `Stop the dev server first, or reset without --purge-local-storage — the new epoch already gives ` +
      `fresh databases. Pass --force to purge anyway.`
    );
    this.name = 'DevServerRunningError';
  }
}

export interface ResetResult {
  /**
   * New epoch value (null if keepEpoch was true) — the project's, or with
   * `database` that database's own.
   */
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
  const { database: targetDb, keepEpoch = false, purgeLocalStorage = false, force = false } = options;

  const result: ResetResult = {
    newEpoch: null,
    databases: [],
    clearedStorageDirs: [],
  };

  // Every check before the first change: an unknown --database name, a purge
  // under a running dev server.
  const target = targetDb
    ? selectDatabases({ projectRoot, databasesDir, migrationsDir: 'migrations', database: targetDb })[0]
    : null;
  if (purgeLocalStorage && !force) {
    const server = runningDevServer(projectRoot);
    if (server) throw new DevServerRunningError(server.pid);
  }

  // Load current dev state
  const devState = loadDevState(projectRoot);

  // If targeting specific database, only reset that one: its own epoch, so
  // only its instance keys rotate.
  if (target) {
    clearDatabaseDevState(projectRoot, target.name);
    if (keepEpoch) {
      forgetDatabaseDevState(devState, target.name);
    } else {
      const newEpoch = freshEpoch(devState);
      devState.databases[target.name] = { epoch: newEpoch };
      result.newEpoch = newEpoch;
      debugCli('New epoch for %s: %s', target.name, newEpoch);
    }
    result.databases.push(target.name);
    debugCli('Reset %s', target.name);

    if (purgeLocalStorage) {
      result.clearedStorageDirs = clearLocalDoStorage(projectRoot, target.className);
    }
  } else {
    // Bump the project epoch if requested — every database starts fresh, so
    // the databases' own epochs go too.
    if (!keepEpoch) {
      const newEpoch = freshEpoch(devState);
      devState.epoch = newEpoch;
      devState.databases = {};
      result.newEpoch = newEpoch;
      debugCli('New epoch: %s', newEpoch);
    }

    // Discover all databases and reset them
    const databases = discoverDatabases({ projectRoot, databasesDir, migrationsDir: 'migrations' });

    for (const db of databases) {
      clearDatabaseDevState(projectRoot, db.name);
      forgetDatabaseDevState(devState, db.name);
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
          forgetDatabaseDevState(devState, dir);
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

/** A new epoch, distinct from every one in use (two resets can share a millisecond). */
function freshEpoch(devState: DevState): string {
  const used = new Set([devState.epoch, ...Object.values(devState.databases).map((db) => db?.epoch)]);
  let epoch = generateEpoch();
  for (let n = 1; used.has(epoch); n++) epoch = `${generateEpoch()}${n.toString(36)}`;
  return epoch;
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
