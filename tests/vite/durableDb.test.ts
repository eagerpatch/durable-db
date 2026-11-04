import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { durableDb, databasePlugin, syncWranglerConfig } from '../../src/vite/durableDb';
import { syncWranglerConfig as moduleSyncWranglerConfig } from '../../src/vite/modules/syncWrangler';
import type { Plugin, ResolvedConfig } from 'vite';

// ============================================================================
// Plugin Configuration
// ============================================================================

describe('databasePlugin', () => {
  let tempDir: string;
  let plugin: Plugin;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-plugin-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    plugin = durableDb();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('metadata', () => {
    it('has correct name', () => {
      expect(plugin.name).toBe('durable-db');
    });

    it('enforces pre', () => {
      expect(plugin.enforce).toBe('pre');
    });

    it('applies to both dev and build', () => {
      expect(plugin.apply).toBeUndefined();
    });
  });

  describe('options', () => {
    it('accepts all options', () => {
      const customPlugin = durableDb({
        contextImport: 'my-app/context',
        registryImport: 'my-app/registry',
        databasesDir: 'lib/db',
      });
      expect(customPlugin.name).toBe('durable-db');
    });
  });

  describe('lifecycle hooks', () => {
    it('has configResolved', () => {
      expect(typeof plugin.configResolved).toBe('function');
    });

    it('has configureServer', () => {
      expect(typeof plugin.configureServer).toBe('function');
    });

    it('has buildStart', () => {
      expect(typeof plugin.buildStart).toBe('function');
    });

    it('has buildEnd', () => {
      expect(typeof plugin.buildEnd).toBe('function');
    });

    it('has resolveId', () => {
      expect(typeof plugin.resolveId).toBe('function');
    });

    it('has load', () => {
      expect(typeof plugin.load).toBe('function');
    });

    it('has transform', () => {
      expect(typeof plugin.transform).toBe('function');
    });
  });
});

// ============================================================================
// resolveId
// ============================================================================

describe('resolveId', () => {
  let plugin: Plugin;

  beforeEach(() => {
    plugin = durableDb();
  });

  it('resolves virtual:durable-db/__durableObjects', async () => {
    const resolveId = plugin.resolveId as Function;
    const result = await resolveId('virtual:durable-db/__durableObjects');
    expect(result).toBe('\0virtual:durable-db/__durableObjects.js');
  });

  it('resolves durable-db/__durableObjects without prefix', async () => {
    const resolveId = plugin.resolveId as Function;
    const result = await resolveId('durable-db/__durableObjects');
    expect(result).toBe('\0virtual:durable-db/__durableObjects.js');
  });

  it('resolves virtual:durable-db/__devEpoch', async () => {
    const resolveId = plugin.resolveId as Function;
    const result = await resolveId('virtual:durable-db/__devEpoch');
    expect(result).toBe('\0virtual:durable-db/__devEpoch.js');
  });

  it('still resolves the legacy eagerpatch-prefixed ids', async () => {
    const resolveId = plugin.resolveId as Function;
    expect(await resolveId('virtual:eagerpatch/durable-db/__durableObjects'))
      .toBe('\0virtual:durable-db/__durableObjects.js');
    expect(await resolveId('virtual:eagerpatch/durable-db/__devEpoch'))
      .toBe('\0virtual:durable-db/__devEpoch.js');
  });

  it('exposes the deprecated databasePlugin alias', () => {
    expect(databasePlugin).toBe(durableDb);
  });

  it('returns null for registry (now a real module)', async () => {
    const resolveId = plugin.resolveId as Function;
    expect(await resolveId('durable-db/registry')).toBeNull();
  });

  it('returns null for non-virtual imports', async () => {
    const resolveId = plugin.resolveId as Function;
    expect(await resolveId('lodash')).toBeNull();
    expect(await resolveId('react')).toBeNull();
    expect(await resolveId('./utils')).toBeNull();
  });
});

// ============================================================================
// wrangler config patching (opt-in)
// ============================================================================

