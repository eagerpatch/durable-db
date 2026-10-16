import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Alias } from 'vite';
import { applyAliases, resolveFileCandidate } from './aliasResolver';

/**
 * Options for database discovery
 */
export interface DiscoveryOptions {
  /** Project root directory */
  projectRoot: string;
  /**
   * Where database definitions live: a directory (relative to projectRoot,
   * or absolute), or several — each optionally with a name prefix, so a
   * host framework can mount a module's databases next to the app's own
   * (`{ dir: 'extensions/invoicing/databases', prefix: 'invoicing' }` →
   * `invoicing-main`, class `InvoicingMainDatabaseDO`).
   */
  databasesDir: string | DatabaseSource[];
}

/** One place database definitions are discovered from. */
export interface DatabaseSource {
  /** Directory, relative to the project root or absolute. */
  dir: string;
  /** Prepended to every database name found here (`<prefix>-<file>`). */
  prefix?: string;
}

/** The sources a `databasesDir` option names. */
export function databaseSources(databasesDir: string | DatabaseSource[]): DatabaseSource[] {
  return typeof databasesDir === 'string' ? [{ dir: databasesDir }] : databasesDir;
}

/** The name a database file gets: its basename, prefixed when its source has a prefix. */
export function databaseName(file: string, prefix?: string): string {
  const base = path.basename(file).replace(/\.(ts|js)$/, '');
  return prefix ? `${prefix}-${base}` : base;
}

/**
 * Result of database discovery
 */
export interface DiscoveredFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to project root */
  relativePath: string;
  /** Database name (the filename without extension, prefixed by its source's prefix) */
  name: string;
  /** The source's name prefix, when it has one */
  prefix?: string;
}

/**
 * Tracks directories we've already warned about to avoid duplicate noise
 * on repeated discovery calls (e.g. Vite HMR, multiple plugin hooks).
 */
const warnedMissingDirs = new Set<string>();

/** Reset the missing-dir warning cache — for tests. */
export function __resetDiscoveryWarnings(): void {
  warnedMissingDirs.clear();
}

/**
 * Discover database files in the configured directory
 *
 * Looks for .ts files in the databases directory, excluding:
 * - .d.ts files
 * - schema.ts (schema-only files)
 * - Files starting with _ (private helpers)
 */
export function discoverDatabaseFiles(options: DiscoveryOptions): DiscoveredFile[] {
  const { projectRoot, databasesDir } = options;
  const results: DiscoveredFile[] = [];

  for (const source of databaseSources(databasesDir)) {
    const absoluteDir = path.resolve(projectRoot, source.dir);

    if (!fs.existsSync(absoluteDir)) {
      // A single configured directory that is missing is worth a warning; a
      // list is a host framework's sweep over places that may not exist.
      if (typeof databasesDir === 'string' && !warnedMissingDirs.has(absoluteDir)) {
        warnedMissingDirs.add(absoluteDir);
        console.warn(
          `[durable-db] Databases directory not found: ${absoluteDir}. ` +
          `No databases will be generated. ` +
          `Set the 'databasesDir' plugin option if your databases live elsewhere (current: '${databasesDir}').`
        );
      }
      continue;
    }

    for (const file of fs.readdirSync(absoluteDir)) {
      // Skip non-TypeScript files
      if (!file.endsWith('.ts')) continue;

      // Skip declaration files
      if (file.endsWith('.d.ts')) continue;

      // Skip schema-only files
      if (file === 'schema.ts') continue;

      // Skip private helper files
      if (file.startsWith('_')) continue;

      const absolutePath = path.join(absoluteDir, file);
      results.push({
        absolutePath,
        relativePath: path.relative(projectRoot, absolutePath),
        name: databaseName(file, source.prefix),
        prefix: source.prefix,
      });
    }
  }

  return results;
}

export function discoverActionFiles(options: DiscoveryOptions): string[] {
  const { projectRoot, databasesDir } = options;
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      try {
        if (/\baction\s*\(/.test(fs.readFileSync(full, 'utf-8'))) results.push(full);
      } catch {
        /* unreadable — skip */
      }
    }
  };
  for (const source of databaseSources(databasesDir)) {
    const absoluteDir = path.resolve(projectRoot, source.dir);
    if (fs.existsSync(absoluteDir)) walk(absoluteDir);
  }
  return results;
}

/**
 * Resolve an import path to an absolute path.
 *
 * Relative imports (starting with `.`) are the fast path — resolved directly
 * against the importing file's directory. Non-relative imports are resolved
 * through the project's Vite `resolve.alias` entries (e.g. `@/databases/schema`,
 * `~/foo`); bare package imports that match no alias resolve to `null`. Both
 * paths use the same extension / index file probing.
 *
 * `aliases` is the resolved Vite alias array — the source of truth for aliases.
 * Callers in a standalone (no-plugin) context obtain it via `loadViteAliases()`;
 * when omitted, only relative imports resolve.
 */
export function resolveImportPath(
  fromFile: string,
  importSource: string,
  aliases?: readonly Alias[]
): string | null {
  if (importSource.startsWith('.')) {
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, importSource);
    return resolveFileCandidate(resolved);
  }

  // Non-relative: resolve through Vite's aliases before giving up.
  return applyAliases(importSource, aliases);
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Read file contents
 */
export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}
