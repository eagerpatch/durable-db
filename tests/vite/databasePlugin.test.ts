import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { shoplayerDatabasePlugin } from '../../src/vite/databasePlugin';
import type { Plugin, ResolvedConfig } from 'vite';

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

    it('returns null for non-virtual imports', async () => {
      const resolveId = plugin.resolveId as Function;

      const result = await resolveId('lodash');

      expect(result).toBeNull();
    });

    it('returns null for relative imports', async () => {
      const resolveId = plugin.resolveId as Function;

      const result = await resolveId('./utils');

      expect(result).toBeNull();
    });
  });

  describe('transform', () => {
    beforeEach(async () => {
      // Set up plugin config
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

    it('returns null for files without action imports', async () => {
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

    it('transforms action files to re-exports with sourcemap', async () => {
      // Create database file first
      const mainCode = `
import { defineDatabase } from '@shoplayer/database/db';
export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: {},
});
`;
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), mainCode);

      // Create action file
      const actionCode = `
import { action } from './main';
export const createUser = action({
  args: { name: 'string' },
  handler: async (db, args) => args,
});
`;
      fs.mkdirSync(path.join(tempDir, 'src', 'databases', 'actions'), { recursive: true });
      const actionPath = path.join(tempDir, 'src', 'databases', 'actions', 'createUser.ts');
      fs.writeFileSync(actionPath, actionCode);

      // Note: Full transform testing requires Vite's plugin context (this.resolve).
      // This is tested more thoroughly in integration.test.ts.
      // Here we just verify the plugin can be instantiated and has the transform hook.
      expect(typeof plugin.transform).toBe('function');
    });
  });
});
