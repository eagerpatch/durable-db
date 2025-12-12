import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { shoplayerDatabasePlugin } from '../../src/vite/databasePlugin';
import type { Plugin, ResolvedConfig } from 'vite';

// ============================================================================
// Plugin Configuration
// ============================================================================

describe('shoplayerDatabasePlugin', () => {
  let tempDir: string;
  let plugin: Plugin;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-plugin-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    plugin = shoplayerDatabasePlugin();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('metadata', () => {
    it('has correct name', () => {
      expect(plugin.name).toBe('shoplayer-database');
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
      const customPlugin = shoplayerDatabasePlugin({
        contextImport: 'my-app/context',
        registryImport: 'my-app/registry',
        databasesDir: 'lib/db',
        shopIdPath: 'user.tenantId',
        autoMigrations: false,
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts autoMigrations: true', () => {
      const customPlugin = shoplayerDatabasePlugin({ autoMigrations: true });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts autoMigrations: development', () => {
      const customPlugin = shoplayerDatabasePlugin({ autoMigrations: 'development' });
      expect(customPlugin.name).toBe('shoplayer-database');
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
    plugin = shoplayerDatabasePlugin();
  });

  it('resolves virtual:shoplayer/databases/__durableObjects', async () => {
    const resolveId = plugin.resolveId as Function;
    const result = await resolveId('virtual:shoplayer/databases/__durableObjects');
    expect(result).toBe('\0virtual:shoplayer/databases/__durableObjects.js');
  });

  it('resolves shoplayer/databases/__durableObjects without prefix', async () => {
    const resolveId = plugin.resolveId as Function;
    const result = await resolveId('shoplayer/databases/__durableObjects');
    expect(result).toBe('\0virtual:shoplayer/databases/__durableObjects.js');
  });

  it('returns null for registry (now a real module)', async () => {
    const resolveId = plugin.resolveId as Function;
    expect(await resolveId('@shoplayer/database/registry')).toBeNull();
  });

  it('returns null for non-virtual imports', async () => {
    const resolveId = plugin.resolveId as Function;
    expect(await resolveId('lodash')).toBeNull();
    expect(await resolveId('react')).toBeNull();
    expect(await resolveId('./utils')).toBeNull();
  });
});

// ============================================================================
// transform
// ============================================================================

describe('transform', () => {
  let tempDir: string;
  let plugin: Plugin;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-transform-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });

    plugin = shoplayerDatabasePlugin();

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
});
