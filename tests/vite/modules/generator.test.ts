import { describe, it, expect } from 'vitest';
import * as t from '@babel/types';
import {
  // Public API
  generateRpcStubs,
  generateDurableObjectsModule,
  generateReExportModule,
  // AST Utilities
  parseExpression,
  parseMemberPath,
  createNamedImport,
  createReExport,
  generateFromStatements,
  // Builders - RPC Stubs
  buildIdStrategy,
  buildRpcCall,
  buildStubBodyStatements,
  buildStubFunction,
  // Builders - DO Methods
  transformHandler,
  buildMethodContextStatement,
  buildDOMethod,
  buildMigrationsObject,
  buildDOClass,
  // Builders - Cross-DB
  buildCrossDbContext,
  // Types
  type StubConfig,
  type MethodConfig,
  type CrossDbContext,
} from '../../../src/vite/modules/generator';
import type { DatabaseInfo, ActionInfo } from '../../../src/db/types';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockDatabase: DatabaseInfo = {
  filePath: '/src/databases/main.js',
  name: 'main',
  className: 'MainDatabaseDO',
  bindingName: 'MAIN_DATABASE_DO',
  instance: 'per-shop',
  migrationsDir: './migrations',
  schemaImport: './schema',
  schemaTableNames: ['users', 'posts'],
};

const globalDatabase: DatabaseInfo = {
  ...mockDatabase,
  name: 'analytics',
  className: 'AnalyticsDatabaseDO',
  bindingName: 'ANALYTICS_DATABASE_DO',
  instance: 'global',
};

const simpleAction: ActionInfo = {
  exportName: 'createUser',
  argsSchemaSource: `{ name: 'string', email: 'string.email' }`,
  handlerSource: `async (db, args) => db.insertInto('users').values({ name: args.name }).execute()`,
  databaseName: 'main',
  sourceFile: 'src/databases/actions/createUser.ts',
  internalActionCalls: [],
  crossDbActionCalls: [],
};

const actionWithCrossDbCalls: ActionInfo = {
  exportName: 'createUserWithLog',
  argsSchemaSource: `{ name: 'string' }`,
  handlerSource: `async (db, args) => db.insertInto('users').values(args).execute()`,
  databaseName: 'main',
  sourceFile: 'src/databases/actions/createUserWithLog.ts',
  internalActionCalls: [],
  crossDbActionCalls: ['logEvent'],
};

const actionWithoutSourceFile: ActionInfo = {
  exportName: 'getUser',
  argsSchemaSource: `{ id: 'string' }`,
  handlerSource: `async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst()`,
  databaseName: 'main',
  sourceFile: undefined as unknown as string, // Test case for missing sourceFile
  internalActionCalls: [],
  crossDbActionCalls: [],
};

const mockActions: ActionInfo[] = [simpleAction, actionWithoutSourceFile];

const emptyCrossDbContext: CrossDbContext = {
  actionToDatabase: new Map(),
};

// Context with logEvent mapped to globalDatabase (for cross-DB call tests)
const crossDbContextWithLogEvent: CrossDbContext = {
  actionToDatabase: new Map([['logEvent', globalDatabase]]),
};

// ============================================================================
// AST Utilities Tests
// ============================================================================

describe('parseExpression', () => {
  it('parses member expressions', () => {
    const result = parseExpression('foo.bar');
    expect(t.isMemberExpression(result)).toBe(true);
  });

  it('parses function calls', () => {
    const result = parseExpression('foo()');
    expect(t.isCallExpression(result)).toBe(true);
  });

  it('parses object literals', () => {
    const result = parseExpression('{ a: 1, b: 2 }');
    expect(t.isObjectExpression(result)).toBe(true);
  });

  it('parses arrow functions', () => {
    const result = parseExpression('async (db, args) => db.query()');
    expect(t.isArrowFunctionExpression(result)).toBe(true);
  });

  it('throws on variable declarations', () => {
    expect(() => parseExpression('const x = 1')).toThrow();
  });
});

describe('parseMemberPath', () => {
  it('builds simple path', () => {
    const result = parseMemberPath(t.identifier('ctx'), 'shop');
    const code = generateFromStatements([t.expressionStatement(result)]);
    expect(code).toContain('ctx.shop');
  });

  it('builds nested path', () => {
    const result = parseMemberPath(t.identifier('ctx'), 'session.shop');
    const code = generateFromStatements([t.expressionStatement(result)]);
    expect(code).toContain('ctx.session.shop');
  });

  it('builds deeply nested path', () => {
    const result = parseMemberPath(t.identifier('ctx'), 'a.b.c.d');
    const code = generateFromStatements([t.expressionStatement(result)]);
    expect(code).toContain('ctx.a.b.c.d');
  });
});

describe('createNamedImport', () => {
  it('creates import with single specifier', () => {
    const result = createNamedImport(['foo'], 'bar');
    expect(t.isImportDeclaration(result)).toBe(true);
    expect(result.specifiers).toHaveLength(1);
  });

  it('generates correct code', () => {
    const result = createNamedImport(['getContext'], '@shoplayer/database/context');
    const code = generateFromStatements([result]);
    expect(code).toContain('import { getContext }');
    expect(code).toContain('@shoplayer/database/context');
  });
});

