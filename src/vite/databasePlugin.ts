import * as path from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';
import { debugVite } from '../utils/debug';

import { discoverDatabaseFiles, readFile } from './modules/discovery';
import { parseDatabaseFile } from './modules/parser';
import { patchWranglerConfig } from './modules/wrangler';
import { generateDurableObjectsModule, transformActionFile } from './modules/generator';
import { loadMigrationFiles } from '../migrations/generator';

// ============================================================================
// Types
// ============================================================================

export interface DatabasePluginOptions {
  /** Import path for the context module. Default: '@eagerpatch/durable-db/context' */
  contextImport?: string;
  /** Import path for the registry module. Default: '@eagerpatch/durable-db/registry' */
  registryImport?: string;
  /** Directory containing database definitions. Default: 'src/databases' */
  databasesDir?: string;
  /** Directory for production migrations, relative to project root. Default: 'migrations' */
  migrationsDir?: string;
}

interface ResolvedOptions {
  contextImport: string;
  registryImport: string;
  databasesDir: string;
  migrationsDir: string;
}

// ============================================================================
// Virtual Module IDs
// ============================================================================

const DURABLE_OBJECTS_ID = 'eagerpatch/durable-db/__durableObjects';
const VIRTUAL_DO_MODULE_ID = '\0virtual:eagerpatch/durable-db/__durableObjects.js';

// ============================================================================
// State Management
// ============================================================================

class PluginState {
  readonly databases = new Map<string, DatabaseInfo>();
  readonly actions = new Map<string, ActionInfo>();

  private readonly databaseFilePaths = new Map<string, string>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  projectRoot = '';
  config!: ResolvedConfig;
  devServer: ViteDevServer | null = null;

  constructor(readonly options: ResolvedOptions) {}

  registerDatabaseFile(filePath: string, dbName: string): void {
    const abs = path.normalize(filePath);
    this.databaseFilePaths.set(abs, dbName);

    if (this.projectRoot) {
      const rel = path.relative(this.projectRoot, abs);
      this.databaseFilePaths.set(path.normalize(rel), dbName);
    }
  }

  getDatabaseNameForPath(filePath: string): string | undefined {
    const normalized = path.normalize(filePath);

    const direct = this.databaseFilePaths.get(normalized);
    if (direct) return direct;

    if (this.projectRoot) {
      const rel = path.relative(this.projectRoot, normalized);
      return this.databaseFilePaths.get(path.normalize(rel));
    }

    return undefined;
  }

  registerAction(action: ActionInfo, dbName: string, sourceFile: string): void {
    action.databaseName = dbName;
    action.sourceFile = path.relative(this.projectRoot, sourceFile);
    this.actions.set(`${dbName}:${action.exportName}`, action);
  }

  reset(): void {
    this.databases.clear();
    this.actions.clear();
    this.databaseFilePaths.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const files = discoverDatabaseFiles({
      projectRoot: this.projectRoot,
      databasesDir: this.options.databasesDir,
    });

    for (const file of files) {
      const code = readFile(file.absolutePath);
      const parsed = parseDatabaseFile(file.absolutePath, code);

      if (parsed.database) {
        parsed.database.migrationsDir = path.resolve(this.projectRoot, this.options.migrationsDir, parsed.database.name);
        this.databases.set(parsed.database.name, parsed.database);
        this.registerDatabaseFile(file.absolutePath, parsed.database.name);
        await this.loadMigrations(parsed.database);
      }
    }

    if (this.databases.size > 0) {
      debugVite('Found %d database(s)', this.databases.size);
      patchWranglerConfig(this.projectRoot, Array.from(this.databases.values()));
    }

    this.initialized = true;
  }

  private async loadMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = db.migrationsDir;
    const isDev = this.config.command === 'serve';

    // Load production migrations
    db.migrations = loadMigrationFiles(migrationsDir);

    // In dev mode, also load dev migrations
    if (isDev) {
      try {
        const { loadDevMigrations } = await import('../cli/state');
        const devMigrations = loadDevMigrations(this.projectRoot, db.name);
        
        // Merge dev migrations with prod migrations
        // Dev migrations are prefixed with _dev_ to sort after prod migrations
        for (const [name, chunks] of devMigrations) {
          db.migrations.set(`_dev_${name}`, chunks);
        }
        
        if (devMigrations.size > 0) {
          debugVite('Loaded %d dev migration(s) for %s', devMigrations.size, db.name);
        }
      } catch (error) {
        // Dev migrations not available, that's fine
      }
    }

