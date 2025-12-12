import * as path from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';
import { discoverDatabaseFiles, readFile, resolveImportPath } from './modules';
import { parseDatabaseFile, resolveInternalActionCalls } from './modules';
import { generateRpcStubs, generateDurableObjectsModule } from './modules';
import { patchWranglerConfig } from './modules';
import { loadMigrationFiles, generateMigration, buildAndLoadSchema } from '../migrations';

// ============================================================================
// Types
// ============================================================================

export interface DatabasePluginOptions {
  /** Import path for getContext(). @default '@shoplayer/database/context' */
  contextImport?: string;
  /** Directory containing database definitions. @default 'src/databases' */
  databasesDir?: string;
  /** Path to shop ID in context. @default 'session.shop' */
  shopIdPath?: string;
  /** Auto-generate migrations. @default 'development' */
  autoMigrations?: boolean | 'development';
}

// ============================================================================
// Constants
// ============================================================================

const VIRTUAL_DB_PREFIX = '\0virtual:shoplayer/databases/';
const VIRTUAL_DO_ID = 'shoplayer/databases/__durableObjects';
const VIRTUAL_DO_MODULE_ID = VIRTUAL_DB_PREFIX + '__durableObjects.js';
const VIRTUAL_ACTION_PREFIX = '\0virtual:shoplayer/actions/';

// ============================================================================
// Virtual Module Helpers
// ============================================================================

/** Check if an import ID is for the Durable Objects module */
export function isDurableObjectsImport(id: string): boolean {
  return id === `virtual:${VIRTUAL_DO_ID}` || id === VIRTUAL_DO_ID;
}

/** Parse an action import ID, returning db/action names or null */
export function parseActionImport(id: string): { dbName: string; actionName: string } | null {
  const match = id.match(/^(?:virtual:)?shoplayer\/actions\/([^/]+)\/([^/]+)$/);
  return match ? { dbName: match[1], actionName: match[2] } : null;
}

// ============================================================================
// Transform Output Generation
// ============================================================================

/** Generate the transformed code for an action file */
export function generateActionTransform(
  dbName: string,
  actions: ActionInfo[],
  localImports: Map<string, { imported: string; source: string }>,
  originalCode: string,
  sourceFile: string
) {
  const lines: string[] = [];

  // Keep non-action relative imports as side effects
  for (const [, info] of localImports) {
    if (info.imported !== 'action' && info.source.startsWith('.')) {
      lines.push(`import '${info.source}';`);
    }
  }

  // Re-export each action from its virtual module
  for (const action of actions) {
    lines.push(`export { ${action.exportName} } from 'shoplayer/actions/${dbName}/${action.exportName}';`);
  }

  const code = lines.join('\n');

  return {
    code,
    map: {
      version: 3 as const,
      sources: [sourceFile],
      sourcesContent: [originalCode],
      names: [] as string[],
      mappings: lines.map(() => 'AAAA').join(';'),
    },
  };
}

// ============================================================================
// Plugin State
// ============================================================================

class PluginState {
  readonly databases = new Map<string, DatabaseInfo>();
  readonly actions = new Map<string, ActionInfo>();

  private readonly databaseFileToName = new Map<string, string>();
  private readonly processedFiles = new Set<string>();
  private initialized = false;

  projectRoot = '';
  config!: ResolvedConfig;
  devServer: ViteDevServer | null = null;

  constructor(readonly options: Required<DatabasePluginOptions>) {}

  // -------------------------------------------------------------------------
  // Path Utilities
  // -------------------------------------------------------------------------

  private normalizePath(p: string): string {
    return path.normalize(p);
  }

  registerDatabaseFile(filePath: string, dbName: string): void {
    const abs = this.normalizePath(filePath);
    this.databaseFileToName.set(abs, dbName);

    if (this.projectRoot) {
      const rel = this.normalizePath(path.relative(this.projectRoot, abs));
      this.databaseFileToName.set(rel, dbName);

      if (abs.startsWith(this.projectRoot + path.sep)) {
        const stripped = this.normalizePath(abs.slice(this.projectRoot.length + 1));
        this.databaseFileToName.set(stripped, dbName);
      }
    }
  }

