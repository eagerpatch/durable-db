import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { debugCli } from '../utils/debug';

// ============================================================================
// Types
// ============================================================================

export interface DatabaseDevState {
  /** Hash of the production snapshot when dev migrations started */
  prodSnapshotHash: string;
  /** Timestamp of last push */
  lastPush: string | null;
}

export interface DevState {
  /** Epoch for instance key suffixing - bump this to reset all dev DBs */
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

const CACHE_DIR_NAME = '.cache/@shoplayer/database';
const STATE_FILE_NAME = 'state.json';
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
    return JSON.parse(content) as DevState;
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
  if (!state.databases[dbName]) {
    state.databases[dbName] = {
      prodSnapshotHash,
      lastPush: null,
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
  if (!dbState) return false;
  return dbState.prodSnapshotHash !== currentProdHash;
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
export function getDevEpoch(projectRoot: string): string | null {
  // Don't use epoch in production
  if (process.env.NODE_ENV === 'production') {
    return null;
  }
  
  const state = loadDevState(projectRoot);
  return state.epoch;
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
