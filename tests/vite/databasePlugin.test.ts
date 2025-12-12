import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  shoplayerDatabasePlugin,
  // Helper functions
  isDurableObjectsImport,
  parseActionImport,
  generateActionTransform,
} from '../../src/vite/databasePlugin';
import type { Plugin, ResolvedConfig } from 'vite';
import type { ActionInfo } from '../../src/db/types';

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('isDurableObjectsImport', () => {
  it('matches shoplayer/databases/__durableObjects', () => {
    expect(isDurableObjectsImport('shoplayer/databases/__durableObjects')).toBe(true);
  });

  it('matches virtual:shoplayer/databases/__durableObjects', () => {
    expect(isDurableObjectsImport('virtual:shoplayer/databases/__durableObjects')).toBe(true);
  });

  it('rejects other imports', () => {
    expect(isDurableObjectsImport('shoplayer/databases/main')).toBe(false);
    expect(isDurableObjectsImport('lodash')).toBe(false);
    expect(isDurableObjectsImport('./local')).toBe(false);
    expect(isDurableObjectsImport('')).toBe(false);
  });

  it('rejects partial matches', () => {
    expect(isDurableObjectsImport('shoplayer/databases/__durableObjects/extra')).toBe(false);
    expect(isDurableObjectsImport('prefix/shoplayer/databases/__durableObjects')).toBe(false);
  });
});

describe('parseActionImport', () => {
  it('parses shoplayer/actions/db/action', () => {
    const result = parseActionImport('shoplayer/actions/main/createUser');
    expect(result).toEqual({ dbName: 'main', actionName: 'createUser' });
  });

  it('parses virtual:shoplayer/actions/db/action', () => {
    const result = parseActionImport('virtual:shoplayer/actions/analytics/logEvent');
    expect(result).toEqual({ dbName: 'analytics', actionName: 'logEvent' });
  });

  it('handles complex names', () => {
    const result = parseActionImport('shoplayer/actions/my-database/getUserById');
    expect(result).toEqual({ dbName: 'my-database', actionName: 'getUserById' });
  });

  it('returns null for non-action imports', () => {
    expect(parseActionImport('lodash')).toBeNull();
    expect(parseActionImport('shoplayer/databases/main')).toBeNull();
    expect(parseActionImport('./local')).toBeNull();
    expect(parseActionImport('')).toBeNull();
  });

  it('returns null for malformed action paths', () => {
    expect(parseActionImport('shoplayer/actions/main')).toBeNull();
    expect(parseActionImport('shoplayer/actions/')).toBeNull();
    expect(parseActionImport('shoplayer/actions/a/b/c')).toBeNull();
  });
});

describe('generateActionTransform', () => {
  const mockAction = (name: string): ActionInfo => ({
    exportName: name,
    argsSchemaSource: '{}',
    handlerSource: 'async () => {}',
    databaseName: 'main',
    sourceFile: 'actions/test.ts',
    internalActionCalls: [],
    crossDbActionCalls: [],
  });

  it('generates re-exports for actions', () => {
    const actions = [mockAction('createUser'), mockAction('getUser')];
    const imports = new Map();

    const result = generateActionTransform('main', actions, imports, '', 'test.ts');

    expect(result.code).toContain("export { createUser } from 'shoplayer/actions/main/createUser'");
    expect(result.code).toContain("export { getUser } from 'shoplayer/actions/main/getUser'");
  });

  it('preserves non-action relative imports as side effects', () => {
    const actions = [mockAction('createUser')];
    const imports = new Map([
      ['schema', { imported: 'userSchema', source: './schema' }],
      ['utils', { imported: 'helper', source: './utils' }],
    ]);

    const result = generateActionTransform('main', actions, imports, '', 'test.ts');

    expect(result.code).toContain("import './schema'");
    expect(result.code).toContain("import './utils'");
  });

  it('skips action imports from database file', () => {
    const actions = [mockAction('createUser')];
    const imports = new Map([
      ['action', { imported: 'action', source: './main' }],
    ]);

    const result = generateActionTransform('main', actions, imports, '', 'test.ts');

    expect(result.code).not.toContain("import './main'");
  });

  it('skips non-relative imports', () => {
    const actions = [mockAction('createUser')];
    const imports = new Map([
      ['lodash', { imported: 'map', source: 'lodash' }],
      ['@lib', { imported: 'util', source: '@company/lib' }],
    ]);

    const result = generateActionTransform('main', actions, imports, '', 'test.ts');

    expect(result.code).not.toContain('lodash');
    expect(result.code).not.toContain('@company/lib');
  });

  it('returns valid sourcemap structure', () => {
    const actions = [mockAction('createUser')];
    const result = generateActionTransform('main', actions, new Map(), 'original', 'test.ts');

    expect(result.map.version).toBe(3);
    expect(result.map.sources).toEqual(['test.ts']);
    expect(result.map.sourcesContent).toEqual(['original']);
    expect(Array.isArray(result.map.names)).toBe(true);
    expect(typeof result.map.mappings).toBe('string');
  });

  it('handles empty actions', () => {
    const result = generateActionTransform('main', [], new Map(), '', 'test.ts');
    expect(result.code).toBe('');
  });
});

