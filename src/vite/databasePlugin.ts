import * as path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import type { DatabaseInfo, ActionInfo, ParsedDatabaseFile } from '../db/types.js';
import { discoverDatabaseFiles, readFile, resolveImportPath, fileExists } from './modules/discovery.js';
import { parseDatabaseFile, resolveInternalActionCalls } from './modules/parser.js';
import { generateRpcStubs, generateDurableObjectsModule, generateReExportModule } from './modules/generator.js';
import { patchWranglerConfig } from './modules/wrangler.js';
import {
  loadMigrationFiles,
  loadSnapshot,
  generateMigration,
  buildAndLoadSchema,
} from '../migrations/index.js';

/**
 * Plugin configuration options
 */
export interface DatabasePluginOptions {
  /**
   * Import path for the context module that provides getContext()
   * @default '@shoplayer/database/context'
   */
  contextImport?: string;

  /**
   * Directory containing database definitions
   * @default 'src/databases'
   */
  databasesDir?: string;

  /**
   * Property path to get the shop identifier from context
   * Used for per-shop database instances
   * @default 'session.shop'
   */
  shopIdPath?: string;

  /**
   * Whether to auto-generate migrations from schema changes
   * @default true
   */
  autoMigrations?: boolean;
}

// Virtual module prefix
const VIRTUAL_PREFIX = '\0virtual:shoplayer/databases/';
const VIRTUAL_DO_ID = 'shoplayer/databases/__durableObjects';

/**
 * Shoplayer Database Vite Plugin
 *
 * This plugin:
 * 1. Discovers database files in src/databases/
 * 2. Extracts action definitions using Babel AST
 * 3. Generates migrations from schema (if enabled)
 * 4. Generates Durable Object classes with action handlers
 * 5. Generates RPC stubs that use AsyncLocalStorage context
 * 6. Patches wrangler.jsonc with DO bindings
 */
