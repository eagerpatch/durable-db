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
// Virtual Module IDs
// ============================================================================

const VIRTUAL_PREFIX = '\0virtual:shoplayer/';
const DO_MODULE_ID = `${VIRTUAL_PREFIX}databases/__durableObjects.js`;
const ACTION_PREFIX = `${VIRTUAL_PREFIX}actions/`;

function isDurableObjectsImport(id: string): boolean {
  return id === 'shoplayer/databases/__durableObjects' ||
    id === 'virtual:shoplayer/databases/__durableObjects';
}

function parseActionImport(id: string): { dbName: string; actionName: string } | null {
  const match = id.match(/^(?:virtual:)?shoplayer\/actions\/([^/]+)\/([^/]+)$/);
  return match ? { dbName: match[1], actionName: match[2] } : null;
}

// ============================================================================
// Plugin State
// ============================================================================

class PluginState {
  databases = new Map<string, DatabaseInfo>();
  actions = new Map<string, ActionInfo>();

  private dbFilePaths = new Map<string, string>(); // normalized path → db name
  private initialized = false;

  projectRoot = '';
  config!: ResolvedConfig;
  devServer: ViteDevServer | null = null;

  constructor(
    readonly options: Required<Pick<DatabasePluginOptions, 'contextImport' | 'databasesDir' | 'shopIdPath' | 'autoMigrations'>>
  ) {}

  reset(): void {
    this.databases.clear();
    this.actions.clear();
    this.dbFilePaths.clear();
    this.initialized = false;
  }

  registerDatabaseFile(filePath: string, dbName: string): void {
    const normalized = path.normalize(filePath);
    this.dbFilePaths.set(normalized, dbName);

    // Also register relative path from project root
    if (this.projectRoot) {
      const relative = path.relative(this.projectRoot, normalized);
      this.dbFilePaths.set(path.normalize(relative), dbName);
    }
  }

  getDatabaseForFile(filePath: string): string | undefined {
    const normalized = path.normalize(filePath);

    // Try absolute path
    let dbName = this.dbFilePaths.get(normalized);
    if (dbName) return dbName;

    // Try relative to project root
    if (this.projectRoot && path.isAbsolute(normalized)) {
      const relative = path.relative(this.projectRoot, normalized);
      dbName = this.dbFilePaths.get(path.normalize(relative));
    }

    return dbName;
  }

  registerAction(action: ActionInfo, dbName: string, sourceFile: string): void {
    action.databaseName = dbName;
    action.sourceFile = path.relative(this.projectRoot, sourceFile);
    this.actions.set(`${dbName}:${action.exportName}`, action);
  }

  getAction(dbName: string, actionName: string): ActionInfo | undefined {
    return this.actions.get(`${dbName}:${actionName}`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

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
  }

  private async loadMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(db.filePath), db.migrationsDir);
    const isDev = this.config.command === 'serve';
    const shouldAutoMigrate = this.options.autoMigrations === true ||
      (this.options.autoMigrations === 'development' && isDev);

    if (shouldAutoMigrate && db.schemaImport && db.schemaTableNames.length > 0) {
      await this.tryAutoMigrate(db, migrationsDir);
    }

    db.migrations = loadMigrationFiles(migrationsDir);
    if (db.migrations.size > 0) {
      console.log(`[shoplayer-database] Loaded ${db.migrations.size} migration(s) for ${db.name}`);
    }
  }

  private async tryAutoMigrate(db: DatabaseInfo, migrationsDir: string): Promise<void> {
    try {
      const schemaPath = resolveImportPath(db.filePath, db.schemaImport!);
      if (!schemaPath) return;

      const schema = await buildAndLoadSchema(schemaPath, db.schemaTableNames);
      if (Object.keys(schema).length === 0) return;

      const result = await generateMigration({ migrationsDir, schema, write: true });
      if (result.hasChanges) {
        console.log(
          `[shoplayer-database] Generated migration for ${db.name}: ${result.migrationName} ` +
          `(${result.statements.length} statements)`
        );
      }
    } catch (error) {
      console.warn(`[shoplayer-database] Could not auto-generate migrations for ${db.name}: ${error}`);
    }
  }

  invalidateDOModule(): void {
    if (!this.devServer) return;
    const mod = this.devServer.moduleGraph.getModuleById(DO_MODULE_ID);
    if (mod) {
      this.devServer.moduleGraph.invalidateModule(mod);
    }
  }
}