    if (db.migrations.size > 0) {
      debugVite('Total %d migration(s) for %s', db.migrations.size, db.name);
    }
  }

  invalidateDOModule(): void {
    if (!this.devServer) return;

    for (const mod of this.devServer.moduleGraph.idToModuleMap.values()) {
      const id = mod.id ?? '';
      if (id === VIRTUAL_DO_MODULE_ID || id.startsWith(VIRTUAL_DO_MODULE_ID + '?')) {
        this.devServer.moduleGraph.invalidateModule(mod);
      }
    }
  }
}

// ============================================================================
// Import Resolution Helper
// ============================================================================

async function findImportedDatabase(
  resolve: (source: string, importer: string) => Promise<{ id: string } | null>,
  state: PluginState,
  imports: Map<string, { imported: string; source: string }>,
  importer: string
): Promise<string | null> {
  for (const [, info] of imports) {
    if (info.imported !== 'action') continue;

    const resolved = await resolve(info.source, importer);
    if (resolved) {
      const cleanId = path.normalize(resolved.id.replace(/^\0+/, '').split('?', 1)[0]);
      const dbName = state.getDatabaseNameForPath(cleanId);
      if (dbName) return dbName;
    }
  }
  return null;
}

// ============================================================================
// Plugin
// ============================================================================

export function databasePlugin(options: DatabasePluginOptions = {}): Plugin {
  const state = new PluginState({
    contextImport: options.contextImport ?? '@eagerpatch/durable-db/context',
    registryImport: options.registryImport ?? '@eagerpatch/durable-db/registry',
    databasesDir: options.databasesDir ?? 'src/databases',
    migrationsDir: options.migrationsDir ?? 'migrations',
  });

  return {
    name: 'durable-db',
    enforce: 'pre',

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
        if (normalized.startsWith(absoluteDbDir) && /\.tsx?$/.test(normalized)) {
          state.invalidateDOModule();
        }
      });
    },

    buildStart() {
      state.reset();
    },

    resolveId(id) {
      if (id === `virtual:${DURABLE_OBJECTS_ID}` || id === DURABLE_OBJECTS_ID) {
        return VIRTUAL_DO_MODULE_ID;
      }
      return null;
    },

    async load(id) {
      if (id !== VIRTUAL_DO_MODULE_ID) return null;

      await state.initialize();

      const isDev = state.config.command === 'serve';
      const code = generateDurableObjectsModule(
        Array.from(state.databases.values()),
        state.options.registryImport,
        isDev
      );

      return { code };
    },

    async transform(code, id) {
      // Skip virtual modules and node_modules
      if (id.startsWith('\0') || id.includes('node_modules')) return null;

      // Only process TypeScript files
      if (!/\.tsx?$/.test(id)) return null;

      await state.initialize();

      const cleanId = path.normalize(id.split('?', 1)[0]);

      // Skip database definition files
      if (state.getDatabaseNameForPath(cleanId)) return null;

      const parsed = parseDatabaseFile(cleanId, code);
      if (parsed.actions.length === 0) return null;

      const importedDbName = await findImportedDatabase(
        this.resolve.bind(this),
        state,
        parsed.localImports,
        cleanId
      );
      if (!importedDbName) return null;

      const database = state.databases.get(importedDbName);
      if (!database) return null;

      // Track discovered actions
      for (const action of parsed.actions) {
        state.registerAction(action, importedDbName, cleanId);
      }

      const result = transformActionFile({
        code,
        sourceFileName: cleanId,
        dbName: importedDbName,
        database,
        actionsInFile: parsed.actions,
        contextImport: state.options.contextImport,
        registryImport: state.options.registryImport,
      });

      if (result && state.config.command === 'serve') {
        state.invalidateDOModule();
      }

      return result;
    },

    buildEnd() {
      if (state.actions.size > 0) {
        debugVite('Discovered %d action(s)', state.actions.size);
      }
    },
  };
}

export default databasePlugin;
