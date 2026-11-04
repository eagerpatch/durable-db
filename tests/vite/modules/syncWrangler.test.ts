import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncWranglerConfig, discoverDatabaseInfos } from '../../../src/vite/modules/syncWrangler';

const MAIN_DATABASE = `
import { defineDatabase } from 'durable-db';
import { users } from './schema';
export const { action } = defineDatabase({ schema: { users } });
`;

describe('syncWrangler', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-sync-wrangler-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), MAIN_DATABASE);
    configPath = path.join(tempDir, 'wrangler.jsonc');
    fs.writeFileSync(configPath, '{"name": "my-worker"}');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('syncWranglerConfig', () => {
    it('patches once and is silent when nothing changes', () => {
      const log = vi.fn();

      const first = syncWranglerConfig({ projectRoot: tempDir, log });
      const second = syncWranglerConfig({ projectRoot: tempDir, log });

      expect(first).toMatchObject({ configPath, modified: true, databases: ['main'], error: null });
      expect(first.changes).toEqual([
        'Durable Objects: +MAIN_DATABASE_DO → MainDatabaseDO',
        'migration v1: MainDatabaseDO',
      ]);
      expect(second.modified).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'durable-db updated wrangler.jsonc (Durable Objects: +MAIN_DATABASE_DO → MainDatabaseDO; migration v1: MainDatabaseDO)'
      );
    });

    it('writes nothing while a database file does not parse', () => {
      // A partial set of databases would read as databases removed.
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'broken.ts'), 'export const = ;');

      const result = syncWranglerConfig({ projectRoot: tempDir, log: false });

      expect(result.modified).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
    });

    it('leaves an app without databases alone', () => {
      fs.rmSync(path.join(tempDir, 'src', 'databases', 'main.ts'));

      const result = syncWranglerConfig({ projectRoot: tempDir, log: false });

      expect(result).toMatchObject({ modified: false, databases: [] });
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
    });

    it('names the databases of every source, prefixed', () => {
      const extensionDir = path.join(tempDir, 'extensions', 'invoicing', 'databases');
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, 'invoices.ts'), MAIN_DATABASE);

      const result = syncWranglerConfig({
        projectRoot: tempDir,
        databasesDir: [{ dir: 'src/databases' }, { dir: 'extensions/invoicing/databases', prefix: 'invoicing' }],
        log: false,
      });

      expect(result.databases).toEqual(['main', 'invoicing-invoices']);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.durable_objects.bindings.map((b: { name: string }) => b.name)).toEqual([
        'MAIN_DATABASE_DO',
        'INVOICING_INVOICES_DATABASE_DO',
      ]);
    });
  });

  describe('discoverDatabaseInfos', () => {
    it('lists the files that do not parse apart from the databases', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'broken.ts'), 'export const = ;');

      const { databases, unparsable } = discoverDatabaseInfos(tempDir, 'src/databases');

      expect(databases.map((db) => db.name)).toEqual(['main']);
      expect(unparsable).toEqual([path.join('src', 'databases', 'broken.ts')]);
    });
  });
});
