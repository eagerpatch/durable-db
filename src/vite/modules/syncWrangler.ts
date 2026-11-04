import * as path from 'node:path';
import type { DatabaseInfo } from '../../db';
import { debugVite } from '../../utils/debug';
import { discoverDatabaseFiles, readFile, type DatabaseSource } from './discovery';
import { parseDatabaseFile } from './parser';
import {
  bindsDurableDbClasses,
  findWranglerConfig,
  patchWranglerConfig,
  unchangedPatch,
  type PatchResult,
} from './wrangler';

export interface SyncWranglerConfigOptions {
  /** Project root (where wrangler.jsonc/json lives). */
  projectRoot: string;
  /** Where database definitions live (default `src/databases`), as for the plugin. */
  databasesDir?: string | DatabaseSource[];
  /**
   * Where production migrations live (default `migrations`), as for the
   * plugin: a mount change moves the database's directory with its class.
   */
  migrationsDir?: string;
  /**
   * Where the one-line summary of a change goes. Default: `console.log`;
   * `false` silences it.
   */
  log?: ((message: string) => void) | false;
}

/**
 * What {@link patchWranglerConfig} did (bindings added and removed, classes
 * created and renamed, migrations moved, renames refused, classes left for a
 * hand-written `deleted_classes`), plus the databases and the summary.
 */
export interface SyncWranglerConfigResult extends PatchResult {
  /** The databases discovered. */
  databases: string[];
  /** Database files that did not parse: while there are any, nothing is written. */
  unparsable: string[];
  /** What changed, for the summary line: Durable Object bindings and the migration written. */
  changes: string[];
}

/**
 * Discover the databases and reconcile wrangler.jsonc/json with them — before
 * anything reads the config. The Vite plugin runs this in its `config` hook
 * (with `patchWranglerConfig: true`), ahead of @cloudflare/vite-plugin, which
 * reads the worker config in its own `config` hook and emits the build's
 * `wrangler.json` from that copy: patched any later, a build ships the
 * previous bindings, and a dev server restarts while it starts. CLIs that want
 * the file settled before Vite starts can call it themselves; a refused rename
 * is in `conflicts` (the plugin stops on it).
 *
 * When a database file does not parse, nothing is written: the patch is
 * computed from the complete set of databases or not at all (a partial set
 * would read as databases removed). The plugin reports the parse error when
 * it loads the file. A missing config file is reported by the patcher.
 */
export function syncWranglerConfig(options: SyncWranglerConfigOptions): SyncWranglerConfigResult {
  const { projectRoot, databasesDir = 'src/databases', migrationsDir = 'migrations' } = options;

  const { databases, unparsable } = discoverDatabaseInfos(projectRoot, databasesDir, migrationsDir);
  if (unparsable.length > 0) {
    debugVite('Not syncing wrangler config: %s did not parse', unparsable.join(', '));
    return {
      ...unchangedPatch(findWranglerConfig(projectRoot)),
      databases: databases.map((db) => db.name),
      unparsable,
      changes: [],
    };
  }

  return reconcileWranglerConfig(projectRoot, databases, options.log);
}

/**
 * {@link patchWranglerConfig} for databases already parsed, logging one line
 * when the file changed: `durable-db updated wrangler.jsonc (…)`. An app
 * without databases is left alone unless its config still binds durable-db
 * classes (a database removed: its binding goes).
 */
export function reconcileWranglerConfig(
  projectRoot: string,
  databases: DatabaseInfo[],
  log: SyncWranglerConfigOptions['log'] = (message) => console.log(message),
): SyncWranglerConfigResult {
  const names = databases.map((db) => db.name);
  if (databases.length === 0) {
    const configPath = findWranglerConfig(projectRoot);
    if (!bindsDurableDbClasses(configPath)) {
      return { ...unchangedPatch(configPath), databases: names, unparsable: [], changes: [] };
    }
  }

  const patch = patchWranglerConfig(projectRoot, databases);
  const changes = describePatch(patch);
  if (patch.modified && patch.configPath && log) {
    log(`durable-db updated ${path.basename(patch.configPath)}` + (changes.length > 0 ? ` (${changes.join('; ')})` : ''));
  }
  return { ...patch, databases: names, unparsable: [], changes };
}

/**
 * Parse every database file in the sources, each database with its
 * migrations directory (`<migrationsDir>/<name>`, as the plugin sets it); the
 * files that fail to parse are listed apart.
 */
export function discoverDatabaseInfos(
  projectRoot: string,
  databasesDir: string | DatabaseSource[],
  migrationsDir = 'migrations',
): { databases: DatabaseInfo[]; unparsable: string[] } {
  const databases: DatabaseInfo[] = [];
  const unparsable: string[] = [];
  for (const file of discoverDatabaseFiles({ projectRoot, databasesDir })) {
    try {
      const parsed = parseDatabaseFile(file.absolutePath, readFile(file.absolutePath), { namePrefix: file.prefix });
      if (parsed.database) {
        parsed.database.migrationsDir = path.resolve(projectRoot, migrationsDir, parsed.database.name);
        databases.push(parsed.database);
      }
    } catch (error) {
      debugVite('Could not parse %s while syncing wrangler config: %O', file.relativePath, error);
      unparsable.push(file.relativePath);
    }
  }
  return { databases, unparsable };
}

/** `Durable Objects: +AUDIT_DATABASE_DO → AuditDatabaseDO`, `migration v2: AuditDatabaseDO`. */
function describePatch(patch: PatchResult): string[] {
  const changes: string[] = [];
  const bindings = [
    ...patch.addedBindings.map((b) => `+${b.name} → ${b.class_name}`),
    ...patch.removedBindings.map((b) => `-${b.name} → ${b.class_name}`),
  ];
  if (bindings.length > 0) changes.push(`Durable Objects: ${bindings.join(', ')}`);
  if (patch.migrationTag) {
    const classes = [...patch.newClasses, ...patch.renamedClasses.map((r) => `${r.from} → ${r.to}`)];
    changes.push(`migration ${patch.migrationTag}: ${classes.join(', ')}`);
  }
  return changes;
}
