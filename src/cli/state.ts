import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface DatabaseDevState {
  /** Hash of the production snapshot when dev migrations started */
  prodSnapshotHash?: string;
  /** Timestamp of last push */
  lastPush?: string | null;
  /**
   * This database's own dev epoch, set by `db reset --database <name>`: its
   * instance keys are suffixed with it instead of the project epoch, so one
   * database starts fresh while every other keeps its data. Absent → the
   * project epoch ({@link DevState.epoch}) applies.
   */
  epoch?: string;
}

export interface DevState {
  /**
   * Project epoch for instance key suffixing — bump this to reset every dev
   * database. A database with its own `databases[name].epoch` uses that one.
   */
  epoch: string;
  /** Per-database state */
  databases: Record<string, DatabaseDevState>;
}

export interface DevPaths {
  /** Root cache directory */
  cacheDir: string;
  /** State file path */
  stateFile: string;
  /** Database-specific directory */
  databaseDir: (dbName: string) => string;
  /** Dev migrations directory for a database */
  migrationsDir: (dbName: string) => string;
  /** Dev snapshot file for a database */
  snapshotFile: (dbName: string) => string;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_DIR_NAME = '.cache/durable-db';
const STATE_FILE_NAME = 'state.json';
/** Written by the Vite plugin while a dev server runs (see {@link writeDevServerLock}). */
export const DEV_SERVER_LOCK_FILE = 'dev-server.json';
const DEV_MIGRATIONS_DIR = 'migrations';
const DEV_SNAPSHOT_FILE = '_snapshot.json';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Find the node_modules directory for the current project
 */
export function findNodeModules(projectRoot: string): string {
  // Walk up looking for node_modules
  let current = projectRoot;
  while (current !== path.dirname(current)) {
    const nodeModules = path.join(current, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      return nodeModules;
    }
    current = path.dirname(current);
  }
  
  // Fallback to project root's node_modules (will be created if needed)
  return path.join(projectRoot, 'node_modules');
}

/**
 * Get all dev-related paths for a project
 */
export function getDevPaths(projectRoot: string): DevPaths {
  const nodeModules = findNodeModules(projectRoot);
  const cacheDir = path.join(nodeModules, CACHE_DIR_NAME);
  
  return {
    cacheDir,
    stateFile: path.join(cacheDir, STATE_FILE_NAME),
    databaseDir: (dbName: string) => path.join(cacheDir, 'databases', dbName),
    migrationsDir: (dbName: string) => path.join(cacheDir, 'databases', dbName, DEV_MIGRATIONS_DIR),
    snapshotFile: (dbName: string) => path.join(cacheDir, 'databases', dbName, DEV_SNAPSHOT_FILE),
  };
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Create a new empty dev state
 */
export function createEmptyDevState(): DevState {
  return {
    epoch: generateEpoch(),
    databases: {},
  };
}

/**
 * Generate a new epoch value (timestamp-based)
 */
export function generateEpoch(): string {
  return Date.now().toString(36);
}

/**
 * Load the dev state from disk
 */
export function loadDevState(projectRoot: string): DevState {
  const paths = getDevPaths(projectRoot);
  
  if (!fs.existsSync(paths.stateFile)) {
    return createEmptyDevState();
  }
  
  try {
    const content = fs.readFileSync(paths.stateFile, 'utf-8');
    const state = JSON.parse(content) as DevState;
    state.databases ??= {};
    return state;
  } catch (error) {
    debugCli('Failed to load dev state, starting fresh: %O', error);
    return createEmptyDevState();
  }
}

/**
 * Save the dev state to disk
 */
export function saveDevState(projectRoot: string, state: DevState): void {
  const paths = getDevPaths(projectRoot);
  
  // Ensure directory exists
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2));
}

/**
 * Get or create database-specific dev state
 */
export function getDatabaseDevState(
  state: DevState,
  dbName: string,
  prodSnapshotHash: string
): DatabaseDevState {
  const existing = state.databases[dbName];
  if (!existing || existing.prodSnapshotHash === undefined) {
    state.databases[dbName] = {
      ...existing,
      prodSnapshotHash,
      lastPush: existing?.lastPush ?? null,
    };
  }
  return state.databases[dbName];
}

/**
 * Check if prod snapshot has changed (meaning we need to reset dev state)
 */
export function hasProdSnapshotChanged(
  state: DevState,
  dbName: string,
  currentProdHash: string
): boolean {
  const dbState = state.databases[dbName];
  if (!dbState || dbState.prodSnapshotHash === undefined) return false;
  return dbState.prodSnapshotHash !== currentProdHash;
}

/**
 * The dev epoch a database's instance keys are suffixed with: its own epoch
 * (after `db reset --database <name>`), else the project epoch.
 */
export function getDatabaseEpoch(state: DevState, dbName: string): string {
  return state.databases[dbName]?.epoch ?? state.epoch;
}

/** Every database that has its own dev epoch, by name. */
export function getDatabaseEpochs(state: DevState): Record<string, string> {
  const epochs: Record<string, string> = {};
  for (const [name, dbState] of Object.entries(state.databases)) {
    if (dbState?.epoch) epochs[name] = dbState.epoch;
  }
  return epochs;
}

/**
 * Forget a database's dev bookkeeping (snapshot hash, last push) but keep
 * its own epoch: dropping the epoch would move the database back to the
 * project epoch — to the instances it had before its last reset.
 */
export function forgetDatabaseDevState(state: DevState, dbName: string): void {
  const epoch = state.databases[dbName]?.epoch;
  if (epoch) {
    state.databases[dbName] = { epoch };
  } else {
    delete state.databases[dbName];
  }
}

// ============================================================================
// Dev Migrations Management
// ============================================================================

