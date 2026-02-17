import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseInfo } from '../../db';
import { debugVite } from '../../utils/debug';

/**
 * Result of wrangler config patching
 */
export interface PatchResult {
  /** Whether the config was modified */
  modified: boolean;
  /** Path to the config file (if found) */
  configPath: string | null;
  /** Any errors that occurred */
  error: Error | null;
}

/**
 * Wrangler config structure (partial)
 */
interface WranglerConfig {
  durable_objects?: {
    bindings?: Array<{
      name: string;
      class_name: string;
    }>;
  };
  migrations?: Array<{
    tag: string;
    new_sqlite_classes?: string[];
  }>;
  [key: string]: unknown;
}

/**
 * Find the wrangler config file in a project
 */
export function findWranglerConfig(projectRoot: string): string | null {
  const candidates = ['wrangler.jsonc', 'wrangler.json'];

  for (const candidate of candidates) {
    const configPath = path.join(projectRoot, candidate);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

/**
 * Strip JSONC comments while respecting string literals.
 * Tracks whether we're inside a `"..."` so `//` and `/*` inside
 * strings (e.g. URLs) are preserved.
 */
export function stripJsoncComments(content: string): string {
  let result = '';
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    // String literal — copy verbatim until the closing quote
    if (ch === '"') {
      result += '"';
      i++;
      while (i < len) {
        const sc = content[i];
        result += sc;
        i++;
        if (sc === '\\') {
          // escaped character — copy next char unconditionally
          if (i < len) {
            result += content[i];
            i++;
          }
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    // Single-line comment
    if (ch === '/' && i + 1 < len && content[i + 1] === '/') {
      // Skip until end of line
      i += 2;
      while (i < len && content[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && i + 1 < len && content[i + 1] === '*') {
      i += 2;
      while (i < len) {
        if (content[i] === '*' && i + 1 < len && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Parse wrangler.jsonc content (strips comments)
 */
export function parseWranglerConfig(content: string): WranglerConfig {
  return JSON.parse(stripJsoncComments(content));
}

/**
 * Patch wrangler config with Durable Object bindings
 *
 * Adds any missing DO bindings and migration entries
 */
export function patchWranglerConfig(
  projectRoot: string,
  databases: DatabaseInfo[]
): PatchResult {
  const configPath = findWranglerConfig(projectRoot);

  if (!configPath) {
    console.warn('[shoplayer-database] wrangler.jsonc/json not found');
    logRequiredConfig(databases);
    return { modified: false, configPath: null, error: null };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = parseWranglerConfig(content);

    let modified = false;

    // Ensure durable_objects structure exists
    if (!config.durable_objects) {
      config.durable_objects = { bindings: [] };
      modified = true;
    }
    if (!config.durable_objects.bindings) {
      config.durable_objects.bindings = [];
      modified = true;
    }

    // Add missing bindings
    for (const db of databases) {
      const hasBinding = config.durable_objects.bindings.some(
        b => b.name === db.bindingName || b.class_name === db.className
      );

      if (!hasBinding) {
        config.durable_objects.bindings.push({
          name: db.bindingName,
          class_name: db.className,
        });
        modified = true;
      }
    }

    // Ensure migrations array exists
    if (!config.migrations) {
      config.migrations = [];
      modified = true;
    }

    // Check if we need to add sqlite classes to migrations
    const existingClasses = new Set(
      config.migrations.flatMap(m => m.new_sqlite_classes ?? [])
    );

    const missingClasses = databases
      .map(db => db.className)
      .filter(c => !existingClasses.has(c));

    if (missingClasses.length > 0) {
      // Parse existing tag numbers to avoid collisions with gaps (e.g. v1, v5 → v6)
      const existingTagNumbers = config.migrations
        .map(m => {
          const match = m.tag.match(/^v(\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        });
      const nextTagNum = existingTagNumbers.length > 0
        ? Math.max(...existingTagNumbers) + 1
        : 1;

      config.migrations.push({
        tag: `v${nextTagNum}`,
        new_sqlite_classes: missingClasses,
      });
      modified = true;
    }

    if (modified) {
      // Back up the original file if it contains comments that will be lost
      if (contentHasComments(content)) {
        const backupPath = configPath + '.backup';
        if (!fs.existsSync(backupPath)) {
          fs.writeFileSync(backupPath, content, 'utf-8');
          debugVite('Original %s contained comments that will be lost during patching. Backup saved to %s', path.basename(configPath), path.basename(backupPath));
        }
      }

      const newContent = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, newContent, 'utf-8');
      debugVite('Updated %s with DO bindings', path.basename(configPath));
    }

    return { modified, configPath, error: null };
  } catch (error) {
    debugVite('Failed to patch wrangler config: %O', error);
    logRequiredConfig(databases);
    return { modified: false, configPath, error: error as Error };
  }
}

/**
 * Check whether a JSONC string contains comments (outside of string literals).
 * Used to decide whether a backup is needed before re-serializing.
 */
export function contentHasComments(content: string): boolean {
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    if (ch === '"') {
      i++;
      while (i < len) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '/' && i + 1 < len && (content[i + 1] === '/' || content[i + 1] === '*')) {
      return true;
    }

    i++;
  }

  return false;
}

/**
 * Log the required wrangler config for manual setup
 */
function logRequiredConfig(databases: DatabaseInfo[]): void {
  const bindings = databases.map(db => ({
    name: db.bindingName,
    class_name: db.className,
  }));

  const migrations = [{
    tag: 'v1',
    new_sqlite_classes: databases.map(db => db.className),
  }];

  debugVite('Required Durable Object config:\n%O', { durable_objects: { bindings }, migrations });
}

/**
 * Generate the required wrangler config as a string
 * Useful for displaying to users or tests
 */
export function generateRequiredConfig(databases: DatabaseInfo[]): WranglerConfig {
  return {
    durable_objects: {
      bindings: databases.map(db => ({
        name: db.bindingName,
        class_name: db.className,
      })),
    },
    migrations: [{
      tag: 'v1',
      new_sqlite_classes: databases.map(db => db.className),
    }],
  };
}
