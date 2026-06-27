import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Alias } from 'vite';
import { debugCli } from '../../utils/debug';

/**
 * Import resolution for database files, driven by **Vite's** resolved config.
 *
 * The relative-import resolver only understands paths that start with `.`. Apps
 * frequently import their schema / action factory through an alias instead
 * (e.g. `@/databases/schema`, `~/foo`). Those aliases are NOT owned by
 * durable-db — they come from the project's Vite config (`resolve.alias`),
 * which is where tooling like rwsdk wires tsconfig `paths` (including aliases
 * declared in a base tsconfig the app `extends`). So Vite's resolved config is
 * the single source of truth for aliases.
 *
 * Two contexts consume this:
 * - The **Vite plugin** captures `config.resolve.alias` in `configResolved` and
 *   passes it down (the plugin's action-file transform also defers to Vite's own
 *   resolver via `this.resolve(...)`, the most faithful resolution).
 * - The **CLI** runs standalone, so it loads the project's Vite config with
 *   `resolveConfig(...)` and reads `config.resolve.alias` (cached per root).
 */

/**
 * Probe a candidate path for a real file, trying the same extensions and index
 * files the relative resolver uses. Shared between relative resolution and
 * alias resolution so both code paths behave identically.
 */
export function resolveFileCandidate(candidate: string): string | null {
  // Try exact path first (if it already has an extension)
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  for (const ext of extensions) {
    const withExt = candidate + ext;
    if (fs.existsSync(withExt)) {
      return withExt;
    }
  }

  // Try index files (for directory imports)
  const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
  for (const indexFile of indexFiles) {
    const indexPath = path.join(candidate, indexFile);
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Whether a Vite alias entry's `find` matches an import specifier. Mirrors
 * `@rollup/plugin-alias` (which Vite uses): RegExp `find` is tested; string
 * `find` matches an exact specifier or a `find/`-prefixed one.
 */
function matchesAlias(find: string | RegExp, importee: string): boolean {
  if (find instanceof RegExp) {
    return find.test(importee);
  }
  if (importee.length < find.length) {
    return false;
  }
  if (importee === find) {
    return true;
  }
  return importee.startsWith(find) && importee[find.length] === '/';
}

/**
 * Resolve an import specifier through Vite's `resolve.alias` entries.
 *
 * Rewrites the specifier with the first matching alias (mirroring Vite/rollup
 * semantics), then runs the shared extension / index-file probing to land on a
 * real file. Returns `null` when no alias matches or nothing resolves to a real
 * file. Replacements are expected to be absolute (Vite normalizes them so);
 * non-absolute replacements are skipped rather than resolved against `cwd`.
 */
export function applyAliases(
  importSource: string,
  aliases: readonly Alias[] | undefined
): string | null {
  if (!aliases || aliases.length === 0) {
    return null;
  }

  for (const entry of aliases) {
    if (!matchesAlias(entry.find, importSource)) {
      continue;
    }

    // `String.prototype.replace` with a string `find` replaces the first
    // occurrence; with a RegExp it follows the regex — both match Vite/rollup.
    const replaced = importSource.replace(entry.find as string | RegExp, entry.replacement);
    if (!path.isAbsolute(replaced)) {
      continue;
    }

    const resolved = resolveFileCandidate(replaced);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Cache of resolved `resolve.alias` arrays keyed by absolute project root, so a
 * single CLI run doesn't reload the (relatively expensive) Vite config.
 */
const viteAliasCache = new Map<string, readonly Alias[]>();

/** Reset the loaded-Vite-alias cache — for tests. */
export function __resetViteAliasCache(): void {
  viteAliasCache.clear();
}

/**
 * Load the project's Vite config and return its resolved `resolve.alias`
 * entries (the source of truth for aliases). Cached per root. Returns `[]` when
 * the config can't be loaded — callers then fall back to relative-only
 * resolution, which never needs aliases anyway.
 */
export async function loadViteAliases(root: string): Promise<readonly Alias[]> {
  const key = path.resolve(root);
  const cached = viteAliasCache.get(key);
  if (cached) {
    return cached;
  }

  let aliases: readonly Alias[] = [];
  try {
    // Dynamic import: vite is a peer dependency, only needed when a non-relative
    // import is actually encountered in a standalone (no-plugin) context.
    const { resolveConfig } = await import('vite');
    const config = await resolveConfig(
      { root: key, configFile: undefined, logLevel: 'silent' },
      'build'
    );
    aliases = config.resolve.alias ?? [];
  } catch (error) {
    debugCli('Could not load Vite config for alias resolution in %s: %O', key, error);
    aliases = [];
  }

  viteAliasCache.set(key, aliases);
  return aliases;
}