/**
 * Load dev migrations for a database
 */
export function loadDevMigrations(projectRoot: string, dbName: string): Map<string, string[][]> {
  const paths = getDevPaths(projectRoot);
  const migrationsDir = paths.migrationsDir(dbName);
  
  if (!fs.existsSync(migrationsDir)) {
    return new Map();
  }
  
  const migrations = new Map<string, string[][]>();
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
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
 * Save a dev migration
 */
export function saveDevMigration(
  projectRoot: string,
  dbName: string,
  name: string,
  statements: string[]
): string {
  const paths = getDevPaths(projectRoot);
  const migrationsDir = paths.migrationsDir(dbName);

  // Ensure directory exists
  fs.mkdirSync(migrationsDir, { recursive: true });

  const filePath = path.join(migrationsDir, `${name}.sql`);

  const content = statements.map(s => s.endsWith(';') ? s : `${s};`).join('\n\n');
  fs.writeFileSync(filePath, content);

  return name;
}

/**
 * Clear all dev migrations for a database
 */
export function clearDevMigrations(projectRoot: string, dbName: string): void {
  const paths = getDevPaths(projectRoot);
  const migrationsDir = paths.migrationsDir(dbName);
  
  if (fs.existsSync(migrationsDir)) {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
}

/**
 * Clear all dev state for a database
 */
export function clearDatabaseDevState(projectRoot: string, dbName: string): void {
  const paths = getDevPaths(projectRoot);
  const dbDir = paths.databaseDir(dbName);
  
  if (fs.existsSync(dbDir)) {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Dev Snapshot Management
// ============================================================================

/**
 * Load dev snapshot for a database
 */
export function loadDevSnapshot(projectRoot: string, dbName: string): unknown | null {
  const paths = getDevPaths(projectRoot);
  const snapshotFile = paths.snapshotFile(dbName);
  
  if (!fs.existsSync(snapshotFile)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(snapshotFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save dev snapshot for a database
 */
export function saveDevSnapshot(projectRoot: string, dbName: string, snapshot: unknown): void {
  const paths = getDevPaths(projectRoot);
  const snapshotFile = paths.snapshotFile(dbName);
  
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
}

// ============================================================================
// Instance Key Helper
// ============================================================================

/**
 * Get the dev epoch for instance key suffixing
 * Returns null in production or if no dev state exists
 */
export function getDevEpoch(projectRoot: string, dbName?: string): string | null {
  // Don't use epoch in production
  if (process.env.NODE_ENV === 'production') {
    return null;
  }
  
  const state = loadDevState(projectRoot);
  return dbName ? getDatabaseEpoch(state, dbName) : state.epoch;
}

/**
 * Get a database instance key with optional dev epoch suffix
 */
export function getInstanceKey(baseKey: string, epoch: string | null): string {
  if (!epoch) {
    return baseKey;
  }
  return `${baseKey}__dev_${epoch}`;
}

// ============================================================================
// Dev Server Lock
// ============================================================================

/** What the Vite plugin records about a running dev server. */
export interface DevServerLock {
  /** The dev server's process id. */
  pid: number;
  /** Identifies the server instance that wrote the lock (a restart writes a new one). */
  token: string;
  /** ISO timestamp. */
  startedAt: string;
}

/**
 * Record that a dev server runs in this process. The Vite plugin calls this
 * in `configureServer` and {@link removeDevServerLock} when that server
 * closes, so CLI commands that must not run under a live dev server (purging
 * workerd's storage) can refuse. Returns the lock's token.
 */
export function writeDevServerLock(projectRoot: string): string {
  const paths = getDevPaths(projectRoot);
  const lock: DevServerLock = {
    pid: process.pid,
    token: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(paths.cacheDir, DEV_SERVER_LOCK_FILE), JSON.stringify(lock, null, 2));
  return lock.token;
}

/**
 * Remove the dev-server lock — only when it is still the one `token` wrote:
 * a restarted server writes its own lock before the old server closes, and
 * the old server's close must not delete the new one.
 */
export function removeDevServerLock(projectRoot: string, token: string): void {
  const lock = readDevServerLock(projectRoot);
  if (!lock || lock.token !== token) return;
  try {
    fs.rmSync(path.join(getDevPaths(projectRoot).cacheDir, DEV_SERVER_LOCK_FILE), { force: true });
  } catch (error) {
    debugCli('Could not remove the dev-server lock: %O', error);
  }
}

export function readDevServerLock(projectRoot: string): DevServerLock | null {
  const file = path.join(getDevPaths(projectRoot).cacheDir, DEV_SERVER_LOCK_FILE);
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<DevServerLock>;
    return typeof lock.pid === 'number' && typeof lock.token === 'string' ? (lock as DevServerLock) : null;
  } catch {
    return null;
  }
}

/** Whether a process with this id exists (signal 0 only probes). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The dev server running for this project, from the lock the Vite plugin
 * writes — null when there is none, or its process is gone (a crashed or
 * killed server never removed its lock).
 */
export function runningDevServer(projectRoot: string): DevServerLock | null {
  const lock = readDevServerLock(projectRoot);
  return lock && isProcessAlive(lock.pid) ? lock : null;
}

// ============================================================================
// SQL Parsing (duplicated from migrations module to avoid circular deps)
// ============================================================================

const BREAKPOINT_MARKER = /^-->\s*breakpoint\s*$/im;

function parseSqlMigration(content: string): string[][] {
  const chunks = content.split(BREAKPOINT_MARKER);
  
  return chunks.map(chunk => {
    const withoutComments = chunk
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');
    
    const statements = withoutComments
      .split(/;(?:\s*\n|\s*$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    return statements;
  }).filter(chunk => chunk.length > 0);
}