describe('createReExport', () => {
  it('creates export with specifiers', () => {
    const result = createReExport(['foo', 'bar'], 'source');
    expect(t.isExportNamedDeclaration(result)).toBe(true);
    expect(result.specifiers).toHaveLength(2);
  });

  it('generates correct code', () => {
    const result = createReExport(['createUser', 'getUser'], 'shoplayer/databases/main');
    const code = generateFromStatements([result]);
    expect(code).toContain('export { createUser, getUser }');
  });
});

// ============================================================================
// RPC Stub Builder Tests
// ============================================================================

describe('buildIdStrategy', () => {
  it('uses global for global instance', () => {
    const result = buildIdStrategy(globalDatabase, 'session.shop');
    const code = generateFromStatements([t.expressionStatement(result)]);
    expect(code).toContain('"global"');
  });

  it('uses ctx path for per-shop instance', () => {
    const result = buildIdStrategy(mockDatabase, 'session.shop');
    const code = generateFromStatements([t.expressionStatement(result)]);
    expect(code).toContain('ctx.session.shop');
  });

  it('returns CallExpression', () => {
    const result = buildIdStrategy(mockDatabase, 'session.shop');
    expect(t.isCallExpression(result)).toBe(true);
  });
});

describe('buildRpcCall', () => {
  it('builds simple call without instanceKey', () => {
    const config: StubConfig = {
      action: simpleAction,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    const code = generateFromStatements([t.expressionStatement(buildRpcCall(config))]);
    expect(code).toContain('stub.createUser(validatedArgs)');
    expect(code).not.toContain('instanceKey');
  });

  it('builds call with instanceKey for cross-DB actions', () => {
    const config: StubConfig = {
      action: actionWithCrossDbCalls,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    const code = generateFromStatements([t.expressionStatement(buildRpcCall(config))]);
    expect(code).toContain('instanceKey');
  });
});

describe('buildStubBodyStatements', () => {
  it('returns array of statements', () => {
    const config: StubConfig = {
      action: simpleAction,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    const result = buildStubBodyStatements(config);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes validation', () => {
    const config: StubConfig = {
      action: simpleAction,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    const code = generateFromStatements(buildStubBodyStatements(config));
    expect(code).toContain('argsSchema');
    expect(code).toContain('type(');
  });
});

describe('buildStubFunction', () => {
  it('returns ExportNamedDeclaration', () => {
    const config: StubConfig = {
      action: simpleAction,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    expect(t.isExportNamedDeclaration(buildStubFunction(config))).toBe(true);
  });

  it('generates async exported function', () => {
    const config: StubConfig = {
      action: simpleAction,
      database: mockDatabase,
      shopIdPath: 'session.shop',
    };
    const code = generateFromStatements([buildStubFunction(config)]);
    expect(code).toContain('export async function createUser');
  });
});

// ============================================================================
// DO Method Builder Tests
// ============================================================================

describe('buildMethodContextStatement', () => {
  it('returns null for simple actions', () => {
    expect(buildMethodContextStatement(simpleAction)).toBeNull();
  });

  it('returns statement for cross-DB actions', () => {
    const result = buildMethodContextStatement(actionWithCrossDbCalls);
    expect(result).not.toBeNull();
    const code = generateFromStatements([result!]);
    expect(code).toContain('const ctx');
  });
});

describe('buildDOMethod', () => {
  it('returns ClassMethod', () => {
    const config: MethodConfig = {
      action: simpleAction,
      crossDbContext: emptyCrossDbContext,
    };
    expect(t.isClassMethod(buildDOMethod(config))).toBe(true);
  });

  it('is async', () => {
    const config: MethodConfig = {
      action: simpleAction,
      crossDbContext: emptyCrossDbContext,
    };
    expect(buildDOMethod(config).async).toBe(true);
  });

  it('has one param for simple actions', () => {
    const config: MethodConfig = {
      action: simpleAction,
      crossDbContext: emptyCrossDbContext,
    };
    expect(buildDOMethod(config).params).toHaveLength(1);
  });

  it('has two params for cross-DB actions', () => {
    const config: MethodConfig = {
      action: actionWithCrossDbCalls,
      crossDbContext: crossDbContextWithLogEvent,
    };
    expect(buildDOMethod(config).params).toHaveLength(2);
  });
});

describe('buildMigrationsObject', () => {
  it('returns empty object for undefined', () => {
    const result = buildMigrationsObject(undefined);
    expect((result as t.ObjectExpression).properties).toHaveLength(0);
  });

  it('returns empty object for empty map', () => {
    const result = buildMigrationsObject(new Map());
    expect((result as t.ObjectExpression).properties).toHaveLength(0);
  });

  it('generates migrations with chunks', () => {
    const migrations = new Map([
      ['001_init', [['CREATE TABLE users (id TEXT)']]],
    ]);
    const code = generateFromStatements([t.expressionStatement(buildMigrationsObject(migrations))]);
    expect(code).toContain('001_init');
    expect(code).toContain('chunks');
  });

  it('sorts by name', () => {
    const migrations = new Map([
      ['002_second', [['ALTER']]],
      ['001_first', [['CREATE']]],
    ]);
    const code = generateFromStatements([t.expressionStatement(buildMigrationsObject(migrations))]);
    expect(code.indexOf('001_first')).toBeLessThan(code.indexOf('002_second'));
  });
});

describe('buildDOClass', () => {
  it('returns ExportNamedDeclaration', () => {
    expect(t.isExportNamedDeclaration(buildDOClass(mockDatabase, [], emptyCrossDbContext))).toBe(true);
  });

  it('extends SqliteDurableObject', () => {
    const code = generateFromStatements([buildDOClass(mockDatabase, [], emptyCrossDbContext)]);
    expect(code).toContain('extends SqliteDurableObject');
  });

  it('includes migrations property', () => {
    const code = generateFromStatements([buildDOClass(mockDatabase, [], emptyCrossDbContext)]);
    expect(code).toContain('migrations =');
  });

  it('includes methods', () => {
    const code = generateFromStatements([buildDOClass(mockDatabase, mockActions, emptyCrossDbContext)]);
    expect(code).toContain('createUser');
    expect(code).toContain('getUser');
  });
});

// ============================================================================
// Cross-DB Context Tests
// ============================================================================

describe('buildCrossDbContext', () => {
  it('builds empty context for empty inputs', () => {
    const result = buildCrossDbContext([], new Map());
    expect(result.actionToDatabase.size).toBe(0);
  });

  it('maps actions to databases', () => {
    const actionsByDatabase = new Map([['main', mockActions]]);
    const result = buildCrossDbContext([mockDatabase], actionsByDatabase);
    expect(result.actionToDatabase.get('createUser')).toBe(mockDatabase);
  });
});

// ============================================================================
// Public API Tests
// ============================================================================

describe('generateRpcStubs', () => {
  const options = {
    contextImport: '@shoplayer/database/context',
    shopIdPath: 'session.shop',
  };

  it('generates functions for each action', () => {
    const result = generateRpcStubs(mockDatabase, mockActions, options);
    expect(result).toContain('function createUser');
    expect(result).toContain('function getUser');
  });

  it('imports getContext', () => {
    const result = generateRpcStubs(mockDatabase, mockActions, options);
    expect(result).toContain('import { getContext }');
  });

  it('imports type from arktype', () => {
    const result = generateRpcStubs(mockDatabase, mockActions, options);
    expect(result).toContain('import { type }');
  });

  it('returns comment when no actions', () => {
    const result = generateRpcStubs(mockDatabase, [], options);
    expect(result).toContain('No actions defined');
  });

  it('only passes instanceKey for cross-DB actions', () => {
    const result = generateRpcStubs(mockDatabase, [simpleAction, actionWithCrossDbCalls], options);
    expect(result).toMatch(/stub\.createUser\(validatedArgs\)/);
    expect(result).toContain('stub.createUserWithLog(validatedArgs, {');
  });
});

describe('generateDurableObjectsModule', () => {
  it('generates class extending SqliteDurableObject', () => {
    const actionsByDatabase = new Map([['main', mockActions]]);
    const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);
    expect(result).toContain('extends SqliteDurableObject');
  });

  it('imports dependencies', () => {
    const actionsByDatabase = new Map([['main', mockActions]]);
    const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);
    expect(result).toContain('import { SqliteDurableObject }');
    expect(result).toContain('import { type }');
  });

  it('generates methods', () => {
    const actionsByDatabase = new Map([['main', mockActions]]);
    const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);
    expect(result).toContain('createUser(args');
    expect(result).toContain('getUser(args');
  });

  it('handles multiple databases', () => {
    const analyticsAction: ActionInfo = {
      exportName: 'logEvent',
      argsSchemaSource: `{ type: 'string' }`,
      handlerSource: `async (db, args) => db.insertInto('events').values(args).execute()`,
      databaseName: 'analytics',
      sourceFile: 'src/databases/analytics.ts',
      internalActionCalls: [],
      crossDbActionCalls: [],
    };
    const actionsByDatabase = new Map([
      ['main', mockActions],
      ['analytics', [analyticsAction]],
    ]);
    const result = generateDurableObjectsModule(
      [mockDatabase, globalDatabase],
      actionsByDatabase,
      [...mockActions, analyticsAction]
    );
    expect(result).toContain('class MainDatabaseDO');
    expect(result).toContain('class AnalyticsDatabaseDO');
  });
});

describe('generateReExportModule', () => {
  it('generates re-export', () => {
    const result = generateReExportModule('main', mockActions);
    expect(result).toContain('export { createUser, getUser }');
    expect(result).toContain('shoplayer/databases/main');
  });

  it('returns comment when no actions', () => {
    const result = generateReExportModule('main', []);
    expect(result).toContain('No actions to re-export');
  });

  it('preserves order', () => {
    const result = generateReExportModule('main', mockActions);
    expect(result.indexOf('createUser')).toBeLessThan(result.indexOf('getUser'));
  });
});
