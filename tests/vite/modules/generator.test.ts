import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  generateDurableObjectsModule,
  transformActionFile,
  transformDatabaseFile,
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
  transport: 'rpc',
  migrationsDir: '',
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

const wsDatabase: DatabaseInfo = {
  ...mockDatabase,
  name: 'events',
  className: 'EventsDatabaseDO',
  bindingName: 'EVENTS_DATABASE_DO',
  transport: 'websocket',
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
  it('imports SqliteDurableObject and type from db', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toMatch(/import\s*\{[^}]*SqliteDurableObject[^}]*\}\s*from\s*["']durable-db\/db["']/);
    expect(code).toMatch(/import\s*\{[^}]*type[^}]*\}\s*from\s*["']durable-db\/db["']/);
  });

  it('imports from registry module', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toMatch(/import\s*\{[^}]*getAction[^}]*\}\s*from\s*["']durable-db\/registry["']/);
    expect(code).toMatch(/import\s*\{[^}]*runWithDoContext[^}]*\}\s*from\s*["']durable-db\/registry["']/);
  });

  it('generates class extending SqliteDurableObject', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('class MainDatabaseDO extends SqliteDurableObject');
  });

  it('includes migrations property', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('migrations = {}');
  });

  it('generates rpc method', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('async rpc(method, args, rpcContext)');
  });

  it('includes getAction call', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('getAction("main", method)');
  });

  it('includes runWithDoContext', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('runWithDoContext(');
  });

  it('handles multiple databases', () => {
    const code = generateDurableObjectsModule([mockDatabase, globalDatabase], 'durable-db/registry');
    expect(code).toContain('class MainDatabaseDO');
    expect(code).toContain('class AnalyticsDO');
  });

  it('generates binding names object', () => {
    const code = generateDurableObjectsModule([mockDatabase, globalDatabase], 'durable-db/registry');
    // Check that both bindings are present (format may vary)
    expect(code).toMatch(/["']main["']\s*:\s*["']MAIN_DATABASE_DO["']/);
    expect(code).toMatch(/["']analytics["']\s*:\s*["']ANALYTICS_DO["']/);
  });

  it('wraps class with Browsable() when browsable is true', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: true };
    const code = generateDurableObjectsModule([db], 'durable-db/registry', false);
    expect(code).toContain('Browsable');
    expect(code).toContain('_MainDatabaseDO_Base');
    // Should have migration guard overrides for fetch and __studio
    expect(code).toContain('ensureMigrations');
    expect(code).toContain('__studio');
  });

  it('wraps class with Browsable() when browsable is "development" and isDev', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: 'development' };
    const code = generateDurableObjectsModule([db], 'durable-db/registry', true);
    expect(code).toContain('Browsable');
    expect(code).toContain('_MainDatabaseDO_Base');
  });

  it('does not use Browsable() when browsable is "development" and not isDev', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: 'development' };
    const code = generateDurableObjectsModule([db], 'durable-db/registry', false);
    expect(code).not.toContain('Browsable');
    expect(code).not.toContain('_MainDatabaseDO_Base');
  });

  it('does not use Browsable() when browsable is false', () => {
    const db: DatabaseInfo = { ...mockDatabase, browsable: false };
    const code = generateDurableObjectsModule([db], 'durable-db/registry', true);
    expect(code).not.toContain('Browsable');
  });

  it('includes migrations when provided', () => {
    const dbWithMigrations: DatabaseInfo = {
      ...mockDatabase,
      migrations: new Map([['001_init', [['CREATE TABLE users (id TEXT)']]]]),
    };
    const code = generateDurableObjectsModule([dbWithMigrations], 'durable-db/registry');
    expect(code).toContain('001_init');
    expect(code).toContain('chunks');
  });

  it('generates webSocketMessage method when transport is websocket', () => {
    const code = generateDurableObjectsModule([wsDatabase], 'durable-db/registry');
    expect(code).toContain('async webSocketMessage(ws, message)');
    expect(code).toContain('decodeRequest');
    expect(code).toContain('encodeResponse');
  });

  it('imports transport module when any db uses websocket', () => {
    const code = generateDurableObjectsModule([wsDatabase], 'durable-db/registry');
    expect(code).toMatch(/import\s*\{[^}]*decodeRequest[^}]*\}\s*from\s*["']durable-db\/transport\/protocol["']/);
    expect(code).toMatch(/import\s*\{[^}]*encodeResponse[^}]*\}\s*from\s*["']durable-db\/transport\/protocol["']/);
  });

  it('does not import transport module when no db uses websocket', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).not.toContain('durable-db/transport/');
  });

  it('still generates rpc method for websocket databases', () => {
    const code = generateDurableObjectsModule([wsDatabase], 'durable-db/registry');
    expect(code).toContain('async rpc(method, args, rpcContext)');
    expect(code).toContain('async webSocketMessage(ws, message)');
  });

  it('does not generate webSocketMessage for rpc databases', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).not.toContain('webSocketMessage');
  });

  it('generates dbTransports in ctx object', () => {
    const code = generateDurableObjectsModule([mockDatabase, wsDatabase], 'durable-db/registry');
    expect(code).toContain('dbTransports');
  });
});

