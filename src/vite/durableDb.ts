import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Alias, Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';
import { debugVite } from '../utils/debug';

import { discoverDatabaseFiles, readFile } from './modules/discovery';
import { parseDatabaseFile } from './modules/parser';
import { patchWranglerConfig, checkWranglerConfig } from './modules/wrangler';
import { generateDurableObjectsModule, transformActionFile, transformDatabaseFile } from './modules/generator';
import { loadMigrationFiles } from '../migrations/generator';
import { loadDevState, saveDevState, getDevPaths } from '../cli/state';

// ============================================================================
// Types
// ============================================================================

export interface DurableDbOptions {
  /** Import path for the context module. Default: 'durable-db/context' */
  contextImport?: string;
  /** Import path for the registry module. Default: 'durable-db/registry' */
  registryImport?: string;
  /** Directory containing database definitions. Default: 'src/databases' */
  databasesDir?: string;
  /** Directory for production migrations, relative to project root. Default: 'migrations' */
  migrationsDir?: string;
  /**
   * Write missing Durable Object bindings and sqlite migration entries to
   * wrangler.jsonc/json automatically. When false (the default), the plugin
   * only verifies the config and logs the exact JSON to add when something
   * is missing — your config file is never modified.
   */
  patchWranglerConfig?: boolean;
}

interface ResolvedOptions {
  contextImport: string;
  registryImport: string;
  databasesDir: string;
  migrationsDir: string;
  patchWranglerConfig: boolean;
}

// ============================================================================
// Virtual Module IDs
// ============================================================================

const DURABLE_OBJECTS_ID = 'durable-db/__durableObjects';
const VIRTUAL_DO_MODULE_ID = '\0virtual:durable-db/__durableObjects.js';

const DEV_EPOCH_ID = 'durable-db/__devEpoch';
const VIRTUAL_DEV_EPOCH_MODULE_ID = '\0virtual:durable-db/__devEpoch.js';

/** Old org-prefixed spelling, still resolved for compatibility. */
const LEGACY_ID_PREFIX = 'eagerpatch/';

