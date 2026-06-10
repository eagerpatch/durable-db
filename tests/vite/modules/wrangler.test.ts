import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findWranglerConfig,
  parseWranglerConfig,
  patchWranglerConfig,
  checkWranglerConfig,
  generateRequiredConfig,
  stripJsoncComments,
  contentHasComments,
} from '../../../src/vite/modules/wrangler';
import { vi } from 'vitest';
import type { DatabaseInfo } from '../../../src/db';

describe('wrangler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-wrangler-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mockDatabase: DatabaseInfo = {
    filePath: '/src/databases/main.ts',
    name: 'main',
    className: 'MainDatabaseDO',
    bindingName: 'MAIN_DATABASE_DO',
    instance: 'per-tenant',
    migrationsDir: '',
    schemaImport: './schema',
    schemaTableNames: ['users'],
  };

  describe('findWranglerConfig', () => {
    it('finds wrangler.jsonc', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{}');

      const result = findWranglerConfig(tempDir);

      expect(result).toBe(path.join(tempDir, 'wrangler.jsonc'));
    });

    it('finds wrangler.json', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.json'), '{}');

      const result = findWranglerConfig(tempDir);

      expect(result).toBe(path.join(tempDir, 'wrangler.json'));
    });

    it('prefers wrangler.jsonc over wrangler.json', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{"preferred": true}');
      fs.writeFileSync(path.join(tempDir, 'wrangler.json'), '{"preferred": false}');

      const result = findWranglerConfig(tempDir);

      expect(result).toBe(path.join(tempDir, 'wrangler.jsonc'));
    });

    it('returns null when no config exists', () => {
      const result = findWranglerConfig(tempDir);

      expect(result).toBeNull();
    });
  });

  describe('parseWranglerConfig', () => {
    it('parses valid JSON', () => {
      const content = '{"name": "test"}';

      const result = parseWranglerConfig(content);

      expect(result).toEqual({ name: 'test' });
    });

    it('strips single-line comments', () => {
      const content = `{
        // This is a comment
        "name": "test" // inline comment
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({ name: 'test' });
    });

    it('strips multi-line comments', () => {
      const content = `{
        /* This is a
           multi-line comment */
        "name": "test"
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({ name: 'test' });
    });

    it('handles mixed comments', () => {
      const content = `{
        // Single line
        "name": "test", /* inline block */
        /* Multi
           line */
        "value": 123 // end
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('throws on invalid JSON', () => {
      const content = '{ invalid }';

      expect(() => parseWranglerConfig(content)).toThrow();
    });

    it('preserves URLs containing // inside string values', () => {
      const content = `{
        // A comment
        "url": "https://example.com/path",
        "other": "value"
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({
        url: 'https://example.com/path',
        other: 'value',
      });
    });

    it('preserves strings with /* inside them', () => {
      const content = `{
        "pattern": "/* not a comment */",
        "name": "test"
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({
        pattern: '/* not a comment */',
        name: 'test',
      });
    });

    it('handles escaped quotes inside strings', () => {
      const content = `{
        "value": "say \\"hello\\"", // comment
        "name": "test"
      }`;

      const result = parseWranglerConfig(content);

      expect(result).toEqual({
        value: 'say "hello"',
        name: 'test',
      });
    });
  });

  describe('stripJsoncComments', () => {
    it('strips single-line comments', () => {
      expect(stripJsoncComments('{"a": 1} // comment')).toBe('{"a": 1} ');
    });

    it('strips multi-line comments', () => {
      expect(stripJsoncComments('{"a": /* removed */ 1}')).toBe('{"a":  1}');
    });

    it('preserves // inside strings', () => {
      expect(stripJsoncComments('{"url": "https://x.com"}')).toBe('{"url": "https://x.com"}');
    });

    it('preserves /* inside strings', () => {
      expect(stripJsoncComments('{"v": "a /* b */ c"}')).toBe('{"v": "a /* b */ c"}');
    });

    it('handles escaped quotes in strings', () => {
      const input = '{"v": "a\\\\"} // comment';
      const result = stripJsoncComments(input);
      expect(result).toBe('{"v": "a\\\\"} ');
    });
  });

  describe('contentHasComments', () => {
    it('returns true for single-line comments', () => {
      expect(contentHasComments('{"a": 1} // comment')).toBe(true);
    });

    it('returns true for multi-line comments', () => {
      expect(contentHasComments('{"a": /* x */ 1}')).toBe(true);
    });

    it('returns false for plain JSON', () => {
      expect(contentHasComments('{"a": 1}')).toBe(false);
    });

    it('returns false for // inside strings', () => {
      expect(contentHasComments('{"url": "https://x.com"}')).toBe(false);
    });

    it('returns false for /* inside strings', () => {
      expect(contentHasComments('{"v": "a /* b */ c"}')).toBe(false);
    });
  });

  describe('patchWranglerConfig', () => {
    it('adds DO bindings to empty config', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{}');

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(true);
      expect(result.error).toBeNull();

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      expect(config.durable_objects.bindings).toHaveLength(1);
      expect(config.durable_objects.bindings[0]).toEqual({
        name: 'MAIN_DATABASE_DO',
        class_name: 'MainDatabaseDO',
      });
    });

    it('adds migrations for new sqlite classes', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{}');

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(true);

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      expect(config.migrations).toHaveLength(1);
      expect(config.migrations[0].new_sqlite_classes).toContain('MainDatabaseDO');
    });

    it('does not duplicate existing bindings', () => {
      const existingConfig = {
        durable_objects: {
          bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] }],
      };
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(existingConfig));

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(false);

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      expect(config.durable_objects.bindings).toHaveLength(1);
    });

    it('adds new database without removing existing', () => {
      const existingConfig = {
        durable_objects: {
          bindings: [{ name: 'OTHER_DO', class_name: 'OtherDO' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['OtherDO'] }],
      };
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(existingConfig));

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(true);

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      expect(config.durable_objects.bindings).toHaveLength(2);
      expect(config.durable_objects.bindings.map((b: any) => b.name)).toContain('OTHER_DO');
      expect(config.durable_objects.bindings.map((b: any) => b.name)).toContain('MAIN_DATABASE_DO');
    });

    it('returns error for missing config', () => {
      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(false);
      expect(result.configPath).toBeNull();
    });

    it('handles multiple databases', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{}');

      const databases: DatabaseInfo[] = [
        mockDatabase,
        {
          filePath: '/src/databases/analytics.ts',
          name: 'analytics',
          className: 'AnalyticsDatabaseDO',
          bindingName: 'ANALYTICS_DATABASE_DO',
          instance: 'global',
          migrationsDir: '',
          schemaImport: './schema',
          schemaTableNames: ['events'],
        },
      ];

      const result = patchWranglerConfig(tempDir, databases);

      expect(result.modified).toBe(true);

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      expect(config.durable_objects.bindings).toHaveLength(2);
      expect(config.migrations[0].new_sqlite_classes).toHaveLength(2);
    });

    it('generates correct tag when migrations have gaps', () => {
      const existingConfig = {
        durable_objects: { bindings: [] },
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['OldDO'] },
          { tag: 'v5', new_sqlite_classes: ['AnotherDO'] },
        ],
      };
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(existingConfig));

      patchWranglerConfig(tempDir, [mockDatabase]);

      const content = fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8');
      const config = JSON.parse(content);

      // Should be v6 (max of existing + 1), not v3 (array length + 1)
      expect(config.migrations).toHaveLength(3);
      expect(config.migrations[2].tag).toBe('v6');
    });

    it('creates backup when config has comments', () => {
      const configContent = `{
        // This is a comment
        "name": "test-worker"
      }`;
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), configContent);

      patchWranglerConfig(tempDir, [mockDatabase]);

      const backupPath = path.join(tempDir, 'wrangler.jsonc.backup');
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(configContent);
    });

    it('does not create backup when config has no comments', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), '{"name": "test-worker"}');

      patchWranglerConfig(tempDir, [mockDatabase]);

      const backupPath = path.join(tempDir, 'wrangler.jsonc.backup');
      expect(fs.existsSync(backupPath)).toBe(false);
    });

    it('does not overwrite existing backup', () => {
      const originalComment = `{
        // Original comment
        "name": "test-worker"
      }`;
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), originalComment);

      // Create an existing backup
      const existingBackup = '{"old": "backup"}';
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc.backup'), existingBackup);

      patchWranglerConfig(tempDir, [mockDatabase]);

      // Existing backup should be preserved
      expect(fs.readFileSync(path.join(tempDir, 'wrangler.jsonc.backup'), 'utf-8')).toBe(existingBackup);
    });
  });

  describe('generateRequiredConfig', () => {
    it('generates config for single database', () => {
      const result = generateRequiredConfig([mockDatabase]);

      expect(result.durable_objects?.bindings).toHaveLength(1);
      expect(result.durable_objects?.bindings?.[0]).toEqual({
        name: 'MAIN_DATABASE_DO',
        class_name: 'MainDatabaseDO',
      });
      expect(result.migrations?.[0].new_sqlite_classes).toContain('MainDatabaseDO');
    });

    it('generates config for multiple databases', () => {
      const databases: DatabaseInfo[] = [
        mockDatabase,
        {
          filePath: '/src/databases/analytics.ts',
          name: 'analytics',
          className: 'AnalyticsDatabaseDO',
          bindingName: 'ANALYTICS_DATABASE_DO',
          instance: 'global',
          migrationsDir: '',
          schemaImport: './schema',
          schemaTableNames: ['events'],
        },
      ];

      const result = generateRequiredConfig(databases);

      expect(result.durable_objects?.bindings).toHaveLength(2);
      expect(result.migrations?.[0].new_sqlite_classes).toHaveLength(2);
    });

    it('generates empty config for no databases', () => {
      const result = generateRequiredConfig([]);

      expect(result.durable_objects?.bindings).toHaveLength(0);
      expect(result.migrations?.[0].new_sqlite_classes).toHaveLength(0);
    });
  });

  describe('checkWranglerConfig (read-only)', () => {
    it('reports ok and stays quiet when config is complete', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
        durable_objects: { bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] }],
      }));

      const result = checkWranglerConfig(tempDir, [mockDatabase]);

      expect(result.ok).toBe(true);
      expect(result.missingBindings).toHaveLength(0);
      expect(result.missingSqliteClasses).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('warns with the exact missing config and never writes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, '{"name": "my-worker"}');

      const result = checkWranglerConfig(tempDir, [mockDatabase]);

      expect(result.ok).toBe(false);
      expect(result.missingBindings).toEqual([{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }]);
      expect(result.missingSqliteClasses).toEqual(['MainDatabaseDO']);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('MAIN_DATABASE_DO');
      expect(warnSpy.mock.calls[0][0]).toContain('patchWranglerConfig: true');
      // The file must be untouched
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"name": "my-worker"}');
      warnSpy.mockRestore();
    });

    it('warns when no wrangler config exists at all', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = checkWranglerConfig(tempDir, [mockDatabase]);

      expect(result.ok).toBe(false);
      expect(result.configPath).toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();
      warnSpy.mockRestore();
    });
  });
});
