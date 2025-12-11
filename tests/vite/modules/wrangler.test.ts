import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findWranglerConfig,
  parseWranglerConfig,
  patchWranglerConfig,
  generateRequiredConfig,
} from '../../../src/vite/modules/wrangler';
import type { DatabaseInfo } from '../../../src/db';

describe('wrangler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoplayer-wrangler-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mockDatabase: DatabaseInfo = {
    filePath: '/src/databases/main.ts',
    name: 'main',
    className: 'MainDatabaseDO',
    bindingName: 'MAIN_DATABASE_DO',
    instance: 'per-shop',
    migrationsDir: './migrations',
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
          migrationsDir: './migrations',
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
          migrationsDir: './migrations',
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
});