// ============================================================================
// Plugin Tests
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

  describe('plugin configuration', () => {
    it('returns a plugin with correct name', () => {
      expect(plugin.name).toBe('shoplayer-database');
    });

    it('has enforce: pre', () => {
      expect(plugin.enforce).toBe('pre');
    });

    it('applies to both dev and build (undefined apply)', () => {
      expect(plugin.apply).toBeUndefined();
    });
  });

  describe('options', () => {
    it('accepts custom contextImport', () => {
      const customPlugin = shoplayerDatabasePlugin({
        contextImport: 'my-app/context',
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts custom databasesDir', () => {
      const customPlugin = shoplayerDatabasePlugin({
        databasesDir: 'lib/db',
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts custom shopIdPath', () => {
      const customPlugin = shoplayerDatabasePlugin({
        shopIdPath: 'user.tenantId',
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts autoMigrations: false', () => {
      const customPlugin = shoplayerDatabasePlugin({
        autoMigrations: false,
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts autoMigrations: true', () => {
      const customPlugin = shoplayerDatabasePlugin({
        autoMigrations: true,
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });

    it('accepts autoMigrations: development (default)', () => {
      const customPlugin = shoplayerDatabasePlugin({
        autoMigrations: 'development',
      });
      expect(customPlugin.name).toBe('shoplayer-database');
    });
  });

  describe('resolveId', () => {
    it('resolves virtual:shoplayer/databases/__durableObjects', async () => {
      const resolveId = plugin.resolveId as Function;
      const result = await resolveId('virtual:shoplayer/databases/__durableObjects');
      expect(result).toBe('\0virtual:shoplayer/databases/__durableObjects.js');
    });

    it('resolves shoplayer/databases/__durableObjects (without virtual:)', async () => {
      const resolveId = plugin.resolveId as Function;
      const result = await resolveId('shoplayer/databases/__durableObjects');
      expect(result).toBe('\0virtual:shoplayer/databases/__durableObjects.js');
    });

    it('resolves action virtual module', async () => {
      const resolveId = plugin.resolveId as Function;
      const result = await resolveId('shoplayer/actions/main/createUser');
      expect(result).toBe('\0virtual:shoplayer/actions/main/createUser.js');
    });

    it('resolves action with virtual: prefix', async () => {
      const resolveId = plugin.resolveId as Function;
      const result = await resolveId('virtual:shoplayer/actions/main/createUser');
      expect(result).toBe('\0virtual:shoplayer/actions/main/createUser.js');
    });

    it('returns null for non-virtual imports', async () => {
      const resolveId = plugin.resolveId as Function;
      expect(await resolveId('lodash')).toBeNull();
      expect(await resolveId('react')).toBeNull();
    });

    it('returns null for relative imports', async () => {
      const resolveId = plugin.resolveId as Function;
      expect(await resolveId('./utils')).toBeNull();
      expect(await resolveId('../shared')).toBeNull();
    });

    it('returns null for other shoplayer imports', async () => {
      const resolveId = plugin.resolveId as Function;
      expect(await resolveId('shoplayer/other')).toBeNull();
      expect(await resolveId('@shoplayer/database')).toBeNull();
    });
  });

  describe('transform', () => {
    beforeEach(async () => {
      const configResolved = plugin.configResolved as Function;
      await configResolved({
        root: tempDir,
        command: 'build',
      } as ResolvedConfig);
    });

    it('returns null for node_modules files', async () => {
      const transform = plugin.transform as Function;
      const result = await transform(
        'export const x = 1;',
        '/project/node_modules/lodash/index.ts'
      );
      expect(result).toBeNull();
    });

    it('returns null for virtual modules', async () => {
      const transform = plugin.transform as Function;
      const result = await transform(
        'export const x = 1;',
        '\0virtual:something'
      );
      expect(result).toBeNull();
    });

    it('returns null for non-TypeScript files', async () => {
      const transform = plugin.transform as Function;
      const result = await transform(
        'export const x = 1;',
        path.join(tempDir, 'src', 'file.js')
      );
      expect(result).toBeNull();
    });

    it('returns null for .mjs files', async () => {
      const transform = plugin.transform as Function;
      const result = await transform(
        'export const x = 1;',
        path.join(tempDir, 'src', 'file.mjs')
      );
      expect(result).toBeNull();
    });

    it('returns null for files without actions', async () => {
      const transform = plugin.transform as Function;
      const code = `
import { something } from 'somewhere';
export const x = something();
`;
      const result = await transform(
        code,
        path.join(tempDir, 'src', 'other.ts')
      );
      expect(result).toBeNull();
    });

    it('strips query parameters from id', async () => {
      const transform = plugin.transform as Function;
      const result = await transform(
        'export const x = 1;',
        path.join(tempDir, 'src', 'file.ts') + '?v=123'
      );
      expect(result).toBeNull();
    });
  });

  describe('lifecycle hooks', () => {
    it('has configResolved hook', () => {
      expect(typeof plugin.configResolved).toBe('function');
    });

    it('has configureServer hook', () => {
      expect(typeof plugin.configureServer).toBe('function');
    });

    it('has buildStart hook', () => {
      expect(typeof plugin.buildStart).toBe('function');
    });

    it('has buildEnd hook', () => {
      expect(typeof plugin.buildEnd).toBe('function');
    });

    it('has load hook', () => {
      expect(typeof plugin.load).toBe('function');
    });
  });
});