describe('wrangler config patching', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-wrangler-optin-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'databases', 'main.ts'),
      `
import { defineDatabase } from 'durable-db';
import { users } from './schema';
export const { action } = defineDatabase({ schema: { users } });
`
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function initializePlugin(
    options?: Parameters<typeof durableDb>[0],
    command: 'serve' | 'build' = 'build'
  ) {
    const plugin = durableDb(options);
    const configResolved = plugin.configResolved as Function;
    await configResolved({ root: tempDir, command } as ResolvedConfig);
    const load = plugin.load as Function;
    await load('\0virtual:durable-db/__durableObjects.js');
  }

  it('does not modify wrangler config in dev, but warns with the missing JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');

    await initializePlugin(undefined, 'serve');

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('MAIN_DATABASE_DO');
    warnSpy.mockRestore();
  });

  it('fails a production build when bindings are missing and patching is off', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');

    await expect(initializePlugin(undefined, 'build')).rejects.toThrow(
      /missing Durable Object bindings/
    );

    // Config still untouched, and the JSON-to-add warning was printed first
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not fail the build when the config already has the bindings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'my-worker',
      durable_objects: {
        bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] }],
    }));

    await initializePlugin(undefined, 'build');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('only warns on build when the project uses wrangler.toml (unverifiable)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(tempDir, 'wrangler.toml'), 'name = "my-worker"\n');

    await initializePlugin(undefined, 'build');

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('wrangler.toml');
    warnSpy.mockRestore();
  });

  it('writes the bindings when patchWranglerConfig is true', async () => {
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');

    await initializePlugin({ patchWranglerConfig: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.durable_objects.bindings).toEqual([
      { name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' },
    ]);
    expect(config.migrations[0].new_sqlite_classes).toEqual(['MainDatabaseDO']);
  });

  // @cloudflare/vite-plugin reads wrangler.jsonc in its `config` hook and
  // builds dist/worker/wrangler.json from that copy (and restarts a dev
  // server when the file changes later): the patch must land before it.
  it('patches in the config hook, before any other plugin resolves the config', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker", "migrations": [{"tag": "v1", "new_sqlite_classes": ["OtherDO"]}]}');

    const plugin = durableDb({ patchWranglerConfig: true });
    expect(typeof plugin.config).toBe('function');
    await (plugin.config as Function)({ root: tempDir }, { command: 'build', mode: 'production' });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.durable_objects.bindings).toEqual([
      { name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' },
    ]);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['OtherDO'] },
      { tag: 'v2', new_sqlite_classes: ['MainDatabaseDO'] },
    ]);
    // visible, not only under DEBUG
    expect(logSpy).toHaveBeenCalledWith(
      'durable-db updated wrangler.jsonc (Durable Objects: +MAIN_DATABASE_DO → MainDatabaseDO; migration v2: MainDatabaseDO)'
    );
    logSpy.mockRestore();
  });

  it('resolves a relative root against the working directory', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');
    const cwd = process.cwd();
    process.chdir(path.dirname(tempDir));
    try {
      await (durableDb({ patchWranglerConfig: true }).config as Function)(
        { root: path.basename(tempDir) }, { command: 'serve', mode: 'development' }
      );
    } finally {
      process.chdir(cwd);
    }
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).durable_objects.bindings).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('leaves the config alone in the config hook unless patching is on', async () => {
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');

    await (durableDb().config as Function)({ root: tempDir }, { command: 'build', mode: 'production' });

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
  });

  it('exports syncWranglerConfig from durable-db/vite for CLIs', () => {
    expect(syncWranglerConfig).toBe(moduleSyncWranglerConfig);
  });
});

// ============================================================================
// __devEpoch virtual module
// ============================================================================