// ============================================================================
// Code Generation
// ============================================================================

function generateActionTransform(
  dbName: string,
  actions: ActionInfo[],
  localImports: Map<string, { imported: string; source: string }>
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
      sources: [] as string[],
      sourcesContent: [] as string[],
      names: [] as string[],
      mappings: lines.map(() => 'AAAA').join(';'),
    },
  };
}

// ============================================================================
// Utilities
// ============================================================================

async function waitForStableCount(
  getCount: () => number,
  intervalMs: number,
  requiredStable: number
): Promise<void> {
  let stableCount = 0;
  let lastCount = -1;

  while (stableCount < requiredStable) {
    await new Promise(r => setTimeout(r, intervalMs));
    const count = getCount();
    if (count === lastCount) {
      stableCount++;
    } else {
      stableCount = 0;
      lastCount = count;
    }
    if (stableCount > 50) break; // Safety limit
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

    configResolved(config) {
      state.config = config;
      state.projectRoot = config.root;
    },

    configureServer(server) {
      state.devServer = server;
      state.reset();

      const dbDir = path.join(state.projectRoot, state.options.databasesDir);
      server.watcher.on('change', (file) => {
        if (path.normalize(file).startsWith(dbDir) && file.endsWith('.ts')) {
          state.invalidateDOModule();
        }
      });
    },

    buildStart() {
      state.reset();
    },

    resolveId(id) {
      if (isDurableObjectsImport(id)) {
        return DO_MODULE_ID;
      }

      const action = parseActionImport(id);
      if (action) {
        return `${ACTION_PREFIX}${action.dbName}/${action.actionName}.js`;
      }

      return null;
    },

    async load(id) {
      await state.initialize();

      if (id === DO_MODULE_ID) {
        return loadDurableObjectsModule.call(this, state);
      }

      if (id.startsWith(ACTION_PREFIX) && id.endsWith('.js')) {
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

      const cleanId = path.normalize(id.split('?')[0]);

      // Skip database definition files
      if (state.getDatabaseForFile(cleanId)) {
        return null;
      }

      const parsed = parseDatabaseFile(cleanId, code);
      if (parsed.actions.length === 0) {
        return null;
      }

      // Find which database this file imports 'action' from
      const dbName = await findImportedDatabase.call(this, state, parsed.localImports, cleanId);
      if (!dbName) {
        return null;
      }

      // Register discovered actions
      for (const action of parsed.actions) {
        state.registerAction(action, dbName, cleanId);
      }

      state.invalidateDOModule();

      return generateActionTransform(dbName, parsed.actions, parsed.localImports);
    },

    buildEnd() {
      if (state.actions.size > 0) {
        console.log(`[shoplayer-database] Discovered ${state.actions.size} action(s)`);
      }
    },
  };
}

// ============================================================================
// Load Handlers (extracted for clarity)
// ============================================================================

async function loadDurableObjectsModule(
  this: { addWatchFile: (file: string) => void },
  state: PluginState
): Promise<{ code: string }> {
  // In build mode, wait briefly for action discovery to settle
  if (state.config.command === 'build') {
    await waitForStableCount(() => state.actions.size, 5, 3);
  }

  // Register watch files for HMR
  for (const action of state.actions.values()) {
    if (action.sourceFile) {
      this.addWatchFile(path.join(state.projectRoot, action.sourceFile));
    }
  }

  // Resolve cross-database references
  const allActions = Array.from(state.actions.values());
  for (const dbName of state.databases.keys()) {
    const dbActions = allActions.filter(a => a.databaseName === dbName);
    resolveInternalActionCalls(dbActions, allActions);
  }

  // Group actions by database
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
  const actionPath = id.slice(ACTION_PREFIX.length, -3); // remove prefix and .js
  const [dbName, actionName] = actionPath.split('/');

  const database = state.databases.get(dbName);
  if (!database) {
    throw new Error(`[shoplayer-database] Database "${dbName}" not found`);
  }

  const action = state.getAction(dbName, actionName);
  if (!action) {
    throw new Error(
      `[shoplayer-database] Action "${actionName}" not found. ` +
      `Ensure the action file is imported somewhere.`
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
    if (!resolved) continue;

    const cleanPath = path.normalize(resolved.id.replace(/^\0+/, '').split('?')[0]);
    const dbName = state.getDatabaseForFile(cleanPath);
    if (dbName) return dbName;
  }
  return null;
}

export default shoplayerDatabasePlugin;
