import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  generateDurableObjectsModule,
  transformActionFile,
} from '../../../src/vite/modules/generator';
import type { DatabaseInfo, ActionInfo } from '../../../src/db';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockDatabase: DatabaseInfo = {
  filePath: '/src/databases/main.ts',
  name: 'main',
  className: 'MainDatabaseDO',
  bindingName: 'MAIN_DATABASE_DO',
  instance: 'per-tenant',
  browsable: false,
  migrationsDir: './migrations',
  schemaImport: './schema',
  schemaTableNames: ['users'],
};

const globalDatabase: DatabaseInfo = {
  ...mockDatabase,
  name: 'analytics',
  className: 'AnalyticsDO',
  bindingName: 'ANALYTICS_DO',
  instance: 'global',
};

const createUserAction: ActionInfo = {
  exportName: 'createUser',
  argsSchemaSource: `{ name: 'string', email: 'string.email' }`,
  handlerSource: `async (db, args) => db.insertInto('users').values(args).execute()`,
  databaseName: 'main',
  sourceFile: 'src/actions/users.ts',
};

const getUserAction: ActionInfo = {
  exportName: 'getUser',
  argsSchemaSource: `{ id: 'string' }`,
  handlerSource: `async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst()`,
  databaseName: 'main',
  sourceFile: 'src/actions/users.ts',
};

// ============================================================================
// parseExpression
// ============================================================================

describe('parseExpression', () => {
  it('parses object literals', () => {
    const result = parseExpression('{ a: 1, b: 2 }');
    expect(result.type).toBe('ObjectExpression');
  });

  it('parses arrow functions', () => {
    const result = parseExpression('async (db, args) => db.query()');
    expect(result.type).toBe('ArrowFunctionExpression');
  });

  it('parses function calls', () => {
    const result = parseExpression('foo()');
    expect(result.type).toBe('CallExpression');
  });

  it('parses member expressions', () => {
    const result = parseExpression('foo.bar.baz');
    expect(result.type).toBe('MemberExpression');
  });

  it('strips trailing semicolons', () => {
    const result = parseExpression('{ x: 1 };');
    expect(result.type).toBe('ObjectExpression');
  });

  it('throws on non-expressions', () => {
    expect(() => parseExpression('const x = 1')).toThrow();
  });
});

// ============================================================================
// generateDurableObjectsModule
// ============================================================================

describe('generateDurableObjectsModule', () => {
  it('imports SqliteDurableObject', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toMatch(/import\s*\{\s*SqliteDurableObject\s*\}\s*from\s*["']@shoplayer\/database\/db["']/);
  });

  it('imports arktype', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toMatch(/import\s*\{\s*type\s*\}\s*from\s*["']arktype["']/);
  });

  it('imports from registry module', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toMatch(/import\s*\{[^}]*getAction[^}]*\}\s*from\s*["']@shoplayer\/database\/registry["']/);
    expect(code).toMatch(/import\s*\{[^}]*runWithDoContext[^}]*\}\s*from\s*["']@shoplayer\/database\/registry["']/);
  });

  it('generates class extending SqliteDurableObject', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toContain('class MainDatabaseDO extends SqliteDurableObject');
  });

  it('includes migrations property', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toContain('migrations = {}');
  });

  it('generates rpc method', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toContain('async rpc(method, args, rpcContext)');
  });

  it('includes getAction call', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toContain('getAction("main", method)');
  });

  it('includes runWithDoContext', () => {
    const code = generateDurableObjectsModule([mockDatabase], '@shoplayer/database/registry');
    expect(code).toContain('runWithDoContext(');
  });

  it('handles multiple databases', () => {
    const code = generateDurableObjectsModule([mockDatabase, globalDatabase], '@shoplayer/database/registry');
    expect(code).toContain('class MainDatabaseDO');
    expect(code).toContain('class AnalyticsDO');
  });

  it('generates binding names object', () => {
    const code = generateDurableObjectsModule([mockDatabase, globalDatabase], '@shoplayer/database/registry');
    // Check that both bindings are present (format may vary)
    expect(code).toMatch(/["']main["']\s*:\s*["']MAIN_DATABASE_DO["']/);
    expect(code).toMatch(/["']analytics["']\s*:\s*["']ANALYTICS_DO["']/);
  });

  it('wraps class with Browsable() when browsable is true', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: true };
    const code = generateDurableObjectsModule([db], '@shoplayer/database/registry', false);
    expect(code).toContain('Browsable');
    expect(code).toContain('_MainDatabaseDO_Base');
    // Should have migration guard overrides for fetch and __studio
    expect(code).toContain('ensureMigrations');
    expect(code).toContain('__studio');
  });

  it('wraps class with Browsable() when browsable is "development" and isDev', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: 'development' };
    const code = generateDurableObjectsModule([db], '@shoplayer/database/registry', true);
    expect(code).toContain('Browsable');
    expect(code).toContain('_MainDatabaseDO_Base');
  });

  it('does not use Browsable() when browsable is "development" and not isDev', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: 'development' };
    const code = generateDurableObjectsModule([db], '@shoplayer/database/registry', false);
    expect(code).not.toContain('Browsable');
    expect(code).not.toContain('_MainDatabaseDO_Base');
  });

  it('does not use Browsable() when browsable is false', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: false };
    const code = generateDurableObjectsModule([db], '@shoplayer/database/registry', true);
    expect(code).not.toContain('Browsable');
  });

  it('includes migrations when provided', () => {
    const dbWithMigrations: DatabaseInfo = {
      ...mockDatabase,
      migrations: new Map([['001_init', [['CREATE TABLE users (id TEXT)']]]]),
    };
    const code = generateDurableObjectsModule([dbWithMigrations], '@shoplayer/database/registry');
    expect(code).toContain('001_init');
    expect(code).toContain('chunks');
  });
});