describe('__devEpoch virtual module', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-epoch-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadDevEpochModule(command: 'serve' | 'build'): Promise<string> {
    const plugin = durableDb();
    const configResolved = plugin.configResolved as Function;
    await configResolved({ root: tempDir, command } as ResolvedConfig);

    const load = plugin.load as Function;
    const result = await load('\0virtual:durable-db/__devEpoch.js');
    return result.code;
  }

  it('embeds the current epoch in dev mode', async () => {
    const { loadDevState, saveDevState } = await import('../../src/cli/state');
    const state = loadDevState(tempDir);
    state.epoch = 'testepoch';
    saveDevState(tempDir, state);

    const code = await loadDevEpochModule('serve');
    expect(code).toContain('export const devEpoch = "testepoch"');
    expect(code).toContain('export function applyDevEpoch');
  });

  it('persists a newly minted epoch so it stays stable across reloads', async () => {
    const codeA = await loadDevEpochModule('serve');
    const codeB = await loadDevEpochModule('serve');
    expect(codeA).toBe(codeB);

    const { loadDevState } = await import('../../src/cli/state');
    const epoch = loadDevState(tempDir).epoch;
    expect(codeA).toContain(`export const devEpoch = "${epoch}"`);
  });

  it('emits a null epoch (identity applyDevEpoch) for production builds', async () => {
    const code = await loadDevEpochModule('build');
    expect(code).toContain('export const devEpoch = null');
    const mod = await importModule(code);
    expect(mod.applyDevEpoch('tenant', 'main')).toBe('tenant');
  });

  async function importModule(code: string) {
    const file = path.join(tempDir, `epoch-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file, code);
    return import(pathToFileURL(file).href);
  }

  it('applies a database\'s own epoch after `db reset --database`, the project epoch to the rest', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'databases', 'main.ts'),
      `import { defineDatabase } from 'durable-db';\nexport const { action } = defineDatabase({});\n`
    );
    const { loadDevState, saveDevState } = await import('../../src/cli/state');
    const state = loadDevState(tempDir);
    state.epoch = 'project';
    saveDevState(tempDir, state);

    const { reset } = await import('../../src/cli/reset');
    const { newEpoch } = await reset({ projectRoot: tempDir, databasesDir: 'src/databases' }, { database: 'main' });

    const mod = await importModule(await loadDevEpochModule('serve'));
    expect(mod.devEpoch).toBe('project');
    expect(mod.applyDevEpoch('tenant', 'main')).toBe(`tenant__dev_${newEpoch}`);
    expect(mod.applyDevEpoch('tenant', 'reviews')).toBe('tenant__dev_project');
    // stubs generated before per-database epochs pass no name
    expect(mod.applyDevEpoch('tenant')).toBe('tenant__dev_project');
  });

  it('reflects an epoch bump (db reset) on the next load', async () => {
    const plugin = durableDb();
    const configResolved = plugin.configResolved as Function;
    await configResolved({ root: tempDir, command: 'serve' } as ResolvedConfig);
    const load = plugin.load as Function;

    const before = (await load('\0virtual:durable-db/__devEpoch.js')).code;

    const { reset } = await import('../../src/cli/reset');
    const { newEpoch } = await reset({ projectRoot: tempDir, databasesDir: 'src/databases' });

    const after = (await load('\0virtual:durable-db/__devEpoch.js')).code;
    expect(after).not.toBe(before);
    expect(after).toContain(`export const devEpoch = "${newEpoch}"`);
  });
});

// ============================================================================
// dev cache watcher
// ============================================================================

describe('dev cache watcher', () => {
  let tempDir: string;
  let closeServer: (() => void) | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-watcher-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    closeServer?.();
    closeServer = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockServer() {
    const closeHandlers: Array<() => void> = [];
    const makeGraph = () => ({ idToModuleMap: new Map(), invalidateModule: vi.fn() });

    const clientSend = vi.fn();
    // Mimics @cloudflare/vite-plugin's hot channel before its module-runner
    // WebSocket is connected — send() asserts synchronously.
    const workerSend = vi.fn(() => {
      throw new Error('The WebSocket is undefined');
    });

    const server = {
      watcher: { on: vi.fn() },
      httpServer: {
        once: (_event: string, cb: () => void) => {
          closeHandlers.push(cb);
        },
      },
      ws: { send: vi.fn() },
      moduleGraph: makeGraph(),
      environments: {
        client: { moduleGraph: makeGraph(), hot: { send: clientSend } },
        worker: { moduleGraph: makeGraph(), hot: { send: workerSend } },
      },
    };

    closeServer = () => closeHandlers.forEach((cb) => cb());
    return { server, clientSend, workerSend };
  }

  it('does not trigger a reload for the plugin\'s own bootstrap state write', async () => {
    const plugin = durableDb();
    await (plugin.configResolved as Function)({ root: tempDir, command: 'serve' } as ResolvedConfig);
    const { server, clientSend, workerSend } = createMockServer();
    (plugin.configureServer as Function)(server);

    // First load of __devEpoch on a fresh project mints and persists the
    // epoch — that write must not bounce back through the cache watcher as
    // a full reload (on a real first run no hot channel is connected yet).
    const load = plugin.load as Function;
    await load('\0virtual:durable-db/__devEpoch.js');

    // Give the fs watcher and the reload debounce ample time to fire
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(clientSend).not.toHaveBeenCalled();
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('records the running dev server and removes the lock when it closes', async () => {
    const { readDevServerLock, runningDevServer } = await import('../../src/cli/state');
    const plugin = durableDb();
    await (plugin.configResolved as Function)({ root: tempDir, command: 'serve' } as ResolvedConfig);
    const { server, clientSend } = createMockServer();
    (plugin.configureServer as Function)(server);

    expect(runningDevServer(tempDir)?.pid).toBe(process.pid);

    // writing the lock is not a dev-state change
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(clientSend).not.toHaveBeenCalled();

    closeServer?.();
    closeServer = null;
    expect(readDevServerLock(tempDir)).toBeNull();
  });

  it('a restarted server keeps its lock when the old one closes', async () => {
    const { readDevServerLock } = await import('../../src/cli/state');
    const plugin = durableDb();
    await (plugin.configResolved as Function)({ root: tempDir, command: 'serve' } as ResolvedConfig);

    const first = createMockServer();
    const closeFirst = closeServer!;
    try {
      (plugin.configureServer as Function)(first.server);
      const second = createMockServer();
      (plugin.configureServer as Function)(second.server);
      const secondToken = readDevServerLock(tempDir)?.token;
      expect(secondToken).toBeDefined();

      closeFirst();
      expect(readDevServerLock(tempDir)?.token).toBe(secondToken);
    } finally {
      closeFirst();
    }
  });

  it('survives a hot channel that throws on send and still reloads the rest', async () => {
    const plugin = durableDb();
    await (plugin.configResolved as Function)({ root: tempDir, command: 'serve' } as ResolvedConfig);
    const { server, clientSend, workerSend } = createMockServer();
    (plugin.configureServer as Function)(server);

    // External change, like the CLI writing state.json (`db reset`)
    const { loadDevState, saveDevState } = await import('../../src/cli/state');
    const devState = loadDevState(tempDir);
    let bumps = 0;

    // fs.watch's FSEvents stream (macOS) starts on another thread after
    // fs.watch() returns, so a write right after configureServer can land
    // before it listens (a real `db reset` comes long after the server
    // started). Write again on each poll until a reload is seen; the poll
    // interval outlasts the plugin's 100 ms reload debounce.
    await vi.waitFor(
      () => {
        if (clientSend.mock.calls.length === 0) {
          devState.epoch = `bumped-${++bumps}`;
          saveDevState(tempDir, devState);
        }
        expect(workerSend).toHaveBeenCalledWith({ type: 'full-reload' });
        expect(clientSend).toHaveBeenCalledWith({ type: 'full-reload' });
      },
      { timeout: 5000, interval: 500 }
    );
  });
});

// ============================================================================
// transform
// ============================================================================

describe('transform', () => {
  let tempDir: string;
  let plugin: Plugin;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-transform-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });

    plugin = durableDb();

    const configResolved = plugin.configResolved as Function;
    // serve mode: these tests exercise transform, not the build-time
    // wrangler config check (which fails hard on missing bindings)
    await configResolved({
      root: tempDir,
      command: 'serve',
    } as ResolvedConfig);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null for node_modules', async () => {
    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async () => null },
      'export const x = 1;',
      '/project/node_modules/lodash/index.ts'
    );
    expect(result).toBeNull();
  });

  it('returns null for virtual modules', async () => {
    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async () => null },
      'export const x = 1;',
      '\0virtual:something'
    );
    expect(result).toBeNull();
  });

  it('returns null for non-TypeScript', async () => {
    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async () => null },
      'export const x = 1;',
      path.join(tempDir, 'src', 'file.js')
    );
    expect(result).toBeNull();
  });

  it('returns null for files without actions', async () => {
    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async () => null },
      `import { something } from 'somewhere';\nexport const x = something();`,
      path.join(tempDir, 'src', 'other.ts')
    );
    expect(result).toBeNull();
  });

  it('passes a file with a syntax error and no durable-db usage through untouched', async () => {
    // A page being edited: the compiler that owns it reports the error, not
    // durable-db's Babel parse ([plugin:durable-db] for every syntax error).
    const transform = plugin.transform as Function;
    const page = `import { Suspense } from 'react';\nexport default function Page() {\n  return ((\n    <form action={save}><Suspense /></form>\n  );\n}\n`;
    const result = await transform.call(
      { resolve: async () => null },
      page,
      path.join(tempDir, 'src', 'pages', 'products', 'index.tsx')
    );
    expect(result).toBeNull();
  });

  it('still parses a file that imports an action factory', async () => {
    const transform = plugin.transform as Function;
    await expect(transform.call(
      { resolve: async () => null },
      `import { action } from '../databases/main';\nexport const x = (;`,
      path.join(tempDir, 'src', 'actions.ts')
    )).rejects.toThrow();
  });

  // The pre-check must admit every import the parser takes an `action`
  // factory from — a syntax error after it proves the parse is reached.
  it.each([
    ['a default binding before the braces', `import main, { action } from '../databases/main';`],
    ['a renamed factory, no spaces', `import main,{action as act} from '../databases/main';`],
    ['a multi-line clause with a type specifier', `import {\n  type Main,\n  action,\n} from '../databases/main';`],
    ['a comment before the braces', `import /* factory */ { action } from '../databases/main';`],
    ['a string specifier', `import { "action" as act } from '../databases/main';`],
  ])('still parses an action file importing the factory with %s', async (_, importLine) => {
    const transform = plugin.transform as Function;
    await expect(transform.call(
      { resolve: async () => null },
      `${importLine}\nexport const x = (;`,
      path.join(tempDir, 'src', 'actions.ts')
    )).rejects.toThrow();
  });

  it('transforms an action file that also imports the database module\'s default export', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'databases', 'main.ts'),
      `import { defineDatabase } from 'durable-db';\nimport { users } from './schema';\n` +
      `export const { action } = defineDatabase({ schema: { users } });\nexport default 1;\n`
    );
    const file = path.join(tempDir, 'src', 'actions', 'users.ts');
    const code =
      `import main, { action } from '../databases/main';\n` +
      `export const getUser = action({ args: {}, handler: async () => main });\n`;

    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async (source: string, importer: string) => ({ id: path.resolve(path.dirname(importer), source) + '.ts' }) },
      code,
      file
    );

    expect(result).not.toBeNull();
    expect(result.code).toContain('export async function getUser');
    expect(result.code).toContain('registerAction("main", "getUser"');
    expect(result.code).not.toContain('getUser = action(');
  });

  it('handles query parameters in id', async () => {
    const transform = plugin.transform as Function;
    const result = await transform.call(
      { resolve: async () => null },
      'export const x = 1;',
      path.join(tempDir, 'src', 'file.ts') + '?v=123'
    );
    expect(result).toBeNull();
  });

  it('transforms action() definitions inside the database file itself', async () => {
    const dbFile = path.join(tempDir, 'src', 'databases', 'main.ts');
    const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});

export const createUser = action({
  args: { name: 'string' },
  handler: async (db, args) => db.insertInto('users').values(args).execute(),
});
`;
    fs.writeFileSync(dbFile, code);

    const transform = plugin.transform as Function;
    const result = await transform.call({ resolve: async () => null }, code, dbFile);

    expect(result).not.toBeNull();
    expect(result.code).toContain('export async function createUser(args)');
    expect(result.code).toContain('registerAction("main", "createUser"');
    expect(result.code).not.toContain('createUser = action(');
  });
});

// ============================================================================
// Concurrent initialization
// ============================================================================

describe('concurrent initialization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-init-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not initialize twice when load and transform race', async () => {
    const plugin = durableDb();

    const configResolved = plugin.configResolved as Function;
    await configResolved({
      root: tempDir,
      command: 'build',
    } as ResolvedConfig);

    const load = plugin.load as Function;
    const transform = plugin.transform as Function;

    // Fire both hooks concurrently — both call state.initialize()
    const [loadResult, transformResult] = await Promise.all([
      load('\0virtual:durable-db/__durableObjects.js'),
      transform.call(
        { resolve: async () => null },
        'export const x = 1;',
        path.join(tempDir, 'src', 'file.ts')
      ),
    ]);

    // load should return code (even if empty), transform should return null
    expect(loadResult).toHaveProperty('code');
    expect(transformResult).toBeNull();
  });
});
