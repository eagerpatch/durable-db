import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';
import { debugVite } from '../utils/debug';

import { discoverDatabaseFiles, readFile } from './modules/discovery';
import { parseDatabaseFile } from './modules/parser';
import { patchWranglerConfig } from './modules/wrangler';
import { generateDurableObjectsModule, transformActionFile, transformDatabaseFile } from './modules/generator';
import { loadMigrationFiles } from '../migrations/generator';
import { loadDevState, saveDevState, getDevPaths } from '../cli/state';

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

const DEV_EPOCH_ID = 'eagerpatch/durable-db/__devEpoch';
const VIRTUAL_DEV_EPOCH_MODULE_ID = '\0virtual:eagerpatch/durable-db/__devEpoch.js';

/**
 * Generate the __devEpoch virtual module. Action stubs route every DO
 * instance key through `applyDevEpoch()`:
 * - dev: suffixes keys with the current epoch (`<key>__dev_<epoch>`), so a
 *   `db reset` epoch bump rotates every database to a fresh DO instance
 * - production builds: identity function, zero overhead beyond the call
 */
function generateDevEpochModule(epoch: string | null): string {
  return [
    `export const devEpoch = ${JSON.stringify(epoch)};`,
    `export function applyDevEpoch(key) {`,
    `  return devEpoch ? \`\${key}__dev_\${devEpoch}\` : key;`,
    `}`,
  ].join('\n');
}

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
    this.invalidateVirtualModule(VIRTUAL_DO_MODULE_ID);
  }

  invalidateDevEpochModule(): void {
    this.invalidateVirtualModule(VIRTUAL_DEV_EPOCH_MODULE_ID);
  }

  private invalidateVirtualModule(virtualId: string): void {
    if (!this.devServer) return;

    for (const mod of this.devServer.moduleGraph.idToModuleMap.values()) {
      const id = mod.id ?? '';
      if (id === virtualId || id.startsWith(virtualId + '?')) {
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

      // Watch durable-db's dev cache (state.json + dev migrations) so CLI
      // commands take effect while the dev server is running:
      // - `db reset` bumps the epoch → __devEpoch reloads, stubs rotate to
      //   fresh DO instances on the next request
      // - `db push` rewrites the squashed dev migration → plugin state is
      //   re-initialized so the DO module re-embeds migrations from disk
      // (fs.watch because Vite's watcher ignores node_modules.)
      const devPaths = getDevPaths(state.projectRoot);
      fs.mkdirSync(devPaths.cacheDir, { recursive: true });

      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      const onDevStateChange = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          debugVite('Dev state changed; reloading durable-db modules');
          state.reset();
          state.invalidateDOModule();
          state.invalidateDevEpochModule();
          server.ws.send({ type: 'full-reload' });
        }, 100);
      };

      try {
        const cacheWatcher = fs.watch(devPaths.cacheDir, { recursive: true }, onDevStateChange);
        server.httpServer?.once('close', () => cacheWatcher.close());
      } catch {
        // Recursive fs.watch is unavailable on some platforms — fall back
        // to polling the state file, which still covers `db reset`.
        fs.unwatchFile(devPaths.stateFile);
        fs.watchFile(devPaths.stateFile, { interval: 500 }, onDevStateChange);
        server.httpServer?.once('close', () => fs.unwatchFile(devPaths.stateFile));
      }
    },

    buildStart() {
      state.reset();
    },

    resolveId(id) {
      if (id === `virtual:${DURABLE_OBJECTS_ID}` || id === DURABLE_OBJECTS_ID) {
        return VIRTUAL_DO_MODULE_ID;
      }
      if (id === `virtual:${DEV_EPOCH_ID}` || id === DEV_EPOCH_ID) {
        return VIRTUAL_DEV_EPOCH_MODULE_ID;
      }
      return null;
    },

    async load(id) {
      if (id === VIRTUAL_DEV_EPOCH_MODULE_ID) {
        // Read fresh on every load — the module is invalidated when the
        // state file changes, so this always reflects the current epoch.
        const isDev = state.config.command === 'serve';
        let epoch: string | null = null;
        if (isDev) {
          // Persist a newly minted epoch immediately: loadDevState mints
          // one when no state file exists, and an unsaved epoch would
          // differ on every reload, silently orphaning dev databases.
          // Only write when missing — an unconditional write would
          // retrigger the cache watcher and loop forever.
          const devState = loadDevState(state.projectRoot);
          if (!fs.existsSync(getDevPaths(state.projectRoot).stateFile)) {
            saveDevState(state.projectRoot, devState);
          }
          epoch = devState.epoch;
        }
        return { code: generateDevEpochModule(epoch) };
      }

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

      // Database definition files: rewrite same-file action() definitions
      // into RPC stubs and replace destroyDatabase (when destructured)
      const dbNameForPath = state.getDatabaseNameForPath(cleanId);
      if (dbNameForPath) {
        const database = state.databases.get(dbNameForPath);
        if (!database) return null;

        const parsed = parseDatabaseFile(cleanId, code);

        for (const action of parsed.actions) {
          state.registerAction(action, dbNameForPath, cleanId);
        }

        const result = transformDatabaseFile({
          code,
          sourceFileName: cleanId,
          database,
          actionsInFile: parsed.actions,
          contextImport: state.options.contextImport,
          registryImport: state.options.registryImport,
        });

        if (result && parsed.actions.length > 0 && state.config.command === 'serve') {
          state.invalidateDOModule();
        }

        return result;
      }

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
