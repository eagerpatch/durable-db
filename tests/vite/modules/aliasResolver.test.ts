import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Alias } from 'vite';
import { resolveImportPath } from '../../../src/vite/modules/discovery';
import {
  applyAliases,
  loadViteAliases,
  __resetViteAliasCache,
} from '../../../src/vite/modules/aliasResolver';
import { parseDatabaseFile } from '../../../src/vite/modules/parser';

describe('alias resolution (Vite resolve.alias as source of truth)', () => {
  let tempDir: string;
  let srcDir: string;
  let dbDir: string;
  let mainFile: string;
  let schemaFile: string;
  /** Aliases shaped exactly like Vite's resolved `resolve.alias` array. */
  let aliases: Alias[];

  beforeEach(() => {
    __resetViteAliasCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-alias-'));
    srcDir = path.join(tempDir, 'src');
    dbDir = path.join(srcDir, 'databases');
    fs.mkdirSync(dbDir, { recursive: true });

    schemaFile = path.join(dbDir, 'schema.ts');
    mainFile = path.join(dbDir, 'main.ts');
    fs.writeFileSync(schemaFile, 'export const tableX = {};');
    fs.writeFileSync(mainFile, 'export const action = (x) => x;');

    aliases = [{ find: /^@\//, replacement: srcDir + path.sep }];
  });

  afterEach(() => {
    __resetViteAliasCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('applyAliases', () => {
    it('resolves an alias to the real file', () => {
      expect(applyAliases('@/databases/schema', aliases)).toBe(schemaFile);
    });

    it('supports a string-form alias entry', () => {
      const stringAliases: Alias[] = [{ find: '@', replacement: srcDir }];
      expect(applyAliases('@/databases/schema', stringAliases)).toBe(schemaFile);
    });

    it('returns null for a bare package import (no matching alias)', () => {
      expect(applyAliases('durable-db/db', aliases)).toBeNull();
    });

    it('returns null when an alias matches but the target does not exist', () => {
      expect(applyAliases('@/databases/missing', aliases)).toBeNull();
    });

    it('returns null when there are no aliases', () => {
      expect(applyAliases('@/databases/schema', [])).toBeNull();
      expect(applyAliases('@/databases/schema', undefined)).toBeNull();
    });
  });

  describe('resolveImportPath', () => {
    it('resolves a Vite alias to the real file', () => {
      expect(resolveImportPath(mainFile, '@/databases/schema', aliases)).toBe(schemaFile);
    });

    it('still resolves relative imports (no regression)', () => {
      expect(resolveImportPath(mainFile, './schema')).toBe(schemaFile);
      expect(resolveImportPath(mainFile, './schema', aliases)).toBe(schemaFile);
    });

    it('returns null for an unresolvable alias', () => {
      expect(resolveImportPath(mainFile, '@/databases/missing', aliases)).toBeNull();
    });

    it('returns null for a bare package import', () => {
      expect(resolveImportPath(mainFile, 'durable-db/db', aliases)).toBeNull();
    });

    it('returns null for a non-relative import when no aliases are provided', () => {
      expect(resolveImportPath(mainFile, '@/databases/schema')).toBeNull();
    });
  });

  describe('loadViteAliases (loads the project Vite config)', () => {
    it("reads resolve.alias from the project's vite config and resolves through it", async () => {
      // The alias is declared ONLY in the Vite config — proving Vite's resolved
      // config (not our own tsconfig parsing) is the source of truth.
      fs.writeFileSync(
        path.join(tempDir, 'vite.config.mjs'),
        `export default { resolve: { alias: { '@': ${JSON.stringify(srcDir)} } } };\n`
      );

      const loaded = await loadViteAliases(tempDir);
      expect(loaded.length).toBeGreaterThan(0);

      const resolved = resolveImportPath(mainFile, '@/databases/schema', loaded);
      expect(resolved).toBe(schemaFile);
    });

    it('caches per root', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'vite.config.mjs'),
        `export default { resolve: { alias: { '@': ${JSON.stringify(srcDir)} } } };\n`
      );
      const first = await loadViteAliases(tempDir);
      const second = await loadViteAliases(tempDir);
      expect(second).toBe(first);
    });
  });

  describe('parser tracks aliased action factory import', () => {
    it('transforms action() calls when action is imported via a Vite alias', () => {
      const actionsFile = path.join(dbDir, 'actions.ts');
      const code = `
        import { action } from '@/databases/main';

        export const getX = action({
          args: { id: 'string' },
          handler: async (db, args) => db.selectFrom('x').execute(),
        });
      `;
      fs.writeFileSync(actionsFile, code);

      const result = parseDatabaseFile(actionsFile, code, { aliases });

      expect(result.database).toBeNull();
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].exportName).toBe('getX');
    });

    it('does NOT treat a bare-package action import as the factory', () => {
      const actionsFile = path.join(dbDir, 'actions.ts');
      const code = `
        import { action } from 'some-third-party-lib';

        export const getX = action({
          args: { id: 'string' },
          handler: async (db, args) => db.selectFrom('x').execute(),
        });
      `;
      fs.writeFileSync(actionsFile, code);

      const result = parseDatabaseFile(actionsFile, code, { aliases });

      expect(result.actions).toHaveLength(0);
    });
  });
});
