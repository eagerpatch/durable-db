import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseInfo } from '../../db/types.js';

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
 * Parse wrangler.jsonc content (strips comments)
 */
export function parseWranglerConfig(content: string): WranglerConfig {
  // Strip single-line comments
  const withoutSingleLine = content.replace(/\/\/.*$/gm, '');
  // Strip multi-line comments
  const withoutComments = withoutSingleLine.replace(/\/\*[\s\S]*?\*\//g, '');

  return JSON.parse(withoutComments);
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
      // Add a new migration entry for missing classes
      const nextTag = `v${config.migrations.length + 1}`;
      config.migrations.push({
        tag: nextTag,
        new_sqlite_classes: missingClasses,
      });
      modified = true;
    }

    if (modified) {
      // Write back as JSON (comments are lost, but structure is preserved)
      const newContent = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, newContent, 'utf-8');
      console.log(`[shoplayer-database] Updated ${path.basename(configPath)} with DO bindings`);
    }

    return { modified, configPath, error: null };
  } catch (error) {
    console.warn(`[shoplayer-database] Failed to patch wrangler config: ${error}`);
    logRequiredConfig(databases);
    return { modified: false, configPath, error: error as Error };
  }
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

  console.log('[shoplayer-database] Required Durable Object config:');
  console.log(JSON.stringify({ durable_objects: { bindings }, migrations }, null, 2));
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
