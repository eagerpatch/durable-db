import * as fs from 'node:fs';
import {
  loadDevState,
  saveDevState,
  generateEpoch,
  clearDatabaseDevState,
  getDevPaths,
} from './state';
import { discoverDatabaseFiles, readFile } from '../vite/modules/discovery';
import { parseDatabaseFile } from '../vite/modules/parser';

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
}

export interface ResetResult {
  /** New epoch value (null if keepEpoch was true) */
  newEpoch: string | null;
  /** Databases that were reset */
  databases: string[];
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
  const { projectRoot = process.cwd(), databasesDir = 'src/databases', verbose = false } = ctx;
  const { database: targetDb, keepEpoch = false } = options;

  const result: ResetResult = {
    newEpoch: null,
    databases: [],
  };

  // Load current dev state
  const devState = loadDevState(projectRoot);

  // Bump epoch if requested
  if (!keepEpoch) {
    const newEpoch = generateEpoch();
    devState.epoch = newEpoch;
    result.newEpoch = newEpoch;
    
    if (verbose) {
      console.log(`[db:reset] New epoch: ${newEpoch}`);
    }
  }

  // If targeting specific database, only reset that one
  if (targetDb) {
    clearDatabaseDevState(projectRoot, targetDb);
    delete devState.databases[targetDb];
    result.databases.push(targetDb);
    
    if (verbose) {
      console.log(`[db:reset] Reset ${targetDb}`);
    }
  } else {
    // Discover all databases and reset them
    const files = discoverDatabaseFiles({ projectRoot, databasesDir });
    
    for (const file of files) {
      const code = readFile(file.absolutePath);
      const parsed = parseDatabaseFile(file.absolutePath, code);

      if (parsed.database) {
        clearDatabaseDevState(projectRoot, parsed.database.name);
        delete devState.databases[parsed.database.name];
        result.databases.push(parsed.database.name);
        
        if (verbose) {
          console.log(`[db:reset] Reset ${parsed.database.name}`);
        }
      }
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
          
          if (verbose) {
            console.log(`[db:reset] Cleaned up orphaned: ${dir}`);
          }
        }
      }
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
