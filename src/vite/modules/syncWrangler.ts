import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseInfo } from '../../db';
import { debugVite } from '../../utils/debug';
import { discoverDatabaseFiles, readFile, type DatabaseSource } from './discovery';
import { parseDatabaseFile } from './parser';
import { findWranglerConfig, parseWranglerConfig, patchWranglerConfig } from './wrangler';

export interface SyncWranglerConfigOptions {
  /** Project root (where wrangler.jsonc/json lives). */
  projectRoot: string;
  /** Where database definitions live (default `src/databases`), as for the plugin. */
  databasesDir?: string | DatabaseSource[];
  /**
   * Where the one-line summary of a change goes. Default: `console.log`;
   * `false` silences it.
   */
  log?: ((message: string) => void) | false;
}

export interface SyncWranglerConfigResult {
  /** The config file, or null when the project has no wrangler.jsonc/json. */
  configPath: string | null;
  /** Whether the file was written. */
  modified: boolean;
  /** The databases discovered. */
  databases: string[];
  /** What changed, for the summary line: Durable Object bindings and migration tags. */
  changes: string[];
  error: Error | null;
}

/**
 * Discover the databases and write their Durable Object bindings and sqlite
 * migration entries into wrangler.jsonc/json — before anything reads the
 * config. The Vite plugin runs this in its `config` hook (with
 * `patchWranglerConfig: true`), ahead of @cloudflare/vite-plugin, which reads
 * the worker config in its own `config` hook and emits the build's
 * `wrangler.json` from that copy: patched any later, a build ships the
 * previous bindings, and a dev server restarts while it starts. CLIs that want
 * the file settled before Vite starts can call it themselves.
 *
 * When a database file does not parse, nothing is written: the patch is
 * computed from the complete set of databases or not at all (a partial set
 * would read as databases removed). The plugin reports the parse error when
 * it loads the file. A missing config file is reported by the patcher.
 */
export function syncWranglerConfig(options: SyncWranglerConfigOptions): SyncWranglerConfigResult {
  const { projectRoot, databasesDir = 'src/databases' } = options;
  const log = options.log === false ? null : (options.log ?? ((message: string) => console.log(message)));

  const { databases, unparsable } = discoverDatabaseInfos(projectRoot, databasesDir);
  const result: SyncWranglerConfigResult = {
    configPath: findWranglerConfig(projectRoot),
    modified: false,
    databases: databases.map((db) => db.name),
    changes: [],
    error: null,
  };
  if (unparsable.length > 0) {
    debugVite('Not syncing wrangler config: %s did not parse', unparsable.join(', '));
    return result;
  }

  const before = readConfig(result.configPath);
  // No databases: only a config that still binds durable-db classes has
  // anything to reconcile (an app without databases is left untouched).
  if (databases.length === 0 && !bindsDurableDbClasses(before)) return result;

  const patch = patchWranglerConfig(projectRoot, databases);
  result.configPath = patch.configPath;
  result.error = patch.error;
  result.modified = patch.modified;

  if (patch.modified && patch.configPath) {
    result.changes = describeChanges(before, readConfig(patch.configPath));
    log?.(
      `durable-db updated ${path.basename(patch.configPath)}` +
      (result.changes.length > 0 ? ` (${result.changes.join('; ')})` : '')
    );
  }

  return result;
}

/** Parse every database file in the sources; the ones that fail to parse are listed apart. */
export function discoverDatabaseInfos(
  projectRoot: string,
  databasesDir: string | DatabaseSource[],
): { databases: DatabaseInfo[]; unparsable: string[] } {
  const databases: DatabaseInfo[] = [];
  const unparsable: string[] = [];
  for (const file of discoverDatabaseFiles({ projectRoot, databasesDir })) {
    try {
      const parsed = parseDatabaseFile(file.absolutePath, readFile(file.absolutePath), { namePrefix: file.prefix });
      if (parsed.database) databases.push(parsed.database);
    } catch (error) {
      debugVite('Could not parse %s while syncing wrangler config: %O', file.relativePath, error);
      unparsable.push(file.relativePath);
    }
  }
  return { databases, unparsable };
}

function bindsDurableDbClasses(config: ConfigShape): boolean {
  return (config.durable_objects?.bindings ?? []).some((b) => /DatabaseDO$/.test(b.class_name));
}

interface ConfigShape {
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[]; [step: string]: unknown }>;
}

function readConfig(configPath: string | null): ConfigShape {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    return parseWranglerConfig(fs.readFileSync(configPath, 'utf-8')) as ConfigShape;
  } catch {
    return {};
  }
}

/** `Durable Objects: +AUDIT_DATABASE_DO`, `migration v2: AuditDatabaseDO`. */
function describeChanges(before: ConfigShape, after: ConfigShape): string[] {
  const changes: string[] = [];
  const bindings = (config: ConfigShape) =>
    new Set((config.durable_objects?.bindings ?? []).map((b) => `${b.name} → ${b.class_name}`));
  const was = bindings(before);
  const is = bindings(after);
  const added = [...is].filter((b) => !was.has(b));
  const removed = [...was].filter((b) => !is.has(b));
  if (added.length > 0 || removed.length > 0) {
    changes.push(
      `Durable Objects: ${[...added.map((b) => `+${b}`), ...removed.map((b) => `-${b}`)].join(', ')}`
    );
  }

  const tags = new Set((before.migrations ?? []).map((m) => m.tag));
  for (const migration of after.migrations ?? []) {
    if (tags.has(migration.tag)) continue;
    const classes = migration.new_sqlite_classes ?? [];
    const otherSteps = Object.keys(migration).filter((key) => key !== 'tag' && key !== 'new_sqlite_classes');
    const detail = [...classes, ...otherSteps];
    changes.push(`migration ${migration.tag}${detail.length > 0 ? `: ${detail.join(', ')}` : ''}`);
  }

  return changes;
}
