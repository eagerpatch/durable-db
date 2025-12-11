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

// Virtual module prefixes
const VIRTUAL_DB_PREFIX = '\0virtual:shoplayer/databases/';
const VIRTUAL_DO_ID = 'shoplayer/databases/__durableObjects';
const VIRTUAL_DO_MODULE_ID = VIRTUAL_DB_PREFIX + '__durableObjects.ts';

// One virtual module per action
const VIRTUAL_ACTION_PREFIX = '\0virtual:shoplayer/actions/';

/**
 * Shoplayer Database Vite Plugin
 *
 * This plugin:
 * 1. Discovers database files in src/databases/ at build start
 * 2. Discovers actions lazily via transform() when action files are actually imported
 * 3. Rewrites action files to re-export from per-action virtual modules
 * 4. Each per-action virtual module generates the RPC stub for that action
 * 5. Generates Durable Object classes with action handlers (virtual module)
 * 6. Patches wrangler.jsonc with DO bindings
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

  // Map key is `${databaseName}:${actionName}` → ActionInfo
  const actions = new Map<string, ActionInfo>();

  // Map of normalized file path -> database name (for files that define databases)
  const databaseFileToName = new Map<string, string>();

  // Track which files we've seen (only for diagnostics / future use)
  const processedFiles = new Set<string>();

  let projectRoot: string;
  let config: ResolvedConfig;
  let databasesInitialized = false;

  /**
   * Normalize a filesystem path consistently.
   */
  const normalizeFsPath = (p: string): string => path.normalize(p);

  /**
   * Register a database file in the lookup map under multiple key forms.
   */
  const registerDatabaseFile = (filePath: string, dbName: string): void => {
    const abs = normalizeFsPath(filePath);
    databaseFileToName.set(abs, dbName);

    if (projectRoot) {
      const relFromRoot = normalizeFsPath(path.relative(projectRoot, abs));
      databaseFileToName.set(relFromRoot, dbName);

      if (abs.startsWith(projectRoot + path.sep)) {
        const stripped = normalizeFsPath(abs.slice(projectRoot.length + 1));
        databaseFileToName.set(stripped, dbName);
      }
    }
  };

  /**
   * Given any path coming from Vite (absolute, relative to root, with odd prefixes),
   * try to resolve it to a known database name.
   */
  const getDatabaseNameForPath = (filePath: string): string | undefined => {
    const normalized = normalizeFsPath(filePath);

    let name = databaseFileToName.get(normalized);
    if (name) return name;

    if (projectRoot) {
      const relFromRoot = normalizeFsPath(path.relative(projectRoot, normalized));
      name = databaseFileToName.get(relFromRoot);
      if (name) return name;

      if (path.isAbsolute(normalized) && normalized.startsWith(projectRoot + path.sep)) {
        const stripped = normalizeFsPath(normalized.slice(projectRoot.length + 1));
        name = databaseFileToName.get(stripped);
        if (name) return name;
      }
    }

    return undefined;
  };

  /**
   * Load or generate migrations for a database
   */
  async function loadDatabaseMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);

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
   * Actions remain lazy via transform()
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
        registerDatabaseFile(file.absolutePath, parsed.database.name);

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

  // Store dev server reference for invalidating virtual modules
  let devServer: import('vite').ViteDevServer | null = null;

  return {
    name: 'shoplayer-database',
    enforce: 'pre',
    apply: undefined,

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      projectRoot = config.root;
    },

    // configureServer is called for dev mode
    configureServer(server) {
      devServer = server;

      // Reset state for dev server
      databases.clear();
      actions.clear();
      databaseFileToName.clear();
      processedFiles.clear();
      databasesInitialized = false;

      // Watch for changes in databases directory and invalidate DO virtual module
      const absoluteDbDir = path.join(projectRoot, databasesDir);

      server.watcher.on('change', (file) => {
        const normalizedFile = normalizeFsPath(file);

        if (normalizedFile.startsWith(absoluteDbDir) && normalizedFile.endsWith('.ts')) {
          processedFiles.delete(normalizedFile);

          // Invalidate DO virtual module so it gets regenerated with new actions
          const doMod = server.moduleGraph.getModuleById(VIRTUAL_DO_MODULE_ID);
          if (doMod) {
            server.moduleGraph.invalidateModule(doMod);
          }
        }
      });
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
      // Durable Objects module: virtual:shoplayer/databases/__durableObjects
      if (id === `virtual:${VIRTUAL_DO_ID}` || id === VIRTUAL_DO_ID) {
        return VIRTUAL_DO_MODULE_ID;
      }

      // Per-action RPC module: shoplayer/actions/<db>/<action>
      const actionMatch = id.match(/^(?:virtual:)?shoplayer\/actions\/([^/]+)\/([^/]+)$/);
      if (actionMatch) {
        const [, dbName, actionName] = actionMatch;
        return `${VIRTUAL_ACTION_PREFIX}${dbName}/${actionName}.ts`;
      }

      return null;
    },

    async load(id) {
      // Lazy initialization - works for both dev and build
      if (!databasesInitialized) {
        await initializeDatabases();
      }

      // Generate Durable Objects module (aggregates all known actions)
      if (id === VIRTUAL_DO_MODULE_ID) {
        const isDev = config.command === 'serve';

        if (!isDev) {
          // In build mode, wait for transforms to settle
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
        }

        // Add watch files for all known action source files (for HMR)
        for (const action of actions.values()) {
          if (action.sourceFile) {
            this.addWatchFile(path.join(projectRoot, action.sourceFile));
          }
        }

        // Resolve cross-references now that we know all used actions
        const allActionsList = Array.from(actions.values());
        for (const [dbName] of databases) {
          const dbActions = allActionsList.filter(a => a.databaseName === dbName);
          resolveInternalActionCalls(dbActions, allActionsList);
        }

        const actionsByDatabase = new Map<string, ActionInfo[]>();
        for (const action of actions.values()) {
          const list = actionsByDatabase.get(action.databaseName) ?? [];
          list.push(action);
          actionsByDatabase.set(action.databaseName, list);
        }

        const tsCode = generateDurableObjectsModule(
          Array.from(databases.values()),
          actionsByDatabase,
          Array.from(actions.values())
        );

        const result = await transpileTS(
          tsCode,
          'shoplayer/databases/__durableObjects.ts',
          tsCode
        );

        return {
          code: result.code,
          map: result.map,
        };
      }

      // Generate RPC stub for a specific action:
      //   VIRTUAL_ACTION_PREFIX + '<db>/<action>.ts'
      if (id.startsWith(VIRTUAL_ACTION_PREFIX) && id.endsWith('.ts')) {
        const actionId = id.slice(VIRTUAL_ACTION_PREFIX.length, -3); // 'dbName/actionName'
        const [dbName, actionName] = actionId.split('/');

        const database = databases.get(dbName);
        if (!database) {
          throw new Error(`[shoplayer-database] Database "${dbName}" not found`);
        }

        const actionKey = `${dbName}:${actionName}`;
        const actionInfo = actions.get(actionKey);
        if (!actionInfo) {
          throw new Error(
            `[shoplayer-database] Action "${actionName}" for database "${dbName}" not registered. ` +
            `Make sure the action file that exports "${actionName}" and imports "action" from ` +
            `that database has been imported somewhere.`
          );
        }

        const tsCode = generateRpcStubs(database, [actionInfo], {
          contextImport,
          shopIdPath,
        });

        const result = await transpileTS(
          tsCode,
          `shoplayer/actions/${dbName}/${actionName}.ts`,
          tsCode
        );

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

      const cleanId = id.split('?', 1)[0];
      const normalizedId = normalizeFsPath(cleanId);

      // Skip if this is a database definition file - DON'T transform these
      const dbNameForThisFile = getDatabaseNameForPath(normalizedId);
      if (dbNameForThisFile) {
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
          // Strip virtual prefix and query/hash so it matches our keys
          const cleanResolvedId = resolved.id
          .replace(/^\0+/, '')
          .split('?', 1)[0];

          const resolvedPath = normalizeFsPath(cleanResolvedId);
          const dbName = getDatabaseNameForPath(resolvedPath);
          if (dbName) {
            importedDatabaseName = dbName;
            break;
          }
        }
      }

      // If this file imports action from a database and defines actions
      if (importedDatabaseName && parsed.actions.length > 0) {
        processedFiles.add(normalizedId);

        // Register each action under "<dbName>:<exportName>"
        for (const action of parsed.actions) {
          action.databaseName = importedDatabaseName;
          action.sourceFile = path.relative(projectRoot, normalizedId);

          const key = `${importedDatabaseName}:${action.exportName}`;
          actions.set(key, action);
        }

        // In dev mode, invalidate DO module so it regenerates with new actions
        if (devServer) {
          const doMod = devServer.moduleGraph.getModuleById(VIRTUAL_DO_MODULE_ID);
          if (doMod) {
            console.log('[shoplayer-database] Invalidating DO module', VIRTUAL_DO_MODULE_ID);
            devServer.moduleGraph.invalidateModule(doMod);
          }
        }

        // Collect other imports that we need to keep as side-effect imports
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

        // Re-export each action from its own per-action virtual module
        const reExports: string[] = [];
        for (const action of parsed.actions) {
          const exportName = action.exportName;
          reExports.push(
            `export { ${exportName} } from 'shoplayer/actions/${importedDatabaseName}/${exportName}';`
          );
        }

        const transformedCode = [...sideEffectImports, ...reExports].join('\n');

        // Generate sourcemap pointing back to the original file
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
      if (actions.size > 0) {
        console.log(
          `[shoplayer-database] Discovered ${actions.size} action(s) (lazy via imports only)`
        );
      }
    },
  };
}

export default shoplayerDatabasePlugin;