  getDatabaseNameForPath(filePath: string): string | undefined {
    const normalized = this.normalizePath(filePath);

    let name = this.databaseFileToName.get(normalized);
    if (name) return name;

    if (this.projectRoot) {
      const rel = this.normalizePath(path.relative(this.projectRoot, normalized));
      name = this.databaseFileToName.get(rel);
      if (name) return name;

      if (path.isAbsolute(normalized) && normalized.startsWith(this.projectRoot + path.sep)) {
        const stripped = this.normalizePath(normalized.slice(this.projectRoot.length + 1));
        name = this.databaseFileToName.get(stripped);
        if (name) return name;
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // File Tracking
  // -------------------------------------------------------------------------

  markProcessed(filePath: string): void {
    this.processedFiles.add(this.normalizePath(filePath));
  }

  clearProcessed(filePath: string): void {
    this.processedFiles.delete(this.normalizePath(filePath));
  }

  // -------------------------------------------------------------------------
  // Action Registration
  // -------------------------------------------------------------------------

  registerAction(action: ActionInfo, dbName: string, sourceFile: string): void {
    action.databaseName = dbName;
    action.sourceFile = path.relative(this.projectRoot, sourceFile);
    this.actions.set(`${dbName}:${action.exportName}`, action);
  }

  getAction(dbName: string, actionName: string): ActionInfo | undefined {
    return this.actions.get(`${dbName}:${actionName}`);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  reset(): void {
    this.databases.clear();
    this.actions.clear();
    this.databaseFileToName.clear();
    this.processedFiles.clear();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const files = discoverDatabaseFiles({
      projectRoot: this.projectRoot,
      databasesDir: this.options.databasesDir,
    });

    for (const file of files) {
      const code = readFile(file.absolutePath);
      const parsed = parseDatabaseFile(file.absolutePath, code);

      if (parsed.database) {
        this.databases.set(parsed.database.name, parsed.database);
        this.registerDatabaseFile(file.absolutePath, parsed.database.name);
        await this.loadMigrations(parsed.database);
      }
    }

    if (this.databases.size > 0) {
      console.log(`[shoplayer-database] Found ${this.databases.size} database(s)`);
      patchWranglerConfig(this.projectRoot, Array.from(this.databases.values()));
    }

    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  private async loadMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);
    const isDev = this.config.command === 'serve';
    const shouldAutoMigrate =
      this.options.autoMigrations === true ||
      (this.options.autoMigrations === 'development' && isDev);

    if (shouldAutoMigrate && db.schemaImport && db.schemaTableNames.length > 0) {
      try {
        const schemaPath = resolveImportPath(db.filePath, db.schemaImport);
        if (schemaPath) {
          const schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
          if (Object.keys(schema).length > 0) {
            const result = await generateMigration({ migrationsDir, schema, write: true });
            if (result.hasChanges) {
              console.log(
                `[shoplayer-database] Generated migration for ${db.name}: ${result.migrationName} ` +
                `(${result.statements.length} statements)`
              );
            }
          }
        }
      } catch (error) {
        console.warn(`[shoplayer-database] Could not auto-generate migrations for ${db.name}: ${error}`);
      }
    }

    db.migrations = loadMigrationFiles(migrationsDir);
    if (db.migrations.size > 0) {
      console.log(`[shoplayer-database] Loaded ${db.migrations.size} migration(s) for ${db.name}`);
    }
  }

  // -------------------------------------------------------------------------
  // HMR
  // -------------------------------------------------------------------------

  invalidateDOModule(): void {
    if (!this.devServer) return;
    const mod = this.devServer.moduleGraph.getModuleById(VIRTUAL_DO_MODULE_ID);
    if (mod) {
      console.log('[shoplayer-database] Invalidating DO module', VIRTUAL_DO_MODULE_ID);
      this.devServer.moduleGraph.invalidateModule(mod);
    }
  }
}

// ============================================================================
// Plugin
// ============================================================================

export function shoplayerDatabasePlugin(options: DatabasePluginOptions = {}): Plugin {
  const state = new PluginState({
    contextImport: options.contextImport ?? '@shoplayer/database/context',
    databasesDir: options.databasesDir ?? 'src/databases',
    shopIdPath: options.shopIdPath ?? 'session.shop',
    autoMigrations: options.autoMigrations ?? 'development',
  });

  return {
    name: 'shoplayer-database',
    enforce: 'pre',
    apply: undefined,

    configResolved(config) {
      state.config = config;
      state.projectRoot = config.root;
    },

    configureServer(server) {
      state.devServer = server;
      state.reset();

      const absoluteDbDir = path.join(state.projectRoot, state.options.databasesDir);
      server.watcher.on('change', (file) => {
        const normalized = path.normalize(file);
        if (normalized.startsWith(absoluteDbDir) && normalized.endsWith('.ts')) {
          state.clearProcessed(normalized);
          state.invalidateDOModule();
        }
      });
    },

    buildStart() {
      state.reset();
    },

    resolveId(id) {
      if (isDurableObjectsImport(id)) {
        return VIRTUAL_DO_MODULE_ID;
      }

      const action = parseActionImport(id);
      if (action) {
        return `${VIRTUAL_ACTION_PREFIX}${action.dbName}/${action.actionName}.js`;
      }

      return null;
    },

    async load(id) {
      await state.initialize();

      // Durable Objects module
      if (id === VIRTUAL_DO_MODULE_ID) {
        return loadDurableObjectsModule.call(this, state);
      }

      // Per-action RPC stub module
      if (id.startsWith(VIRTUAL_ACTION_PREFIX) && id.endsWith('.js')) {
        return loadActionModule(state, id);
      }

      return null;
    },

    async transform(code, id) {
      // Skip virtual modules and node_modules
      if (id.startsWith('\0') || id.includes('node_modules')) {
        return null;
      }

      // Only TypeScript files
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) {
        return null;
      }

      await state.initialize();

      const cleanId = id.split('?', 1)[0];
      const normalizedId = path.normalize(cleanId);

      // Skip database definition files
      if (state.getDatabaseNameForPath(normalizedId)) {
        state.markProcessed(normalizedId);
        return null;
      }

      const parsed = parseDatabaseFile(normalizedId, code);

      // Find which database this file imports 'action' from
      const importedDbName = await findImportedDatabase.call(this, state, parsed.localImports, normalizedId);

      // Transform action files
      if (importedDbName && parsed.actions.length > 0) {
        state.markProcessed(normalizedId);

        // Register actions
        for (const action of parsed.actions) {
          state.registerAction(action, importedDbName, normalizedId);
        }

        state.invalidateDOModule();

        return generateActionTransform(
          importedDbName,
          parsed.actions,
          parsed.localImports,
          code,
          normalizedId
        );
      }

      return null;
    },

    buildEnd() {
      if (state.actions.size > 0) {
        console.log(`[shoplayer-database] Discovered ${state.actions.size} action(s) (lazy via imports only)`);
      }
    },
  };
}

// ============================================================================
// Load Handlers
// ============================================================================

async function loadDurableObjectsModule(
  this: { addWatchFile: (file: string) => void },
  state: PluginState
): Promise<{ code: string }> {
  // In build mode, wait for transforms to settle
  if (state.config.command !== 'serve') {
    let stableCount = 0;
    let lastCount = -1;
    while (stableCount < 3) {
      await new Promise(r => setTimeout(r, 5));
      if (state.actions.size === lastCount) {
        stableCount++;
      } else {
        stableCount = 0;
        lastCount = state.actions.size;
      }
      if (stableCount > 50) break;
    }
  }

  // Watch action source files for HMR
  for (const action of state.actions.values()) {
    if (action.sourceFile) {
      this.addWatchFile(path.join(state.projectRoot, action.sourceFile));
    }
  }

  // Resolve cross-database references
  const allActions = Array.from(state.actions.values());
  for (const [dbName] of state.databases) {
    const dbActions = allActions.filter(a => a.databaseName === dbName);
    resolveInternalActionCalls(dbActions, allActions);
  }

  // Group by database
  const actionsByDb = new Map<string, ActionInfo[]>();
  for (const action of state.actions.values()) {
    const list = actionsByDb.get(action.databaseName) ?? [];
    list.push(action);
    actionsByDb.set(action.databaseName, list);
  }

  return {
    code: generateDurableObjectsModule(
      Array.from(state.databases.values()),
      actionsByDb,
      allActions
    ),
  };
}

function loadActionModule(state: PluginState, id: string): { code: string } {
  const actionPath = id.slice(VIRTUAL_ACTION_PREFIX.length, -3); // remove prefix and .js
  const [dbName, actionName] = actionPath.split('/');

  const database = state.databases.get(dbName);
  if (!database) {
    throw new Error(`[shoplayer-database] Database "${dbName}" not found`);
  }

  const action = state.getAction(dbName, actionName);
  if (!action) {
    throw new Error(
      `[shoplayer-database] Action "${actionName}" for database "${dbName}" not registered. ` +
      `Make sure the action file that exports "${actionName}" and imports "action" from ` +
      `that database has been imported somewhere.`
    );
  }

  return {
    code: generateRpcStubs(database, [action], {
      contextImport: state.options.contextImport,
      shopIdPath: state.options.shopIdPath,
    }),
  };
}

async function findImportedDatabase(
  this: { resolve: (source: string, importer: string) => Promise<{ id: string } | null> },
  state: PluginState,
  imports: Map<string, { imported: string; source: string }>,
  importer: string
): Promise<string | null> {
  for (const [, info] of imports) {
    if (info.imported !== 'action') continue;

    const resolved = await this.resolve(info.source, importer);
    if (resolved) {
      const cleanId = path.normalize(resolved.id.replace(/^\0+/, '').split('?', 1)[0]);
      const dbName = state.getDatabaseNameForPath(cleanId);
      if (dbName) return dbName;
    }
  }
  return null;
}

export default shoplayerDatabasePlugin;