// ============================================================================
// transformActionFile
// ============================================================================

describe('transformActionFile', () => {
  const defaultOptions = {
    dbName: 'main',
    database: mockDatabase,
    contextImport: 'durable-db/context',
    registryImport: 'durable-db/registry',
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

    expect(result!.code).toMatch(/import\s*\{[^}]*getTenantId[^}]*\}\s*from\s*["']durable-db\/context["']/);
  });

  it('adds cloudflare:workers env import', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*env[^}]*\}\s*from\s*["']cloudflare:workers["']/);
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
    expect(result!.code).toContain('callAction');
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
    expect(result!.code).toContain('callAction');
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

    expect(result!.code).toContain('instanceKey = applyDevEpoch("global")');
  });

  it('uses getTenantId() for per-tenant databases', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('getTenantId()');
  });

  it('routes every instance key through applyDevEpoch', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).toContain('instanceKey = applyDevEpoch(getTenantId())');
    expect(result!.code).toMatch(
      /import\s*\{[^}]*applyDevEpoch[^}]*\}\s*from\s*["']virtual:durable-db\/__devEpoch["']/
    );
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

  it('generates WebSocketTransport call for websocket databases', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      database: wsDatabase,
      dbName: 'events',
      code,
      actionsInFile: [{
        ...createUserAction,
        databaseName: 'events',
      }],
    });

    expect(result!.code).toContain('WebSocketTransport');
    expect(result!.code).toContain('wsTransport.call');
    expect(result!.code).not.toContain('stub.rpc');
  });

  it('imports WebSocketTransport for websocket databases', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      database: wsDatabase,
      dbName: 'events',
      code,
      actionsInFile: [{
        ...createUserAction,
        databaseName: 'events',
      }],
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*WebSocketTransport[^}]*\}\s*from\s*["']durable-db\/transport\/websocket["']/);
  });

  it('does not import WebSocketTransport for rpc databases', () => {
    const code = `export const createUser = action({ args: {}, handler: async () => {} });`;
    const result = transformActionFile({
      ...defaultOptions,
      code,
      actionsInFile: [createUserAction],
    });

    expect(result!.code).not.toContain('WebSocketTransport');
  });
});

// ============================================================================
// generateDurableObjectsModule - sys method
// ============================================================================

describe('generateDurableObjectsModule - sys method', () => {
  it('generates sys method on DO class', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('async sys(command)');
  });

  it('sys method handles destroyDatabase command', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('command === "destroyDatabase"');
    expect(code).toContain('this.ctx.storage.deleteAll()');
    expect(code).toContain('this.resetMigrationState()');
  });

  it('sys method throws on unknown command', () => {
    const code = generateDurableObjectsModule([mockDatabase], 'durable-db/registry');
    expect(code).toContain('Unknown system command');
  });
});

// ============================================================================
// transformDatabaseFile
// ============================================================================