/** Match a virtual id in all accepted spellings (`virtual:` optional, legacy prefix). */
function matchesVirtualId(id: string, canonicalId: string): boolean {
  return (
    id === canonicalId ||
    id === `virtual:${canonicalId}` ||
    id === `${LEGACY_ID_PREFIX}${canonicalId}` ||
    id === `virtual:${LEGACY_ID_PREFIX}${canonicalId}`
  );
}

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

  /**
   * Vite's resolved `resolve.alias` entries (the source of truth for aliases,
   * including tsconfig `paths` wired in by frameworks like rwsdk). Passed to the
   * parser so an `action` factory imported through an alias is recognized.
   */
  get aliases(): readonly Alias[] {
    return this.config?.resolve?.alias ?? [];
  }

  private selfDevStateWriteUntil = 0;

  constructor(readonly options: ResolvedOptions) {}

  /**
   * Mark an imminent write to the dev cache made by the plugin itself
   * (persisting a freshly minted epoch on first run). The cache watcher
   * ignores events inside this window — without it, the plugin's own
   * bootstrap write would trigger a full reload on the very first dev-server
   * run, before any client (or the Cloudflare worker's hot channel
   * WebSocket) is connected.
   */
  markSelfDevStateWrite(): void {
    this.selfDevStateWriteUntil = Date.now() + 1500;
  }

  isWithinSelfDevStateWriteWindow(): boolean {
    return Date.now() <= this.selfDevStateWriteUntil;
  }

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
      const parsed = parseDatabaseFile(file.absolutePath, code, { aliases: this.aliases });

      if (parsed.database) {
        parsed.database.migrationsDir = path.resolve(this.projectRoot, this.options.migrationsDir, parsed.database.name);
        this.databases.set(parsed.database.name, parsed.database);
        this.registerDatabaseFile(file.absolutePath, parsed.database.name);
        await this.loadMigrations(parsed.database);
      }
    }

    if (this.databases.size > 0) {
      debugVite('Found %d database(s)', this.databases.size);
      const databases = Array.from(this.databases.values());
      if (this.options.patchWranglerConfig) {
        patchWranglerConfig(this.projectRoot, databases);
      } else {
        const check = checkWranglerConfig(this.projectRoot, databases);
        // In dev a missing binding fails the first request, so a warning is
        // enough. In a production build it's invisible — the build succeeds
        // and the deploy ships a worker with no DO bindings — so fail the
        // build instead. wrangler.toml can't be parsed, so its check result
        // is inconclusive and only warns.
        if (!check.ok && !check.tomlOnly && this.config.command === 'build') {
          throw new Error(
            `[durable-db] wrangler config is missing Durable Object bindings/migrations for ` +
            `discovered database(s) — deploying this build would ship a worker without them. ` +
            `Add the JSON from the warning above to ${check.configPath ? path.basename(check.configPath) : 'wrangler.jsonc'}, ` +
            `or opt in to automatic patching with durableDb({ patchWranglerConfig: true }).`
          );
        }
      }
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

  /**
   * Invalidate a virtual module in every module graph.
   *
   * On Vite 6+ each environment (client, ssr, and e.g. the Cloudflare
   * plugin's `worker` environment) has its own module graph — the legacy
   * `server.moduleGraph` only proxies client/ssr, so invalidating there
   * never reaches the worker. On Vite 5 only the legacy graph exists.
   */
  private invalidateVirtualModule(virtualId: string): void {
    if (!this.devServer) return;

    const environments = (this.devServer as { environments?: Record<string, { moduleGraph: any }> }).environments;
    const graphs = environments
      ? Object.values(environments).map((env) => env.moduleGraph)
      : [this.devServer.moduleGraph];

    for (const graph of graphs) {
      for (const mod of graph.idToModuleMap.values()) {
        const id = mod.id ?? '';
        if (id === virtualId || id.startsWith(virtualId + '?')) {
          graph.invalidateModule(mod);
        }
      }
    }
  }

  /**
   * Trigger a reload in every environment: the browser via the legacy ws
   * channel, and module-runner environments (like the Cloudflare worker)
   * via their own hot channels — the legacy ws broadcast doesn't reach them.
   */
  triggerFullReload(): void {
    if (!this.devServer) return;

    const environments = (this.devServer as { environments?: Record<string, { hot?: { send: (payload: unknown) => void } }> }).environments;
    if (environments) {
      // The client environment's hot channel IS the legacy ws channel, so
      // this covers the browser and the worker without double-sending.
      for (const [name, env] of Object.entries(environments)) {
        // A channel whose transport isn't connected yet throws on send
        // (@cloudflare/vite-plugin asserts "The WebSocket is undefined"
        // before its module-runner WebSocket exists). Nothing is running
        // there yet, so there's nothing to reload — skip it. The modules
        // were already invalidated, so the environment loads fresh code
        // once it does connect.
        try {
          env.hot?.send({ type: 'full-reload' });
        } catch (error) {
          debugVite('Skipped full-reload for environment %s (hot channel not ready): %O', name, error);
        }
      }
    } else {
      this.devServer.ws.send({ type: 'full-reload' });
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

export function durableDb(options: DurableDbOptions = {}): Plugin {
  const state = new PluginState({
    contextImport: options.contextImport ?? 'durable-db/context',
    registryImport: options.registryImport ?? 'durable-db/registry',
    databasesDir: options.databasesDir ?? 'src/databases',
    migrationsDir: options.migrationsDir ?? 'migrations',
    patchWranglerConfig: options.patchWranglerConfig ?? false,
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
        if (state.isWithinSelfDevStateWriteWindow()) {
          debugVite('Ignoring dev cache event caused by the plugin itself');
          return;
        }
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          debugVite('Dev state changed; reloading durable-db modules');
          state.reset();
          state.invalidateDOModule();
          state.invalidateDevEpochModule();
          state.triggerFullReload();
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
      if (matchesVirtualId(id, DURABLE_OBJECTS_ID)) {
        return VIRTUAL_DO_MODULE_ID;
      }
      if (matchesVirtualId(id, DEV_EPOCH_ID)) {
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
            state.markSelfDevStateWrite();
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

        const parsed = parseDatabaseFile(cleanId, code, { aliases: state.aliases });

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

      const parsed = parseDatabaseFile(cleanId, code, { aliases: state.aliases });
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

/** @deprecated Renamed to {@link durableDb}. */
export const databasePlugin = durableDb;

/** @deprecated Renamed to {@link DurableDbOptions}. */
export type DatabasePluginOptions = DurableDbOptions;

export default durableDb;
