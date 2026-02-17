import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverDatabaseFiles, readFile, resolveImportPath } from '../../../src/vite/modules/discovery';

describe('discovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-discovery-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'databases'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('discoverDatabaseFiles', () => {
    it('discovers .ts files in databases directory', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'analytics.ts'), 'export const y = 2;');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(2);
      expect(discovered.map(d => d.name).sort()).toEqual(['analytics', 'main']);
    });

    it('only discovers TypeScript files (not .js)', () => {
      // The plugin only discovers .ts files by design
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'legacy.js'), 'export const x = 1;');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('main');
    });

    it('ignores schema files', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.ts'), 'export const schema = {};');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('main');
    });

    it('ignores files in subdirectories', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.mkdirSync(path.join(tempDir, 'src', 'databases', 'actions'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'actions', 'getUser.ts'), 'export const y = 2;');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('main');
    });

    it('returns absolute and relative paths', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered[0].absolutePath).toBe(path.join(tempDir, 'src', 'databases', 'main.ts'));
      expect(discovered[0].relativePath).toBe('src/databases/main.ts');
    });

    it('returns empty array for non-existent directory', () => {
      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/nonexistent',
      });

      expect(discovered).toHaveLength(0);
    });

    it('discovers test files (no filtering by default)', () => {
      // Note: The plugin discovers all .ts files. Test file filtering
      // would need to be added if desired.
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.test.ts'), 'test("x", () => {});');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      // Both files are discovered - the parser will determine if they're valid databases
      expect(discovered).toHaveLength(2);
    });

    it('ignores .d.ts files', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'types.d.ts'), 'declare const x: number;');

      const discovered = discoverDatabaseFiles({
        projectRoot: tempDir,
        databasesDir: 'src/databases',
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('main');
    });
  });

  describe('readFile', () => {
    it('reads file contents', () => {
      const content = 'export const x = 1;';
      fs.writeFileSync(path.join(tempDir, 'test.ts'), content);

      const result = readFile(path.join(tempDir, 'test.ts'));

      expect(result).toBe(content);
    });

    it('throws for non-existent file', () => {
      expect(() => readFile(path.join(tempDir, 'nonexistent.ts'))).toThrow();
    });
  });

  describe('resolveImportPath', () => {
    it('resolves relative TypeScript import', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.ts'), '');

      const result = resolveImportPath(
        path.join(tempDir, 'src', 'databases', 'main.ts'),
        './schema'
      );

      expect(result).toBe(path.join(tempDir, 'src', 'databases', 'schema.ts'));
    });

    it('resolves relative JavaScript import', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.js'), '');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'schema.js'), '');

      const result = resolveImportPath(
        path.join(tempDir, 'src', 'databases', 'main.js'),
        './schema'
      );

      expect(result).toBe(path.join(tempDir, 'src', 'databases', 'schema.js'));
    });

    it('resolves parent directory imports', () => {
      fs.mkdirSync(path.join(tempDir, 'src', 'databases', 'actions'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'actions', 'getUser.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), '');

      const result = resolveImportPath(
        path.join(tempDir, 'src', 'databases', 'actions', 'getUser.ts'),
        '../main'
      );

      expect(result).toBe(path.join(tempDir, 'src', 'databases', 'main.ts'));
    });

    it('returns null for package imports', () => {
      const result = resolveImportPath(
        path.join(tempDir, 'src', 'databases', 'main.ts'),
        '@eagerpatch/durable-db/db'
      );

      expect(result).toBeNull();
    });

    it('returns null for non-existent relative imports', () => {
      fs.writeFileSync(path.join(tempDir, 'src', 'databases', 'main.ts'), '');

      const result = resolveImportPath(
        path.join(tempDir, 'src', 'databases', 'main.ts'),
        './nonexistent'
      );

      expect(result).toBeNull();
    });
  });
});
