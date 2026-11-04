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
  describeWranglerCheck,
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

    it('writes no backup file, even when the config has comments', () => {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), `{
        // This is a comment
        "name": "test-worker"
      }`);

      patchWranglerConfig(tempDir, [mockDatabase]);

      expect(fs.readdirSync(tempDir)).toEqual(['wrangler.jsonc']);
    });
  });

  describe('patchWranglerConfig keeps the file the user owns (comments, formatting)', () => {
    const lagerverkConfig = `{
  // Generated by create-lagerverk. Edit freely: the framework only adds what it needs.
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "acme-store",
  "main": "@lagerverk/framework/entry",
  "compatibility_date": "2026-10-01", // pinned on purpose
  "compatibility_flags": ["nodejs_compat"],
  /* Public URL, used by emails. */
  "vars": { "APP_URL": "https://acme.test/" },
  "routes": [{ "pattern": "acme.test/*", "zone_name": "acme.test" }],
}
`;

    it('adds the bindings and the migration without touching comments, URLs or formatting', () => {
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, lagerverkConfig);

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(true);
      const text = fs.readFileSync(configPath, 'utf-8');
      expect(text).toContain('// Generated by create-lagerverk. Edit freely');
      expect(text).toContain('"compatibility_date": "2026-10-01", // pinned on purpose');
      expect(text).toContain('/* Public URL, used by emails. */');
      expect(text).toContain('"vars": { "APP_URL": "https://acme.test/" },');
      expect(text).toContain('"routes": [{ "pattern": "acme.test/*", "zone_name": "acme.test" }],');
      expect(text.endsWith('\n')).toBe(true);
      expect(parseWranglerConfig(text)).toMatchObject({
        durable_objects: { bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO'] }],
      });
      expect(fs.readdirSync(tempDir)).toEqual(['wrangler.jsonc']);
    });

    it('appends to existing arrays in the file\'s own indentation and keeps the comments between entries', () => {
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, [
        '{',
        '\t"durable_objects": {',
        '\t\t"bindings": [',
        '\t\t\t// the session store, hand-written',
        '\t\t\t{ "name": "SESSIONS", "class_name": "SessionStore" }',
        '\t\t]',
        '\t},',
        '\t"migrations": [',
        '\t\t{ "tag": "v1", "new_sqlite_classes": ["SessionStore"] } // first deploy',
        '\t]',
        '}',
        '',
      ].join('\n'));

      patchWranglerConfig(tempDir, [mockDatabase]);

      const text = fs.readFileSync(configPath, 'utf-8');
      expect(text).toContain('\t\t\t// the session store, hand-written\n\t\t\t{ "name": "SESSIONS", "class_name": "SessionStore" },');
      expect(text).toContain('{ "tag": "v1", "new_sqlite_classes": ["SessionStore"] }');
      expect(text).toContain('// first deploy');
      expect(text).toMatch(/\n\t\t\t\{\n\t\t\t\t"name": "MAIN_DATABASE_DO"/);
      expect(text).not.toMatch(/^ +"/m);
      const config = parseWranglerConfig(text);
      expect(config.durable_objects?.bindings?.map((b) => b.name)).toEqual(['SESSIONS', 'MAIN_DATABASE_DO']);
      expect(config.migrations?.map((m) => m.tag)).toEqual(['v1', 'v2']);
    });

    it('writes into one-line containers on their line, in the same style', () => {
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, [
        '{',
        '  "durable_objects": { "bindings": [] },',
        '  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["XDO"] },],',
        '}',
      ].join('\n'));

      patchWranglerConfig(tempDir, [mockDatabase]);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe([
        '{',
        '  "durable_objects": { "bindings": [{ "name": "MAIN_DATABASE_DO", "class_name": "MainDatabaseDO" }] },',
        '  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["XDO"] }, { "tag": "v2", "new_sqlite_classes": ["MainDatabaseDO"] }],',
        '}',
      ].join('\n'));
    });

    it('removes a stale binding with its own line and comment, keeping CRLF line endings', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, [
        '{',
        '  "durable_objects": {',
        '    "bindings": [',
        '      { "name": "OLD_DATABASE_DO", "class_name": "OldDatabaseDO" }, // to go',
        '      { "name": "MAIN_DATABASE_DO", "class_name": "MainDatabaseDO" } // stays',
        '    ]',
        '  },',
        '  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }]',
        '}',
        '',
      ].join('\r\n'));

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.removedBindings).toEqual([{ name: 'OLD_DATABASE_DO', class_name: 'OldDatabaseDO' }]);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe([
        '{',
        '  "durable_objects": {',
        '    "bindings": [',
        '      { "name": "MAIN_DATABASE_DO", "class_name": "MainDatabaseDO" } // stays',
        '    ]',
        '  },',
        '  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }]',
        '}',
        '',
      ].join('\r\n'));
      logSpy.mockRestore();
    });

    it('removes the last binding together with the comma before it', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      fs.writeFileSync(configPath, `{
  "durable_objects": {
    "bindings": [
      {
        "name": "MAIN_DATABASE_DO",
        "class_name": "MainDatabaseDO"
      }, // main
      {
        "name": "OLD_DATABASE_DO",
        "class_name": "OldDatabaseDO"
      }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }]
}
`);

      patchWranglerConfig(tempDir, [mockDatabase]);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(`{
  "durable_objects": {
    "bindings": [
      {
        "name": "MAIN_DATABASE_DO",
        "class_name": "MainDatabaseDO"
      } // main
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }]
}
`);
      logSpy.mockRestore();
    });

    it('leaves the file byte-for-byte alone when nothing changes', () => {
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      const content = `{
  // keep me
  "durable_objects": { "bindings": [{ "name": "MAIN_DATABASE_DO", "class_name": "MainDatabaseDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }],
}
`;
      fs.writeFileSync(configPath, content);

      const result = patchWranglerConfig(tempDir, [mockDatabase]);

      expect(result.modified).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
    });
  });

  describe('patchWranglerConfig reconciles durable-db\'s own Durable Objects', () => {
    /** A database as discovery names it: `<prefix>-<file>`, PascalCase class, SCREAMING_SNAKE binding. */
    function database(file: string, prefix?: string): DatabaseInfo {
      const base = path.basename(file).replace(/\.ts$/, '');
      const name = prefix ? `${prefix}-${base}` : base;
      const pascal = name.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
      return {
        ...mockDatabase,
        filePath: file,
        name,
        className: `${pascal}DatabaseDO`,
        bindingName: `${name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase()}_DATABASE_DO`,
      };
    }

    const catalog = database('/acme/apps/store/src/databases/catalog.ts');
    const reviewsFeedback = database('/acme/packages/reviews/src/databases/feedback.ts', 'reviews');
    const feedbackFeedback = database('/acme/packages/reviews/src/databases/feedback.ts', 'feedback');

    // apps/store after its first dev run with the @acme/reviews extension.
    const storeConfig = `{
  "name": "acme-store",
  // durable-db's bindings
  "durable_objects": {
    "bindings": [
      { "name": "CATALOG_DATABASE_DO", "class_name": "CatalogDatabaseDO" },
      { "name": "REVIEWS_FEEDBACK_DATABASE_DO", "class_name": "ReviewsFeedbackDatabaseDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO", "ReviewsFeedbackDatabaseDO"] }
  ]
}
`;

    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      return () => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      };
    });

    function writeConfig(content: string) {
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), content);
    }
    function readConfig() {
      return parseWranglerConfig(fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8'));
    }

    it('renames the class when an extension\'s mount changes, so its data moves with it', () => {
      writeConfig(storeConfig);

      const result = patchWranglerConfig(tempDir, [catalog, feedbackFeedback]);

      expect(result.removedBindings).toEqual([
        { name: 'REVIEWS_FEEDBACK_DATABASE_DO', class_name: 'ReviewsFeedbackDatabaseDO' },
      ]);
      expect(result.addedBindings).toEqual([
        { name: 'FEEDBACK_FEEDBACK_DATABASE_DO', class_name: 'FeedbackFeedbackDatabaseDO' },
      ]);
      expect(result.renamedClasses).toEqual([
        { from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' },
      ]);
      expect(result.newClasses).toEqual([]);
      expect(result.deletedClasses).toEqual([]);

      const config = readConfig();
      expect(config.durable_objects?.bindings).toEqual([
        { name: 'CATALOG_DATABASE_DO', class_name: 'CatalogDatabaseDO' },
        { name: 'FEEDBACK_FEEDBACK_DATABASE_DO', class_name: 'FeedbackFeedbackDatabaseDO' },
      ]);
      expect(config.migrations).toEqual([
        { tag: 'v1', new_sqlite_classes: ['CatalogDatabaseDO', 'ReviewsFeedbackDatabaseDO'] },
        { tag: 'v2', renamed_classes: [{ from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' }] },
      ]);
      expect(fs.readFileSync(path.join(tempDir, 'wrangler.jsonc'), 'utf-8')).toContain("// durable-db's bindings");
      expect(logSpy.mock.calls.flat().join('\n')).toContain(
        'renamed the Durable Object class ReviewsFeedbackDatabaseDO to FeedbackFeedbackDatabaseDO'
      );

      // Settled: the next dev start or build changes nothing.
      const again = patchWranglerConfig(tempDir, [catalog, feedbackFeedback]);
      expect(again.modified).toBe(false);
      expect(again.renamedClasses).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    describe('moves the renamed database\'s migrations with its data', () => {
      /** `db` with its migrations directory under `<tempDir>/migrations/<name>`. */
      function withMigrations(db: DatabaseInfo): DatabaseInfo {
        return { ...db, migrationsDir: path.join(tempDir, 'migrations', db.name) };
      }
      function writeMigration(dbName: string, file: string, sql: string) {
        fs.mkdirSync(path.join(tempDir, 'migrations', dbName), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'migrations', dbName, file), sql);
      }
      const init = 'CREATE TABLE `reviews` (`id` text PRIMARY KEY NOT NULL);';

      it('moves migrations/<old> to migrations/<new> together with the renamed_classes migration', () => {
        writeConfig(storeConfig);
        writeMigration('reviews-feedback', '20261101000000_init.sql', init);
        writeMigration('reviews-feedback', '_snapshot.json', '{}');

        const result = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);

        expect(result.renamedClasses).toEqual([
          { from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' },
        ]);
        expect(result.movedMigrations).toEqual([
          {
            from: path.join(tempDir, 'migrations', 'reviews-feedback'),
            to: path.join(tempDir, 'migrations', 'feedback-feedback'),
          },
        ]);
        expect(result.conflicts).toEqual([]);
        expect(fs.existsSync(path.join(tempDir, 'migrations', 'reviews-feedback'))).toBe(false);
        expect(fs.readdirSync(path.join(tempDir, 'migrations', 'feedback-feedback')).sort()).toEqual([
          '20261101000000_init.sql',
          '_snapshot.json',
        ]);
        expect(readConfig().migrations?.[1]).toEqual({
          tag: 'v2',
          renamed_classes: [{ from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' }],
        });

        const log = logSpy.mock.calls.flat().join('\n');
        expect(log).toContain(`${path.join('migrations', 'reviews-feedback')} moved to ${path.join('migrations', 'feedback-feedback')}`);
        expect(log).toContain('in dev the database starts empty');
        expect(log).not.toContain('keeps its data');

        // Settled.
        const again = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);
        expect(again.modified).toBe(false);
        expect(again.movedMigrations).toEqual([]);
      });

      it('takes the place of an empty new directory', () => {
        writeConfig(storeConfig);
        writeMigration('reviews-feedback', '20261101000000_init.sql', init);
        fs.mkdirSync(path.join(tempDir, 'migrations', 'feedback-feedback'));

        const result = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);

        expect(result.movedMigrations).toHaveLength(1);
        expect(fs.readdirSync(path.join(tempDir, 'migrations', 'feedback-feedback'))).toEqual([
          '20261101000000_init.sql',
        ]);
      });

      it('refuses the rename when the new database already has migrations, naming both directories', () => {
        writeConfig(storeConfig);
        writeMigration('reviews-feedback', '20261101000000_init.sql', init);
        // `db generate` ran under the new mount before dev reconciled the rename.
        writeMigration('feedback-feedback', '20261104000000_init.sql', init);

        const result = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);

        expect(result.renamedClasses).toEqual([]);
        expect(result.newClasses).toEqual([]);
        expect(result.deletedClasses).toEqual([]);
        expect(result.movedMigrations).toEqual([]);
        expect(result.conflicts).toEqual([
          expect.objectContaining({ from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' }),
        ]);
        // Nothing moved, and no class change written: the binding swap only.
        expect(fs.readdirSync(path.join(tempDir, 'migrations', 'reviews-feedback'))).toEqual(['20261101000000_init.sql']);
        expect(readConfig().migrations).toEqual([
          { tag: 'v1', new_sqlite_classes: ['CatalogDatabaseDO', 'ReviewsFeedbackDatabaseDO'] },
        ]);
        expect(readConfig().durable_objects?.bindings).toEqual([
          { name: 'CATALOG_DATABASE_DO', class_name: 'CatalogDatabaseDO' },
          { name: 'FEEDBACK_FEEDBACK_DATABASE_DO', class_name: 'FeedbackFeedbackDatabaseDO' },
        ]);

        const warning = warnSpy.mock.calls.flat().join('\n');
        expect(warning).toContain(
          `rm -r ${path.join('migrations', 'feedback-feedback')} && mv ${path.join('migrations', 'reviews-feedback')} ${path.join('migrations', 'feedback-feedback')}`
        );
        expect(warning).toContain('{"tag":"v2","deleted_classes":["ReviewsFeedbackDatabaseDO"]}');

        // Either way out settles it. Keeping the data:
        fs.rmSync(path.join(tempDir, 'migrations', 'feedback-feedback'), { recursive: true });
        fs.renameSync(path.join(tempDir, 'migrations', 'reviews-feedback'), path.join(tempDir, 'migrations', 'feedback-feedback'));
        const kept = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);
        expect(kept.conflicts).toEqual([]);
        expect(kept.renamedClasses).toEqual([
          { from: 'ReviewsFeedbackDatabaseDO', to: 'FeedbackFeedbackDatabaseDO' },
        ]);
      });

      it('settles a refused rename once the old class is deleted by hand', () => {
        writeConfig(storeConfig.replace(
          '{ "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO", "ReviewsFeedbackDatabaseDO"] }',
          '{ "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO", "ReviewsFeedbackDatabaseDO"] },\n' +
          '    { "tag": "v2", "deleted_classes": ["ReviewsFeedbackDatabaseDO"] }'
        ));
        writeMigration('reviews-feedback', '20261101000000_init.sql', init);
        writeMigration('feedback-feedback', '20261104000000_init.sql', init);

        const result = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);

        expect(result.conflicts).toEqual([]);
        expect(result.newClasses).toEqual(['FeedbackFeedbackDatabaseDO']);
      });

      it('refuses when several migrations directories belong to the old class', () => {
        writeConfig(storeConfig);
        writeMigration('reviews-feedback', '20261101000000_init.sql', init);
        writeMigration('reviews_feedback', '20261101000000_init.sql', init);

        const result = patchWranglerConfig(tempDir, [withMigrations(catalog), withMigrations(feedbackFeedback)]);

        expect(result.renamedClasses).toEqual([]);
        expect(result.conflicts).toEqual([
          expect.objectContaining({ reason: expect.stringContaining('several migrations directories') }),
        ]);
        expect(fs.existsSync(path.join(tempDir, 'migrations', 'reviews-feedback'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'migrations', 'reviews_feedback'))).toBe(true);
      });
    });

    it('drops the binding of a removed extension and asks for the deleted_classes migration instead of writing it', () => {
      writeConfig(storeConfig);

      const result = patchWranglerConfig(tempDir, [catalog]);

      expect(result.modified).toBe(true);
      expect(result.removedBindings).toEqual([
        { name: 'REVIEWS_FEEDBACK_DATABASE_DO', class_name: 'ReviewsFeedbackDatabaseDO' },
      ]);
      expect(result.deletedClasses).toEqual(['ReviewsFeedbackDatabaseDO']);

      const config = readConfig();
      expect(config.durable_objects?.bindings).toEqual([
        { name: 'CATALOG_DATABASE_DO', class_name: 'CatalogDatabaseDO' },
      ]);
      // The data is never deleted for the user.
      expect(config.migrations).toEqual([
        { tag: 'v1', new_sqlite_classes: ['CatalogDatabaseDO', 'ReviewsFeedbackDatabaseDO'] },
      ]);
      const warning = warnSpy.mock.calls.flat().join('\n');
      expect(warning).toContain('{"tag":"v2","deleted_classes":["ReviewsFeedbackDatabaseDO"]}');
      expect(warning).toContain('ALL its data');

      // It keeps warning until the user decides; a hand-written deleted_classes settles it.
      warnSpy.mockClear();
      patchWranglerConfig(tempDir, [catalog]);
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockClear();
      writeConfig(`{
  "durable_objects": { "bindings": [{ "name": "CATALOG_DATABASE_DO", "class_name": "CatalogDatabaseDO" }] },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO", "ReviewsFeedbackDatabaseDO"] },
    { "tag": "v2", "deleted_classes": ["ReviewsFeedbackDatabaseDO"] }
  ]
}
`);
      const settled = patchWranglerConfig(tempDir, [catalog]);
      expect(settled.modified).toBe(false);
      expect(settled.deletedClasses).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('renames when a database moves into a mounted extension, but never guesses one out of it', () => {
      const appFeedback = database('/acme/apps/store/src/databases/feedback.ts');
      writeConfig(`{
  "durable_objects": { "bindings": [{ "name": "FEEDBACK_DATABASE_DO", "class_name": "FeedbackDatabaseDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FeedbackDatabaseDO"] }]
}
`);

      expect(patchWranglerConfig(tempDir, [reviewsFeedback]).renamedClasses).toEqual([
        { from: 'FeedbackDatabaseDO', to: 'ReviewsFeedbackDatabaseDO' },
      ]);

      // Out of the mount reads exactly like an app replacing reviews-feedback.ts
      // with feedback.ts: a new class, and the old one left to the user.
      const back = patchWranglerConfig(tempDir, [appFeedback]);
      expect(back.renamedClasses).toEqual([]);
      expect(back.newClasses).toEqual(['FeedbackDatabaseDO']);
      expect(back.deletedClasses).toEqual(['ReviewsFeedbackDatabaseDO']);
      expect(readConfig().migrations?.map((m) => m.tag)).toEqual(['v1', 'v2', 'v3']);
    });

    it('does not guess a rename between two databases of the app', () => {
      // src/databases/catalog.ts deleted, src/databases/product-catalog.ts added.
      const productCatalog = database('/acme/apps/store/src/databases/product-catalog.ts');
      writeConfig(`{
  "durable_objects": { "bindings": [{ "name": "CATALOG_DATABASE_DO", "class_name": "CatalogDatabaseDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO"] }]
}
`);

      const result = patchWranglerConfig(tempDir, [productCatalog]);

      expect(result.renamedClasses).toEqual([]);
      expect(result.newClasses).toEqual(['ProductCatalogDatabaseDO']);
      expect(result.deletedClasses).toEqual(['CatalogDatabaseDO']);
      expect(readConfig().migrations).toEqual([
        { tag: 'v1', new_sqlite_classes: ['CatalogDatabaseDO'] },
        { tag: 'v2', new_sqlite_classes: ['ProductCatalogDatabaseDO'] },
      ]);

      // …nor the other way round.
      writeConfig(`{
  "durable_objects": { "bindings": [{ "name": "PRODUCT_CATALOG_DATABASE_DO", "class_name": "ProductCatalogDatabaseDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ProductCatalogDatabaseDO"] }]
}
`);
      const reverse = patchWranglerConfig(tempDir, [catalog]);
      expect(reverse.renamedClasses).toEqual([]);
      expect(reverse.newClasses).toEqual(['CatalogDatabaseDO']);
      expect(reverse.deletedClasses).toEqual(['ProductCatalogDatabaseDO']);
    });

    it('does not guess a rename when it is ambiguous', () => {
      writeConfig(`{
  "durable_objects": {
    "bindings": [
      { "name": "REVIEWS_FEEDBACK_DATABASE_DO", "class_name": "ReviewsFeedbackDatabaseDO" },
      { "name": "SURVEYS_FEEDBACK_DATABASE_DO", "class_name": "SurveysFeedbackDatabaseDO" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ReviewsFeedbackDatabaseDO", "SurveysFeedbackDatabaseDO"] }]
}
`);

      const result = patchWranglerConfig(tempDir, [feedbackFeedback]);

      expect(result.renamedClasses).toEqual([]);
      expect(result.newClasses).toEqual(['FeedbackFeedbackDatabaseDO']);
      expect(result.deletedClasses).toEqual(['ReviewsFeedbackDatabaseDO', 'SurveysFeedbackDatabaseDO']);
      expect(readConfig().durable_objects?.bindings).toEqual([
        { name: 'FEEDBACK_FEEDBACK_DATABASE_DO', class_name: 'FeedbackFeedbackDatabaseDO' },
      ]);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        '{"tag":"v3","deleted_classes":["ReviewsFeedbackDatabaseDO","SurveysFeedbackDatabaseDO"]}'
      );
    });

    it('skips malformed entries and still removes the right binding by position', () => {
      writeConfig(`{
  "durable_objects": {
    "bindings": [
      "not a binding",
      { "name": "OLD_DATABASE_DO", "class_name": "OldDatabaseDO" },
      { "name": "CATALOG_DATABASE_DO", "class_name": "CatalogDatabaseDO" }
    ]
  },
  "migrations": [null, { "tag": "v1", "new_sqlite_classes": ["CatalogDatabaseDO"], "renamed_classes": "nope" }]
}
`);

      const result = patchWranglerConfig(tempDir, [catalog]);

      expect(result.error).toBeNull();
      expect(result.removedBindings).toEqual([{ name: 'OLD_DATABASE_DO', class_name: 'OldDatabaseDO' }]);
      expect(readConfig().durable_objects?.bindings).toEqual([
        'not a binding',
        { name: 'CATALOG_DATABASE_DO', class_name: 'CatalogDatabaseDO' },
      ]);
      const check = checkWranglerConfig(tempDir, [catalog]);
      expect(check.ok).toBe(true);
    });

    it('never touches bindings it does not own', () => {
      writeConfig(`{
  "durable_objects": {
    "bindings": [
      { "name": "SESSIONS", "class_name": "SessionStore" },
      { "name": "LEDGER_DATABASE_DO", "class_name": "LedgerDatabaseDO", "script_name": "acme-ledger" },
      { "name": "MY_DB", "class_name": "LegacyDatabaseDO" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SessionStore", "LegacyDatabaseDO"] }]
}
`);

      const result = patchWranglerConfig(tempDir, [catalog]);

      expect(result.removedBindings).toEqual([]);
      expect(result.deletedClasses).toEqual([]);
      expect(readConfig().durable_objects?.bindings?.map((b) => b.name)).toEqual([
        'SESSIONS',
        'LEDGER_DATABASE_DO',
        'MY_DB',
        'CATALOG_DATABASE_DO',
      ]);
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

    it('reports a stale binding and class of a database that is gone, and never writes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const configPath = path.join(tempDir, 'wrangler.jsonc');
      const content = JSON.stringify({
        durable_objects: {
          bindings: [
            { name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' },
            { name: 'REVIEWS_FEEDBACK_DATABASE_DO', class_name: 'ReviewsFeedbackDatabaseDO' },
          ],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO', 'ReviewsFeedbackDatabaseDO'] }],
      });
      fs.writeFileSync(configPath, content);

      const result = checkWranglerConfig(tempDir, [mockDatabase]);

      expect(result.ok).toBe(false);
      expect(result.missingBindings).toEqual([]);
      expect(result.staleBindings).toEqual([
        { name: 'REVIEWS_FEEDBACK_DATABASE_DO', class_name: 'ReviewsFeedbackDatabaseDO' },
      ]);
      expect(result.staleClasses).toEqual(['ReviewsFeedbackDatabaseDO']);
      const warning = warnSpy.mock.calls.flat().join('\n');
      expect(warning).toContain('REVIEWS_FEEDBACK_DATABASE_DO (ReviewsFeedbackDatabaseDO)');
      expect(warning).toContain('"deleted_classes":["ReviewsFeedbackDatabaseDO"]');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
      warnSpy.mockRestore();
    });

    it('suggests the renamed_classes migration for a mount change', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
        durable_objects: { bindings: [{ name: 'REVIEWS_MAIN_DATABASE_DO', class_name: 'ReviewsMainDatabaseDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ReviewsMainDatabaseDO'] }],
      }));

      const result = checkWranglerConfig(tempDir, [{
        ...mockDatabase,
        filePath: '/ext/databases/main.ts',
        name: 'feedback-main',
        className: 'FeedbackMainDatabaseDO',
        bindingName: 'FEEDBACK_MAIN_DATABASE_DO',
      }]);

      expect(result.ok).toBe(false);
      expect(result.staleClasses).toEqual(['ReviewsMainDatabaseDO']);
      expect(result.renamedClasses).toEqual([{ from: 'ReviewsMainDatabaseDO', to: 'FeedbackMainDatabaseDO' }]);
      // The rename target is not "missing" too: one migration entry, no class declared twice.
      expect(result.missingSqliteClasses).toEqual([]);
      const warning = warnSpy.mock.calls.flat().join('\n');
      const snippet = JSON.parse(warning.slice(warning.indexOf('{\n'), warning.indexOf('\n}\n') + 2));
      expect(snippet).toEqual({
        durable_objects: { bindings: [{ name: 'FEEDBACK_MAIN_DATABASE_DO', class_name: 'FeedbackMainDatabaseDO' }] },
        migrations: [{ tag: 'v2', renamed_classes: [{ from: 'ReviewsMainDatabaseDO', to: 'FeedbackMainDatabaseDO' }] }],
      });
      expect(warning).not.toContain('new_sqlite_classes');
      warnSpy.mockRestore();
    });

    it('gives the mv that moves a renamed database\'s migrations, and never moves them itself', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
        durable_objects: { bindings: [{ name: 'REVIEWS_MAIN_DATABASE_DO', class_name: 'ReviewsMainDatabaseDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ReviewsMainDatabaseDO'] }],
      }));
      fs.mkdirSync(path.join(tempDir, 'migrations', 'reviews-main'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'migrations', 'reviews-main', '20261101000000_init.sql'), 'CREATE TABLE `a` (`id` text);');

      const result = checkWranglerConfig(tempDir, [{
        ...mockDatabase,
        filePath: '/ext/databases/main.ts',
        name: 'feedback-main',
        className: 'FeedbackMainDatabaseDO',
        bindingName: 'FEEDBACK_MAIN_DATABASE_DO',
        migrationsDir: path.join(tempDir, 'migrations', 'feedback-main'),
      }]);

      expect(result.migrationsMoves).toEqual([{
        from: path.join(tempDir, 'migrations', 'reviews-main'),
        to: path.join(tempDir, 'migrations', 'feedback-main'),
      }]);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        `mv ${path.join('migrations', 'reviews-main')} ${path.join('migrations', 'feedback-main')}`
      );
      expect(fs.existsSync(path.join(tempDir, 'migrations', 'reviews-main'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('suggests the next free tag for missing classes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
        durable_objects: { bindings: [{ name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['OtherDO'] }],
      }));

      const result = checkWranglerConfig(tempDir, [mockDatabase]);

      expect(result.missingSqliteClasses).toEqual(['MainDatabaseDO']);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('"tag": "v2"');
      warnSpy.mockRestore();
    });

    it('describes what is wrong: stale, not missing, when only a removed database is left', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify({
        durable_objects: {
          bindings: [
            { name: 'MAIN_DATABASE_DO', class_name: 'MainDatabaseDO' },
            { name: 'OLD_DATABASE_DO', class_name: 'OldDatabaseDO' },
          ],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MainDatabaseDO', 'OldDatabaseDO'] }],
      }));

      const description = describeWranglerCheck(checkWranglerConfig(tempDir, [mockDatabase]));

      expect(description).toContain('binding class(es) the worker no longer exports (OldDatabaseDO)');
      expect(description).toContain('declaring class(es) of database(s) that no longer exist (OldDatabaseDO)');
      expect(description).not.toContain('missing');
      warnSpy.mockRestore();
    });
  });
});
