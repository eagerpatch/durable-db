import * as path from 'node:path';
import { transform as esbuildTransform } from 'esbuild';
import type { Plugin, ResolvedConfig } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';
import { discoverDatabaseFiles, readFile, resolveImportPath } from './modules';
import { parseDatabaseFile, resolveInternalActionCalls } from './modules';
import { generateRpcStubs, generateDurableObjectsModule } from './modules';
import { patchWranglerConfig } from './modules';
import { loadMigrationFiles, generateMigration, buildAndLoadSchema } from '../migrations';

/**
 * Result of transpiling TypeScript
 */
interface TranspileResult {
  code: string;
  map: string | null;
}

/**
 * Transpile TypeScript code to JavaScript using esbuild
 * Returns both code and sourcemap
 */
async function transpileTS(
  code: string,
  filename: string,
  originalSource?: string
): Promise<TranspileResult> {
  const result = await esbuildTransform(code, {
    loader: 'ts',
    target: 'es2022',
    format: 'esm',
    sourcefile: filename,
    sourcemap: 'external',
    sourcesContent: true,
  });
  
  // If we have an original source, update the sourcemap to include it
  let map = result.map;
  if (map && originalSource) {
    try {
      const mapObj = JSON.parse(map);
      mapObj.sourcesContent = [originalSource];
      map = JSON.stringify(mapObj);
    } catch {
      // Keep original map if parsing fails
    }
  }
  
  return {
    code: result.code,
    map,
  };
}

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
   * Whether to auto-generate migrations from schema changes.
   * Only runs in development mode (vite dev / vite serve).
   * Set to false to disable entirely, or true to force in all modes.
   * @default 'development' (auto-migrations only in dev mode)
   */
  autoMigrations?: boolean | 'development';
}

// Virtual module prefix - only used for Durable Objects module
const VIRTUAL_PREFIX = '\0virtual:shoplayer/databases/';
const VIRTUAL_DO_ID = 'shoplayer/databases/__durableObjects';

/**
 * Shoplayer Database Vite Plugin
 *
 * This plugin:
 * 1. Discovers database files in src/databases/ at build start
 * 2. Dynamically discovers actions as Vite transforms files that are actually used
 * 3. Transforms action files inline with RPC stub code
 * 4. Generates Durable Object classes with action handlers (virtual module)
 * 5. Patches wrangler.jsonc with DO bindings
 */
