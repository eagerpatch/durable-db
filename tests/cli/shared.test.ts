import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { reportCliError, loadSchema, loadSchemaTables } from '../../src/cli/shared';
import type { DatabaseInfo } from '../../src/db';

describe('reportCliError', () => {
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    process.env.DEBUG = originalDebug;
    vi.restoreAllMocks();
  });

  it('prints only the message by default', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    reportCliError(new Error('boom'));

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('Error:', 'boom');
  });

  it('prints the stack when verbose is true', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    const error = new Error('boom');
    reportCliError(error, true);

    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls[0]).toEqual(['Error:', 'boom']);
    expect(errSpy.mock.calls[1][0]).toContain('boom');
    expect(errSpy.mock.calls[1][0]).toContain('at '); // stack frame marker
  });

  it('prints the stack when DEBUG env var is set', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEBUG = '*';

    reportCliError(new Error('boom'));

    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error values', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    reportCliError('a string');
    reportCliError({ some: 'object' });

    expect(errSpy).toHaveBeenNthCalledWith(1, 'Error:', 'a string');
    expect(errSpy).toHaveBeenNthCalledWith(2, 'Error:', { some: 'object' });
  });
});

describe('loadSchema', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-loadschema-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDb(overrides: Partial<DatabaseInfo>): DatabaseInfo {
    return {
      filePath: path.join(tempDir, 'main.ts'),
      name: 'main',
      className: 'MainDatabaseDO',
      bindingName: 'MAIN_DATABASE_DO',
      instance: 'per-tenant',
      browsable: false,
      transport: 'rpc',
      migrationsDir: '',
      schemaImport: './schema',
      schemaExport: null,
      schemaTableNames: ['users'],
      ...overrides,
    };
  }

  function writeSchemaFile(content: string): void {
    fs.writeFileSync(path.join(tempDir, 'schema.ts'), content);
  }

  const usersTable = `
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', { id: text('id').primaryKey() });
`;

  it('returns null when the database declares no schema tables', async () => {
    const result = await loadSchema(makeDb({ schemaImport: null, schemaTableNames: [] }));
    expect(result).toBeNull();
  });

  it('loads schema tables exported from the schema module', async () => {
    writeSchemaFile(usersTable);
    const result = await loadSchema(makeDb({}));
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toEqual(['users']);
  });

  it('throws when tables are declared but not imported (inline tables)', async () => {
    await expect(
      loadSchema(makeDb({ schemaImport: null, schemaTableNames: ['users'] }))
    ).rejects.toThrow(/inline.*cannot be loaded|none of them are imported/i);
  });

  it('throws when the schema import cannot be resolved', async () => {
    await expect(
      loadSchema(makeDb({ schemaImport: './does-not-exist' }))
    ).rejects.toThrow(/could not resolve schema import/i);
  });

  it('throws when a declared table is not exported from the schema module', async () => {
    writeSchemaFile(usersTable);
    await expect(
      loadSchema(makeDb({ schemaTableNames: ['users', 'posts'] }))
    ).rejects.toThrow(/does not export: posts/);
  });

  it('throws when zero declared tables can be loaded', async () => {
    writeSchemaFile(`export const unrelated = 42;`);
    await expect(
      loadSchema(makeDb({ schemaTableNames: ['users'] }))
    ).rejects.toThrow(/does not export: users/);
  });

  it('throws with context when the schema module fails to build', async () => {
    writeSchemaFile(`import { missing } from './nope'; export const users = missing;`);
    await expect(loadSchema(makeDb({}))).rejects.toThrow(/Could not build schema/);
  });

  describe('a schema the module exports whole', () => {
    const shared = (overrides: Partial<DatabaseInfo> = {}) =>
      makeDb({ schemaExport: 'schema', schemaTableNames: [], ...overrides });

    const twoTables = `
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', { id: text('id').primaryKey() });
const posts = sqliteTable('posts', { id: text('id').primaryKey() });
`;

    it('loads the tables of the exported const, under its keys', async () => {
      // `posts` is not exported on its own, and `people` is not the table's name: the const says both.
      writeSchemaFile(`${twoTables}export const schema = { people: users, posts };`);
      const result = await loadSchema(shared());
      expect(Object.keys(result!)).toEqual(['people', 'posts']);
    });

    it('loads a default export', async () => {
      writeSchemaFile(`${twoTables}export default { users, posts };`);
      const result = await loadSchema(shared({ schemaExport: 'default' }));
      expect(Object.keys(result!)).toEqual(['users', 'posts']);
    });

    it('returns null for a const without tables, like schema: {}', async () => {
      writeSchemaFile(`export const schema = {};`);
      expect(await loadSchema(shared())).toBeNull();
    });

    it.each([
      ['is not there', usersTable, /the export 'schema' of schema module .*schema\.ts is not an object of tables/],
      ['is not an object', `export const schema = 42;`, /the export 'schema' of schema module/],
      ['is a list', `${usersTable}export const schema = [users];`, /the export 'schema' of schema module/],
    ])('throws when the export %s', async (_, content, message) => {
      writeSchemaFile(content);
      await expect(loadSchema(shared())).rejects.toThrow(message);
    });

    it('names a missing default export as one', async () => {
      writeSchemaFile(usersTable);
      await expect(loadSchema(shared({ schemaExport: 'default' }))).rejects.toThrow(
        /the default export of schema module .* is not an object of tables/
      );
    });
  });
});

describe('loadSchemaTables', () => {
  let tempDir: string;
  let schemaPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-loadtables-'));
    schemaPath = path.join(tempDir, 'schema.ts');
    fs.writeFileSync(
      schemaPath,
      `
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', { id: text('id').primaryKey() });
export const posts = sqliteTable('posts', { id: text('id').primaryKey() });
export const schema = { users };
`
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const db = (overrides: Partial<DatabaseInfo>): DatabaseInfo => ({
    filePath: path.join(tempDir, 'main.ts'),
    name: 'main',
    className: 'MainDatabaseDO',
    bindingName: 'MAIN_DATABASE_DO',
    instance: 'per-tenant',
    browsable: false,
    transport: 'rpc',
    migrationsDir: '',
    schemaImport: './schema',
    schemaExport: null,
    schemaTableNames: [],
    ...overrides,
  });

  it('answers the tables a database lists', async () => {
    const tables = await loadSchemaTables(db({ schemaTableNames: ['users', 'posts'] }), schemaPath);
    expect(Object.keys(tables)).toEqual(['users', 'posts']);
  });

  it('answers the tables of the const a database is given, and nothing else of the module', async () => {
    const tables = await loadSchemaTables(db({ schemaExport: 'schema' }), schemaPath);
    expect(Object.keys(tables)).toEqual(['users']);
  });
});
