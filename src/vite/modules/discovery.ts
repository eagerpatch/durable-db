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
  /** Directory containing database definitions (relative to projectRoot) */
  databasesDir: string;
}

/**
 * Result of database discovery
 */
export interface DiscoveredFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to project root */
  relativePath: string;
  /** Database name (derived from filename without extension) */
  name: string;
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
  const absoluteDir = path.join(projectRoot, databasesDir);

  if (!fs.existsSync(absoluteDir)) {
    if (!warnedMissingDirs.has(absoluteDir)) {
      warnedMissingDirs.add(absoluteDir);
      console.warn(
        `[durable-db] Databases directory not found: ${absoluteDir}. ` +
        `No databases will be generated. ` +
        `Set the 'databasesDir' plugin option if your databases live elsewhere (current: '${databasesDir}').`
      );
    }
    return [];
  }

  const files = fs.readdirSync(absoluteDir);
  const results: DiscoveredFile[] = [];

  for (const file of files) {
    // Skip non-TypeScript files
    if (!file.endsWith('.ts')) continue;

    // Skip declaration files
    if (file.endsWith('.d.ts')) continue;

    // Skip schema-only files
    if (file === 'schema.ts') continue;

    // Skip private helper files
    if (file.startsWith('_')) continue;

    const absolutePath = path.join(absoluteDir, file);
    const relativePath = path.join(databasesDir, file);
    const name = path.basename(file, '.ts');

    results.push({
      absolutePath,
      relativePath,
      name,
    });
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