describe('transformDatabaseFile', () => {
  const defaultDbFileOptions = {
    database: mockDatabase,
    contextImport: 'durable-db/context',
  };

  it('returns null when destroyDatabase is not destructured', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
    });

    expect(result).toBeNull();
  });

  it('generates destroyDatabase stub for per-tenant database', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users },
});
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
    });

    expect(result).not.toBeNull();
    expect(result!.code).toContain('export async function destroyDatabase');
    expect(result!.code).toContain('getTenantId()');
    expect(result!.code).toContain('env.MAIN_DATABASE_DO.idFromName(instanceKey)');
    expect(result!.code).toContain('stub.sys("destroyDatabase")');
  });

  it('generates destroyDatabase stub for global database', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users },
});
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      database: globalDatabase,
      code,
    });

    expect(result).not.toBeNull();
    expect(result!.code).toContain('export async function destroyDatabase');
    expect(result!.code).toContain('instanceKey = applyDevEpoch("global")');
    expect(result!.code).not.toContain('getTenantId');
  });

  it('removes destroyDatabase from destructuring pattern', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users },
});
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
    });

    expect(result).not.toBeNull();
    // The destructuring should no longer contain destroyDatabase
    // It should have `{ action }` without destroyDatabase
    expect(result!.code).toMatch(/const\s*\{\s*action\s*\}\s*=\s*defineDatabase/);
  });

  it('adds cloudflare:workers env import', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
export const { action, destroyDatabase } = defineDatabase({ schema: {} });
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*env[^}]*\}\s*from\s*["']cloudflare:workers["']/);
  });

  it('adds context import for per-tenant database', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
export const { action, destroyDatabase } = defineDatabase({ schema: {} });
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
    });

    expect(result!.code).toMatch(/import\s*\{[^}]*getTenantId[^}]*\}\s*from\s*["']durable-db\/context["']/);
  });

  it('does not add context import for global database', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
export const { action, destroyDatabase } = defineDatabase({ schema: {} });
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      database: globalDatabase,
      code,
    });

    expect(result!.code).not.toContain('getTenantId');
  });

  it('returns sourcemap', () => {
    const code = `
import { defineDatabase } from 'durable-db/db';
export const { action, destroyDatabase } = defineDatabase({ schema: {} });
`;
    const result = transformDatabaseFile({
      ...defaultDbFileOptions,
      code,
      sourceFileName: 'test.ts',
    });

    expect(result!.map).toBeDefined();
  });

  describe('same-file actions', () => {
    const dbFileWithAction = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});

export const createUser = action({
  args: { name: 'string', email: 'string.email' },
  handler: async (db, args) => db.insertInto('users').values(args).execute(),
});
`;

    it('rewrites same-file action() definitions into RPC stubs', () => {
      const result = transformDatabaseFile({
        ...defaultDbFileOptions,
        code: dbFileWithAction,
        actionsInFile: [createUserAction],
        registryImport: 'durable-db/registry',
      });

      expect(result).not.toBeNull();
      expect(result!.code).toContain('export async function createUser(args)');
      expect(result!.code).toContain('registerAction("main", "createUser"');
      expect(result!.code).toContain('env.MAIN_DATABASE_DO.idFromName(instanceKey)');
      expect(result!.code).toContain('stub.rpc("createUser", validatedArgs');
      // The original placeholder call-site must be gone
      expect(result!.code).not.toContain('createUser = action(');
    });

    it('adds the imports the stub needs', () => {
      const result = transformDatabaseFile({
        ...defaultDbFileOptions,
        code: dbFileWithAction,
        actionsInFile: [createUserAction],
        registryImport: 'durable-db/registry',
      });

      expect(result!.code).toMatch(/import\s*\{[^}]*type[^}]*\}\s*from\s*["']arktype["']/);
      expect(result!.code).toMatch(/import\s*\{[^}]*env[^}]*\}\s*from\s*["']cloudflare:workers["']/);
      expect(result!.code).toMatch(/import\s*\{[^}]*registerAction[^}]*\}\s*from\s*["']durable-db\/registry["']/);
    });

    it('transforms both destroyDatabase and same-file actions together', () => {
      const code = `
import { defineDatabase } from 'durable-db/db';
import { users } from './schema';

export const { action, destroyDatabase } = defineDatabase({
  schema: { users },
});

export const createUser = action({
  args: { name: 'string', email: 'string.email' },
  handler: async (db, args) => db.insertInto('users').values(args).execute(),
});
`;
      const result = transformDatabaseFile({
        ...defaultDbFileOptions,
        code,
        actionsInFile: [createUserAction],
        registryImport: 'durable-db/registry',
      });

      expect(result).not.toBeNull();
      expect(result!.code).toContain('export async function destroyDatabase');
      expect(result!.code).toContain('export async function createUser(args)');
      expect(result!.code).toContain('stub.sys("destroyDatabase")');
    });
  });
});
