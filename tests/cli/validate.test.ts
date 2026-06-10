import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validate } from '../../src/cli/validate';
import { saveDevMigration, getDevPaths } from '../../src/cli/state';

describe('validate command', () => {
  let tempDir: string;
  let databasesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-validate-'));
    databasesDir = path.join(tempDir, 'src/databases');
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(databasesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupDatabase(
    name: string,
    opts: {
      migrations?: Array<{ name: string; sql: string }>;
      schemaContent?: string;
    } = {}
  ) {
    const { migrations = [], schemaContent } = opts;

    // Create database file
    if (schemaContent) {
      fs.writeFileSync(path.join(databasesDir, 'schema.ts'), schemaContent);
      fs.writeFileSync(
        path.join(databasesDir, `${name}.ts`),
        `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`
      );
    } else {
      fs.writeFileSync(
        path.join(databasesDir, `${name}.ts`),
        `
import { defineDatabase } from 'durable-db/db';

export const { action } = defineDatabase({});
`
      );
    }

    // Create migrations directory (convention: {root}/migrations/{name}/)
    const migrationsDir = path.join(tempDir, 'migrations', name);
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Write migration files
    for (const mig of migrations) {
      fs.writeFileSync(path.join(migrationsDir, `${mig.name}.sql`), mig.sql);
    }

    // Write empty snapshot
    fs.writeFileSync(
      path.join(migrationsDir, '_snapshot.json'),
      JSON.stringify({
        version: '6',
        dialect: 'sqlite',
        id: '0000000000000',
        prevId: '',
        tables: {},
        enums: {},
        views: {},
        _meta: { tables: {}, columns: {} },
      }, null, 2)
    );
  }

  it('returns empty results when no databases exist', async () => {
    fs.rmSync(databasesDir, { recursive: true, force: true });

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(0);
  });

  it('validates valid migrations successfully', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_create_users',
          sql: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
        },
        {
          name: '20240102_add_email',
          sql: 'ALTER TABLE users ADD COLUMN email TEXT;',
        },
      ],
    });

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    expect(results[0].database).toBe('main');
    expect(results[0].migrationsValid).toBe(true);
    expect(results[0].errors).toHaveLength(0);
    expect(results[0].migrationCount).toBe(2);
  });

  it('detects invalid SQL in migrations', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_create_users',
          sql: 'CREATE TABLE users (id TEXT PRIMARY KEY);',
        },
        {
          name: '20240102_bad_migration',
          sql: 'ALTER TABLE nonexistent ADD COLUMN foo TEXT;',
        },
      ],
    });

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    expect(results[0].migrationsValid).toBe(false);
    expect(results[0].errors).toHaveLength(1);
    expect(results[0].errors[0].migration).toBe('20240102_bad_migration');
    expect(results[0].errors[0].error).toContain('nonexistent');
  });

  it('handles breakpoints in migration files', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_multi_chunk',
          sql: [
            'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
            '--> breakpoint',
            'CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));',
          ].join('\n'),
        },
      ],
    });

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    expect(results[0].migrationsValid).toBe(true);
  });

  it('includes dev migrations by default', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_create_users',
          sql: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
        },
      ],
    });

    // Add a dev migration
    const paths = getDevPaths(tempDir);
    const devMigrationsDir = paths.migrationsDir('main');
    fs.mkdirSync(devMigrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(devMigrationsDir, '0001_dev.sql'),
      'ALTER TABLE users ADD COLUMN bio TEXT;'
    );

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    expect(results[0].migrationsValid).toBe(true);
    expect(results[0].includesDevMigrations).toBe(true);
    expect(results[0].migrationCount).toBe(2);
  });

  it('excludes dev migrations with noDev flag', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_create_users',
          sql: 'CREATE TABLE users (id TEXT PRIMARY KEY);',
        },
      ],
    });

    // Add a dev migration
    const paths = getDevPaths(tempDir);
    const devMigrationsDir = paths.migrationsDir('main');
    fs.mkdirSync(devMigrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(devMigrationsDir, '0001_dev.sql'),
      'ALTER TABLE users ADD COLUMN bio TEXT;'
    );

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
      noDev: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].includesDevMigrations).toBe(false);
    expect(results[0].migrationCount).toBe(1);
  });

  it('filters by database name', async () => {
    setupDatabase('main', {
      migrations: [
        { name: '20240101_init', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY);' },
      ],
    });

    // Create another database file
    fs.writeFileSync(
      path.join(databasesDir, 'other.ts'),
      `
import { defineDatabase } from 'durable-db/db';

export const { action } = defineDatabase({});
`
    );

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
      database: 'main',
    });

    expect(results).toHaveLength(1);
    expect(results[0].database).toBe('main');
  });

  it('reports migration count of zero when no migrations exist', async () => {
    setupDatabase('main');

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    expect(results[0].migrationCount).toBe(0);
    expect(results[0].migrationsValid).toBe(true);
  });

  it('collects multiple errors from different migrations', async () => {
    setupDatabase('main', {
      migrations: [
        {
          name: '20240101_bad1',
          sql: 'CREATE TABLE nonexistent_ref (id TEXT PRIMARY KEY, ref TEXT REFERENCES nosuchtable(id));',
        },
        {
          name: '20240102_bad2',
          sql: 'ALTER TABLE doesnotexist ADD COLUMN foo TEXT;',
        },
      ],
    });

    const results = await validate({
      projectRoot: tempDir,
      databasesDir: 'src/databases',
    });

    expect(results).toHaveLength(1);
    // The first CREATE TABLE might succeed (SQLite allows dangling FK refs by default)
    // but the ALTER TABLE on nonexistent table should fail
    expect(results[0].errors.length).toBeGreaterThanOrEqual(1);
    expect(results[0].migrationsValid).toBe(false);
  });
});
