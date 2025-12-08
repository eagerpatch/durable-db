import {
  DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { generateSQLiteDrizzleJson, generateSQLiteMigration } = require('drizzle-kit/api') as typeof import('drizzle-kit/api')

export type Snapshot = DrizzleSQLiteSnapshotJSON;

/**
 * Create an empty snapshot (for initial migration from nothing)
 */
export function createEmptySnapshot(): Snapshot {
  return {
    views: {},
    version: '6',
    dialect: 'sqlite',
    id: '0000000000000',
    prevId: '',
    tables: {},
    enums: {},
    _meta: {
      tables: {},
      columns: {},
    }
  };
}

/**
 * Generate a unique snapshot ID based on timestamp
 */
export function generateSnapshotId(): string {
  return Date.now().toString(36).padStart(13, '0');
}

/**
 * Generate a snapshot from Drizzle schema objects
 *
 * @param schema - Object containing Drizzle table definitions
 * @returns Snapshot representing the current schema state
 *
 * @example
 * ```ts
 * import { users, posts } from './schema';
 * const snapshot = await generateSnapshotFromSchema({ users, posts });
 * ```
 */
export async function generateSnapshotFromSchema(
  schema: Record<string, unknown>
) {
  return generateSQLiteDrizzleJson(schema, undefined, 'snake_case');
}

/**
 * Generate SQL migration statements from two snapshots
 *
 * @param from - Previous schema state (or empty for initial migration)
 * @param to - Target schema state
 * @returns Array of SQL statements to migrate from `from` to `to`
 *
 * @example
 * ```ts
 * const statements = await generateMigrationStatements(prevSnapshot, newSnapshot);
 * // ['CREATE TABLE users (...)', 'CREATE INDEX ...']
 * ```
 */
export async function generateMigrationStatements(
  from: Snapshot,
  to: Snapshot
): Promise<string[]> {

  return await generateSQLiteMigration(
    from,
    to,
  );
}

/**
 * Check if two snapshots are equivalent (no migration needed)
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a.tables) === JSON.stringify(b.tables);
}

/**
 * Create a hash of a snapshot for quick comparison
 */
export function hashSnapshot(snapshot: Snapshot): string {
  const content = JSON.stringify(snapshot.tables);
  // Simple hash for comparison purposes
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