export function shoplayerDatabasePlugin(options: DatabasePluginOptions = {}): Plugin {
  const {
    contextImport = '@shoplayer/database/context',
    databasesDir = 'src/databases',
    shopIdPath = 'session.shop',
    autoMigrations = true,
  } = options;

  // State
  const databases = new Map<string, DatabaseInfo>();
  const actions = new Map<string, ActionInfo>();
  const parsedFiles = new Map<string, ParsedDatabaseFile>();

  let projectRoot: string;
  let config: ResolvedConfig;
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  /**
   * Parse a file and recursively parse its local dependencies
   */
  async function parseFileWithDependencies(filePath: string): Promise<void> {
    const normalizedPath = path.normalize(filePath);
    if (parsedFiles.has(normalizedPath)) {
      return;
    }

    const code = readFile(filePath);
    const parsed = parseDatabaseFile(normalizedPath, code);
    parsedFiles.set(normalizedPath, parsed);

    // Recursively parse local imports
    for (const [, importInfo] of parsed.localImports) {
      if (importInfo.source.startsWith('.')) {
        const resolvedPath = resolveImportPath(filePath, importInfo.source);
        if (resolvedPath) {
          await parseFileWithDependencies(resolvedPath);
        }
      }
    }
  }

  /**
   * Load or generate migrations for a database
   */
  async function loadDatabaseMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);

    // If auto-migrations enabled and we have a schema, try to generate
    if (autoMigrations && db.schemaImport && db.schemaTableNames.length > 0) {
      try {
        const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
        if (schemaPath) {
          // Build and load the schema module
          const schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);

          if (Object.keys(schema).length > 0) {
            // Generate migration if schema changed
            const result = await generateMigration({
              migrationsDir,
              schema,
              write: true,
            });

            if (result.hasChanges) {
              console.log(
                `[shoplayer-database] Generated migration for ${db.name}: ${result.migrationName} ` +
                `(${result.statements.length} statements)`
              );
            }
          }
        }
      } catch (error) {
        // Log but don't fail - fall back to loading existing migrations
        console.warn(
          `[shoplayer-database] Could not auto-generate migrations for ${db.name}: ${error}`
        );
      }
    }

    // Load all migration files
    db.migrations = loadMigrationFiles(migrationsDir);

    if (db.migrations.size > 0) {
      console.log(
        `[shoplayer-database] Loaded ${db.migrations.size} migration(s) for ${db.name}`
      );
    }
  }

  /**
   * Initialize the plugin state (lazy, called on demand)
   */
  async function initialize(): Promise<void> {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      console.log('[shoplayer-database] Initializing...');
      
      // Clear previous state
      databases.clear();
      actions.clear();
      parsedFiles.clear();

      // Discover database entry files
      const discoveredFiles = discoverDatabaseFiles({
        projectRoot,
        databasesDir,
      });

      console.log('[shoplayer-database] discoveredFiles', discoveredFiles);

      if (discoveredFiles.length === 0) {
        initialized = true;
        return;
      }

      // Parse all entry files and their dependencies
      for (const file of discoveredFiles) {
        await parseFileWithDependencies(file.absolutePath);
      }

      // Extract database info and actions from parsed files
      for (const [filePath, parsed] of parsedFiles) {
        if (parsed.database) {
          databases.set(parsed.database.name, parsed.database);
        }

        for (const action of parsed.actions) {
          actions.set(action.exportName, action);
        }
      }

      // Load/generate migrations for each database
      for (const db of databases.values()) {
        await loadDatabaseMigrations(db);
      }

      // Resolve internal action calls (action calling another action in same DB)
      // and detect cross-DB calls (action calling action in different DB)
      const allActionsList = Array.from(actions.values());
      for (const [dbName] of databases) {
        const dbActions = allActionsList.filter(a => a.databaseName === dbName);
        resolveInternalActionCalls(dbActions, allActionsList);
      }

      // Log info about cross-DB calls (now properly handled)
      for (const action of actions.values()) {
        if (action.crossDbActionCalls.length > 0) {
          console.log(
            `[shoplayer-database] Action "${action.exportName}" in database "${action.databaseName}" ` +
            `has cross-DB calls: ${action.crossDbActionCalls.join(', ')} (will be transformed to RPC)`
          );
        }
      }

      // Patch wrangler config
      if (databases.size > 0) {
        patchWranglerConfig(projectRoot, Array.from(databases.values()));
      }
      
      // Debug: Log all registered files and their info
      console.log('[shoplayer-database] Registered parsedFiles keys:', Array.from(parsedFiles.keys()));
      console.log('[shoplayer-database] Registered databases:', Array.from(databases.keys()));
      console.log('[shoplayer-database] Registered actions:', Array.from(actions.keys()));
      
      initialized = true;
    })();

    return initPromise;
  }

  return {
    name: 'shoplayer-database',
    
    // Ensure plugin runs before vite:esbuild so our transform is applied first
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      projectRoot = config.root;
    },

    async buildStart() {
      // Initialize on build start
      await initialize();
    },

    async resolveId(id) {
      // Ensure initialized before resolving
      await initialize();
      
      // Handle: virtual:shoplayer/databases/__durableObjects
      if (id === `virtual:${VIRTUAL_DO_ID}` || id === VIRTUAL_DO_ID) {
        return VIRTUAL_PREFIX + '__durableObjects.ts';
      }

      // Handle: shoplayer/databases/xxx or virtual:shoplayer/databases/xxx
      const dbNameMatch = id.match(/^(?:virtual:)?shoplayer\/databases\/(.+)$/);
      if (dbNameMatch) {
        let dbName = dbNameMatch[1];
        // Skip the durable objects module
        if (dbName === '__durableObjects' || dbName === '__durableObjects.ts') {
          return null;
        }
        // Strip .ts if already present to avoid double extension
        if (dbName.endsWith('.ts')) {
          dbName = dbName.slice(0, -3);
        }
        return VIRTUAL_PREFIX + dbName + '.ts';
      }

      return null;
    },

    async load(id) {
      // Ensure initialized before loading
      await initialize();
      
      // Generate Durable Objects module
      if (id === VIRTUAL_PREFIX + '__durableObjects.ts') {
        const actionsByDatabase = new Map<string, ActionInfo[]>();
        for (const action of actions.values()) {
          const dbActions = actionsByDatabase.get(action.databaseName) ?? [];
          dbActions.push(action);
          actionsByDatabase.set(action.databaseName, dbActions);
        }

        return generateDurableObjectsModule(
          Array.from(databases.values()),
          actionsByDatabase,
          Array.from(actions.values())
        );
      }

      // Generate RPC stubs for a specific database
      if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith('.ts')) {
        const dbName = id.slice(VIRTUAL_PREFIX.length, -3); // Remove prefix and .ts
        const database = databases.get(dbName);

        if (!database) {
          throw new Error(`[shoplayer-database] Database "${dbName}" not found`);
        }

        const dbActions = Array.from(actions.values())
          .filter(a => a.databaseName === dbName);

        return generateRpcStubs(database, dbActions, { contextImport, shopIdPath });
      }

      return null;
    },

    async transform(code, id) {
      // Ensure initialized before transforming
      await initialize();
      
      // Transform database files to re-export from virtual modules
      // Normalize the path for consistent lookup
      const normalizedId = path.normalize(id);
      const parsed = parsedFiles.get(normalizedId);
      
      // Debug: log when we're checking a databases file
      if (id.includes('databases/')) {
        console.log(`[shoplayer-database] transform check: ${id}`);
        console.log(`[shoplayer-database] normalized: ${normalizedId}`);
        console.log(`[shoplayer-database] found in parsedFiles: ${!!parsed}`);
        console.log(`[shoplayer-database] has database: ${!!parsed?.database}`);
        if (parsed?.database) {
          const dbActions = Array.from(actions.values())
            .filter(a => a.databaseName === parsed.database!.name);
          console.log(`[shoplayer-database] actions for ${parsed.database.name}: ${dbActions.length}`);
        }
      }
      
      if (parsed?.database) {
        const dbActions = Array.from(actions.values())
          .filter(a => a.databaseName === parsed.database!.name);

        if (dbActions.length > 0) {
          const result = generateReExportModule(parsed.database.name, dbActions);
          console.log(`[shoplayer-database] transforming ${id} to:`, result);
          return result;
        }
      }

      return null;
    },
  };
}

export default shoplayerDatabasePlugin;
