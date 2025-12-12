import * as path from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { DatabaseInfo, ActionInfo } from '../db';

import {
  discoverDatabaseFiles,
  readFile,
  resolveImportPath,
  parseDatabaseFile,
  resolveInternalActionCalls,
  patchWranglerConfig,
  // generator exports (your barrel exports * from './generator')
  generateActionRegistryModule,
  transformActionFileInPlaceWithCrossDb,
} from './modules';

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

const VIRTUAL_REGISTRY_ID = 'shoplayer/databases/__actionRegistry';
const VIRTUAL_REGISTRY_MODULE_ID = VIRTUAL_DB_PREFIX + '__actionRegistry.js';

// ============================================================================
// Virtual Module Helpers
// ============================================================================

function isDurableObjectsImport(id: string): boolean {
  return id === `virtual:${VIRTUAL_DO_ID}` || id === VIRTUAL_DO_ID;
}

function isRegistryImport(id: string): boolean {
  return id === `virtual:${VIRTUAL_REGISTRY_ID}` || id === VIRTUAL_REGISTRY_ID;
}

// ============================================================================
// Plugin State
// ============================================================================

class PluginState {
  readonly databases = new Map<string, DatabaseInfo>();
  readonly actions = new Map<string, ActionInfo>();

  private readonly databaseFileToName = new Map<string, string>();
  private initialized = false;

  projectRoot = '';
  config!: ResolvedConfig;
  devServer: ViteDevServer | null = null;

  constructor(readonly options: Required<DatabasePluginOptions>) {}

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

  registerAction(action: ActionInfo, dbName: string, sourceFile: string): void {
    action.databaseName = dbName;
    action.sourceFile = path.relative(this.projectRoot, sourceFile);
    this.actions.set(`${dbName}:${action.exportName}`, action);
  }

  reset(): void {
    this.databases.clear();
    this.actions.clear();
    this.databaseFileToName.clear();
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

      // Invalidate DO module whenever anything under databasesDir changes (keeps dev snappy)
      const absoluteDbDir = path.join(state.projectRoot, state.options.databasesDir);
      server.watcher.on('change', (file) => {
        const normalized = path.normalize(file);
        if (normalized.startsWith(absoluteDbDir) && (normalized.endsWith('.ts') || normalized.endsWith('.tsx'))) {
          state.invalidateDOModule();
        }
      });
    },

    buildStart() {
      state.reset();
    },

    resolveId(id) {
      if (isDurableObjectsImport(id)) return VIRTUAL_DO_MODULE_ID;
      if (isRegistryImport(id)) return VIRTUAL_REGISTRY_MODULE_ID;
      return null;
    },

    async load(id) {
      await state.initialize();

      if (id === VIRTUAL_REGISTRY_MODULE_ID) {
        return { code: generateActionRegistryModule() };
      }

      if (id === VIRTUAL_DO_MODULE_ID) {
        return { code: generateDurableObjectsDispatcherModule(Array.from(state.databases.values())) };
      }

      return null;
    },

    async transform(code, id) {
      // Skip virtual modules and node_modules
      if (id.startsWith('\0') || id.includes('node_modules')) return null;

      // Only TS/TSX
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) return null;

      await state.initialize();

      const cleanId = id.split('?', 1)[0];
      const normalizedId = path.normalize(cleanId);

      // Skip database definition files
      if (state.getDatabaseNameForPath(normalizedId)) return null;

      const parsed = parseDatabaseFile(normalizedId, code);

      // Find which database this file imports `action` from
      const importedDbName = await findImportedDatabase.call(this, state, parsed.localImports, normalizedId);
      if (!importedDbName) return null;

      if (parsed.actions.length === 0) return null;

      const database = state.databases.get(importedDbName);
      if (!database) return null;

      // Register actions (so we can build a global action graph)
      for (const action of parsed.actions) {
        state.registerAction(action, importedDbName, normalizedId);
      }

      // Populate internal/cross-db call metadata across all discovered actions
      const allActions = Array.from(state.actions.values());
      for (const [dbName] of state.databases) {
        const dbActions = allActions.filter((a) => a.databaseName === dbName);
        resolveInternalActionCalls(dbActions, allActions);
      }

      // In-place rewrite (imports preserved; handler stays in original scope)
      const out = transformActionFileInPlaceWithCrossDb({
        code,
        sourceFileName: normalizedId,
        dbName: importedDbName,
        database,
        actionsInFile: parsed.actions,
        allDatabases: Array.from(state.databases.values()),
        allActions,
        contextImport: state.options.contextImport,
        shopIdPath: state.options.shopIdPath,
        registryImport: `virtual:${VIRTUAL_REGISTRY_ID}`,
      });

      // Dev: DO module should refresh when actions are discovered/changed
      if (state.config.command === 'serve') {
        state.invalidateDOModule();
      }

      return out;
    },

    buildEnd() {
      if (state.actions.size > 0) {
        console.log(`[shoplayer-database] Discovered ${state.actions.size} action(s) (lazy via imports only)`);
      }
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// DO dispatcher module generator (no waiting; build-order safe)
// ============================================================================

function jsStringEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
}

function generateMigrationsLiteral(db: DatabaseInfo): string {
  if (!db.migrations || db.migrations.size === 0) return '{}';

  const entries = Array.from(db.migrations.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, mig]) => {
    // mig is expected as string[][] chunks
    const chunks = JSON.stringify(mig);
    return `${JSON.stringify(name)}: { chunks: ${chunks} }`;
  });

  return `{ ${entries.join(', ')} }`;
}

function generateBindingNamesObject(databases: DatabaseInfo[]): string {
  const pairs = databases
  .map((db) => `${JSON.stringify(db.name)}: ${JSON.stringify(db.bindingName)}`)
  .join(', ');
  return `{ ${pairs} }`;
}

/**
 * A build-order safe DO module:
 * - does NOT need to know actions at build time
 * - dispatches via registry in rpc(method, args, rpcContext)
 */
function generateDurableObjectsDispatcherModule(databases: DatabaseInfo[]): string {
  const bindingNames = generateBindingNamesObject(databases);

  const classes = databases
  .map((db) => {
    const migrations = generateMigrationsLiteral(db);
    const className = db.className;
    const dbName = db.name;

    return `
export class ${className} extends SqliteDurableObject {
  migrations = ${migrations};

  async rpc(method, args, rpcContext) {
    await this.ensureMigrations();

    const entry = getAction(${JSON.stringify(dbName)}, method);
    if (!entry) {
      throw new Error(\`[shoplayer-database] Unknown action "\${method}" for db "${jsStringEscape(dbName)}" (was it imported?)\`);
    }

    const validated = entry.validator(args);
    if (validated instanceof type.errors) {
      throw new Error(\`[shoplayer-database] Invalid args for "\${method}": \${validated.summary}\`);
    }

    const ctx = {
      env: this.env,
      dbName: ${JSON.stringify(dbName)},
      dbBindingNames: ${bindingNames},
      instanceKey: (rpcContext && rpcContext.instanceKey) ? rpcContext.instanceKey : 'global',
    };

    return entry.handler(this.db, validated, ctx);
  }
}
`.trim();
  })
  .join('\n\n');

  return `
import { SqliteDurableObject } from '@shoplayer/database/db';
import { type } from 'arktype';
import { getAction } from 'virtual:${VIRTUAL_REGISTRY_ID}';

${classes}
`.trim();
}

export default shoplayerDatabasePlugin;