export function shoplayerDatabasePlugin(options: DatabasePluginOptions = {}): Plugin {
  const {
    contextImport = '@shoplayer/database/context',
    databasesDir = 'src/databases',
    shopIdPath = 'session.shop',
    autoMigrations = 'development',
  } = options;

  // State
  const databases = new Map<string, DatabaseInfo>();
  const actions = new Map<string, ActionInfo>();
  
  // Map of normalized file path -> database name (for files that define databases)
  const databaseFileToName = new Map<string, string>();
  
  // Track which files have been processed
  const processedFiles = new Set<string>();

  let projectRoot: string;
  let config: ResolvedConfig;
  let databasesInitialized = false;

  /**
   * Load or generate migrations for a database
   */
  async function loadDatabaseMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);

    // Determine if we should run auto-migrations
    // - 'development': only in dev mode (config.command === 'serve')
    // - true: always run
    // - false: never run
    const isDev = config.command === 'serve';
    const shouldAutoMigrate = autoMigrations === true || (autoMigrations === 'development' && isDev);

    if (shouldAutoMigrate && db.schemaImport && db.schemaTableNames.length > 0) {
      try {
        const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
        if (schemaPath) {
          const schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);

          if (Object.keys(schema).length > 0) {
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
        console.warn(
          `[shoplayer-database] Could not auto-generate migrations for ${db.name}: ${error}`
        );
      }
    }

    db.migrations = loadMigrationFiles(migrationsDir);

    if (db.migrations.size > 0) {
      console.log(
        `[shoplayer-database] Loaded ${db.migrations.size} migration(s) for ${db.name}`
      );
    }
  }

  /**
   * Initialize databases - discovers database definitions only (not actions)
   */
  async function initializeDatabases(): Promise<void> {
    if (databasesInitialized) return;

    const discoveredDbFiles = discoverDatabaseFiles({
      projectRoot,
      databasesDir,
    });

    for (const file of discoveredDbFiles) {
      const code = readFile(file.absolutePath);
      const parsed = parseDatabaseFile(file.absolutePath, code);

      if (parsed.database) {
        databases.set(parsed.database.name, parsed.database);
        databaseFileToName.set(path.normalize(file.absolutePath), parsed.database.name);
        
        await loadDatabaseMigrations(parsed.database);
      }
    }

    if (databases.size > 0) {
      console.log(`[shoplayer-database] Found ${databases.size} database(s)`);
      
      // Patch wrangler config when databases are discovered
      patchWranglerConfig(projectRoot, Array.from(databases.values()));
    }

    databasesInitialized = true;
  }

  return {
    name: 'shoplayer-database',
    enforce: 'pre',
    apply: undefined,

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      projectRoot = config.root;
    },

    // configureServer is called for dev mode
    configureServer() {
      // Reset state for dev server
      databases.clear();
      actions.clear();
      databaseFileToName.clear();
      processedFiles.clear();
      databasesInitialized = false;
    },

    // buildStart is called for production builds
    buildStart() {
      // Reset state for new build
      databases.clear();
      actions.clear();
      databaseFileToName.clear();
      processedFiles.clear();
      databasesInitialized = false;
    },

    async resolveId(id) {
      // Handle: virtual:shoplayer/databases/__durableObjects
      if (id === `virtual:${VIRTUAL_DO_ID}` || id === VIRTUAL_DO_ID) {
        return VIRTUAL_PREFIX + '__durableObjects.ts';
      }

      // Handle: shoplayer/databases/xxx
      const dbNameMatch = id.match(/^(?:virtual:)?shoplayer\/databases\/(.+)$/);
      if (dbNameMatch) {
        let dbName = dbNameMatch[1];
        if (dbName.endsWith('.ts')) {
          dbName = dbName.slice(0, -3);
        }
        if (dbName === '__durableObjects') {
          return VIRTUAL_PREFIX + '__durableObjects.ts';
        }
        return VIRTUAL_PREFIX + dbName + '.ts';
      }

      return null;
    },

    async load(id) {
      // Lazy initialization - works for both dev and build
      if (!databasesInitialized) {
        await initializeDatabases();
      }

      // Generate Durable Objects module
      if (id === VIRTUAL_PREFIX + '__durableObjects.ts') {
        // Wait for transforms to settle by checking if action count stabilizes
        // This handles the case where load() is called before all transforms complete
        let stableCount = 0;
        let lastCount = -1;
        
        while (stableCount < 3) {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (actions.size === lastCount) {
            stableCount++;
          } else {
            stableCount = 0;
            lastCount = actions.size;
          }
          // Safety limit
          if (stableCount > 50) break;
        }
        
        // Resolve cross-references now that we know all used actions
        const allActionsList = Array.from(actions.values());
        for (const [dbName] of databases) {
          const dbActions = allActionsList.filter(a => a.databaseName === dbName);
          resolveInternalActionCalls(dbActions, allActionsList);
        }

        const actionsByDatabase = new Map<string, ActionInfo[]>();
        for (const action of actions.values()) {
          const dbActions = actionsByDatabase.get(action.databaseName) ?? [];
          dbActions.push(action);
          actionsByDatabase.set(action.databaseName, dbActions);
        }

        const tsCode = generateDurableObjectsModule(
          Array.from(databases.values()),
          actionsByDatabase,
          Array.from(actions.values())
        );

        const result = await transpileTS(tsCode, 'shoplayer/databases/__durableObjects.ts', tsCode);
        return {
          code: result.code,
          map: result.map,
        };
      }

      // Generate RPC stubs for a specific database
      if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith('.ts')) {
        const dbName = id.slice(VIRTUAL_PREFIX.length, -3);
        const database = databases.get(dbName);

        if (!database) {
          throw new Error(`[shoplayer-database] Database "${dbName}" not found`);
        }

        // Wait for transforms to settle
        let stableCount = 0;
        let lastCount = -1;
        
        while (stableCount < 3) {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (actions.size === lastCount) {
            stableCount++;
          } else {
            stableCount = 0;
            lastCount = actions.size;
          }
          if (stableCount > 50) break;
        }

        // Resolve cross-references
        const allActionsList = Array.from(actions.values());
        for (const [name] of databases) {
          const dbActions = allActionsList.filter(a => a.databaseName === name);
          resolveInternalActionCalls(dbActions, allActionsList);
        }

        const dbActions = allActionsList.filter(a => a.databaseName === dbName);
        const tsCode = generateRpcStubs(database, dbActions, { contextImport, shopIdPath });
        const result = await transpileTS(tsCode, `shoplayer/databases/${dbName}.ts`, tsCode);
        return {
          code: result.code,
          map: result.map,
        };
      }

      return null;
    },

    async transform(code, id) {
      // Skip virtual modules and node_modules
      if (id.startsWith('\0') || id.includes('node_modules')) {
        return null;
      }

      // Only process TypeScript files
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) {
        return null;
      }

      // Lazy initialization - works for both dev and build
      if (!databasesInitialized) {
        await initializeDatabases();
      }

      const cleanId = id.split('?')[0];
      const normalizedId = path.normalize(cleanId);

      // Skip if already processed
      if (processedFiles.has(normalizedId)) {
        return null;
      }

      // Check if this is a database definition file - DON'T transform these
      // They stay as-is so that `action` can be imported from them
      if (databaseFileToName.has(normalizedId)) {
        processedFiles.add(normalizedId);
        return null;
      }

      // Parse the file to check for action imports and definitions
      const parsed = parseDatabaseFile(normalizedId, code);

      // Check if this file imports 'action' from a database file
      let importedDatabaseName: string | null = null;
      
      for (const [, importInfo] of parsed.localImports) {
        if (importInfo.imported !== 'action') {
          continue;
        }

        // Use Vite's resolver to handle aliases
        const resolved = await this.resolve(importInfo.source, normalizedId);
        
        if (resolved) {
          const resolvedPath = path.normalize(resolved.id);
          const dbName = databaseFileToName.get(resolvedPath);
          if (dbName) {
            importedDatabaseName = dbName;
            break;
          }
        }
      }

      // If this file imports action from a database and defines actions
      if (importedDatabaseName && parsed.actions.length > 0) {
        processedFiles.add(normalizedId);

        // Register each action
        for (const action of parsed.actions) {
          action.databaseName = importedDatabaseName;
          // Store the original file path for sourcemap reference (relative to project root)
          action.sourceFile = path.relative(projectRoot, normalizedId);
          actions.set(action.exportName, action);
        }
        
        // Collect other imports that we need to keep as side-effect imports
        // These ensure Vite processes those files (which might be other action files)
        const sideEffectImports: string[] = [];
        for (const [, importInfo] of parsed.localImports) {
          // Skip the action import from the database file
          if (importInfo.imported === 'action') {
            continue;
          }
          // Keep all other relative imports as side-effect imports
          if (importInfo.source.startsWith('.')) {
            sideEffectImports.push(`import '${importInfo.source}';`);
          }
        }

        // Re-export actions from virtual module
        // The virtual module is generated in load() after all actions are discovered
        const actionNames = parsed.actions.map(a => a.exportName);
        const reExport = `export { ${actionNames.join(', ')} } from 'shoplayer/databases/${importedDatabaseName}';`;
        
        const transformedCode = [...sideEffectImports, reExport].join('\n');
        
        // Generate sourcemap pointing back to the original file
        // Since we're completely replacing the code, we map each line to line 1 of the original
        // This helps debuggers at least point to the right file
        const lines = transformedCode.split('\n');
        const mappings = lines.map(() => 'AAAA').join(';');
        
        return {
          code: transformedCode,
          map: {
            version: 3,
            sources: [normalizedId],
            sourcesContent: [code],
            names: [],
            mappings,
          },
        };
      }

      return null;
    },

    buildEnd() {
      // Log summary for production builds
      if (actions.size > 0) {
        console.log(`[shoplayer-database] Discovered ${actions.size} action(s) (only those actually used)`);
      }
    },
  };
}

export default shoplayerDatabasePlugin;
