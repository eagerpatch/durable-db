import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { durableDb, databasePlugin } from '../../src/vite/durableDb';
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

  async function initializePlugin(options?: Parameters<typeof durableDb>[0]) {
    const plugin = durableDb(options);
    const configResolved = plugin.configResolved as Function;
    await configResolved({ root: tempDir, command: 'build' } as ResolvedConfig);
    const load = plugin.load as Function;
    await load('\0virtual:durable-db/__durableObjects.js');
  }

  it('does not modify wrangler config by default, but warns with the missing JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');

    await initializePlugin();

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('MAIN_DATABASE_DO');
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
    await configResolved({
      root: tempDir,
      command: 'build',
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
