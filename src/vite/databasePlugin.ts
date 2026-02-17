import * as path from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';

import {
  discoverDatabaseFiles,
  readFile,
  resolveImportPath,
  parseDatabaseFile,
  patchWranglerConfig,
  generateDurableObjectsModule,
  transformActionFile,
} from './modules';

import { loadMigrationFiles, generateMigration, buildAndLoadSchema } from '../migrations';

// ============================================================================
// Types
// ============================================================================

export interface DatabasePluginOptions {
  /** Import path for the context module. Default: '@shoplayer/database/context' */
  contextImport?: string;
  /** Import path for the registry module. Default: '@shoplayer/database/registry' */
  registryImport?: string;
  /** Directory containing database definitions. Default: 'src/databases' */
  databasesDir?: string;
  /** Directory for production migrations, relative to project root. Default: 'migrations' */
  migrationsDir?: string;
  /** Auto-generate migrations. Default: 'development' */
  autoMigrations?: boolean | 'development';
}

interface ResolvedOptions {
  contextImport: string;
  registryImport: string;
  databasesDir: string;
  migrationsDir: string;
  autoMigrations: boolean | 'development';
}

// ============================================================================
// Virtual Module IDs
// ============================================================================

const DURABLE_OBJECTS_ID = 'shoplayer/databases/__durableObjects';
const VIRTUAL_DO_MODULE_ID = '\0virtual:shoplayer/databases/__durableObjects.js';

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
      console.log(`[shoplayer-database] Found ${this.databases.size} database(s)`);
      patchWranglerConfig(this.projectRoot, Array.from(this.databases.values()));
    }

    this.initialized = true;
  }

  private async loadMigrations(db: DatabaseInfo): Promise<void> {
    const migrationsDir = db.migrationsDir;
    const isDev = this.config.command === 'serve';
    const shouldAutoMigrate =
      this.options.autoMigrations === true ||
      (this.options.autoMigrations === 'development' && isDev);

    // In dev mode, use the new push system for dev migrations
    if (isDev && shouldAutoMigrate && db.schemaImport && db.schemaTableNames.length > 0) {
      try {
        // Dynamic import to avoid circular dependencies
        const { pushOne } = await import('../cli/push');
        const result = await pushOne(
          { projectRoot: this.projectRoot, databasesDir: this.options.databasesDir, verbose: false },
          db.name
        );
        if (result?.hasChanges) {
          console.log(
            `[shoplayer-database] Dev migration for ${db.name}: ${result.migrationName} ` +
            `(${result.statements.length} statements)`
          );
        }
      } catch (error) {
        // Fallback to old behavior if push fails
        console.warn(`[shoplayer-database] Could not push migrations for ${db.name}: ${error}`);
        await this.generateMigrationFromSchema(db, migrationsDir, 'Fallback migration generation');
      }
    } else if (shouldAutoMigrate && db.schemaImport && db.schemaTableNames.length > 0) {
      // In build mode, use generateMigration (writes to prod migrations)
      await this.generateMigrationFromSchema(db, migrationsDir, 'Auto-generate migrations');
    }

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
          console.log(`[shoplayer-database] Loaded ${devMigrations.size} dev migration(s) for ${db.name}`);
        }
      } catch (error) {
        // Dev migrations not available, that's fine
      }
    }

    if (db.migrations.size > 0) {
      console.log(`[shoplayer-database] Total ${db.migrations.size} migration(s) for ${db.name}`);
    }
  }

  private async generateMigrationFromSchema(
    db: DatabaseInfo,
    migrationsDir: string,
    label: string
  ): Promise<void> {
    try {
      const schemaPath = db.schemaImport ? resolveImportPath(db.filePath, db.schemaImport) : null;
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
      console.warn(`[shoplayer-database] ${label} failed for ${db.name}: ${error}`);
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

export function shoplayerDatabasePlugin(options: DatabasePluginOptions = {}): Plugin {
  const state = new PluginState({
    contextImport: options.contextImport ?? '@shoplayer/database/context',
    registryImport: options.registryImport ?? '@shoplayer/database/registry',
    databasesDir: options.databasesDir ?? 'src/databases',
    migrationsDir: options.migrationsDir ?? 'migrations',
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
        console.log(`[shoplayer-database] Discovered ${state.actions.size} action(s)`);
      }
    },
  };
}

export default shoplayerDatabasePlugin;