// ============================================================================
// transformActionFile
// ============================================================================

describe('transformActionFile', () => {
  const defaultOptions = {
    dbName: 'main',
    database: mockDatabase,
    contextImport: '@shoplayer/database/context',
    tenantIdPath: 'session.tenantId',
    registryImport: '@shoplayer/database/registry',
  };

  it('returns null for empty actions', () => {
    const result = transformActionFile({
      ...defaultOptions,
      code: 'const x = 1;',
      actionsInFile: [],
    });
    expect(result).toBeNull();
  });

  it('transforms action exports', () => {
    const code = `
import { action } from './main';

export const createUser = action({
  args: { name: 'string' },
  handler: async (db, args) => db.insertInto('users').values(args).execute()
});
`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result).not.toBeNull();
    expect(result!.code).toContain('export async function createUser');
  });

  it('adds arktype import', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*type[^}]*\}\s*from\s*["']arktype["']/);
  });

  it('adds context import', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*getContext[^}]*\}\s*from\s*["']@shoplayer\/database\/context["']/);
  });

  it('adds registry imports', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('registerAction');
    expect(result!.code).toContain('getDoContext');
    expect(result!.code).toContain('callActionInValidated');
  });

  it('generates registerAction call', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('registerAction("main", "createUser"');
  });

  it('generates DO short path check', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('getDoContext()');
    expect(result!.code).toContain('callActionInValidated');
  });

  it('generates validation code', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('argsSchema');
    expect(result!.code).toContain('argsSchema.assert(args)');
  });

  it('uses global instanceKey for global databases', () => {
    const code = `export const logEvent = action({ args: {}, handler: async () => {} });`;
    const logEventAction: ActionInfo = {
      exportName: 'logEvent',
      argsSchemaSource: '{}',
      handlerSource: 'async () => {}',
      databaseName: 'analytics',
      sourceFile: 'src/actions/analytics.ts',
      internalActionCalls: [],
      crossDbActionCalls: [],
    };

    const result = transformActionFile({
      ...defaultOptions,
      dbName: 'analytics',
      database: globalDatabase,
      code,
      actionsInFile: [logEventAction],
    });

    expect(result!.code).toContain('instanceKey = "global"');
  });

  it('uses tenantIdPath for per-tenant databases', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('ctx.session.tenantId');
  });

  it('transforms multiple actions', () => {
    const code = `
export const createUser = action({ args: {}, handler: async () => {} });
export const getUser = action({ args: {}, handler: async () => {} });
`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction, getUserAction],
    });

    expect(result!.code).toContain('export async function createUser');
    expect(result!.code).toContain('export async function getUser');
    expect(result!.code).toContain('registerAction("main", "createUser"');
    expect(result!.code).toContain('registerAction("main", "getUser"');
  });

  it('preserves non-action exports', () => {
    const code = `
export const createUser = action({ args: {}, handler: async () => {} });
export const SOME_CONSTANT = 42;
`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('export const SOME_CONSTANT = 42');
  });

  it('returns sourcemap', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      sourceFileName: 'test.ts',
      actionsInFile: [createUserAction],
    });

    expect(result!.map).toBeDefined();
  });
});
