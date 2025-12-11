import { describe, it, expect } from 'vitest';
import { generateRpcStubs, generateDurableObjectsModule, generateReExportModule } from '../../../src/vite/modules/generator';
import type { DatabaseInfo, ActionInfo } from '../../../src/db/types';

describe('generator', () => {
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

  const mockActions: ActionInfo[] = [
    {
      exportName: 'createUser',
      argsSchemaSource: `{ name: 'string', email: 'string.email' }`,
      handlerSource: `async (db, args) => db.insertInto('users').values({ name: args.name }).execute()`,
      databaseName: 'main',
      sourceFile: 'src/databases/actions/createUser.ts',
      internalActionCalls: [],
      crossDbActionCalls: [],
    },
    {
      exportName: 'getUser',
      argsSchemaSource: `{ id: 'string' }`,
      handlerSource: `async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst()`,
      databaseName: 'main',
      sourceFile: 'src/databases/actions/getUser.ts',
      internalActionCalls: [],
      crossDbActionCalls: [],
    },
  ];

  describe('generateRpcStubs', () => {
    it('generates stub functions for each action', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('export async function createUser');
      expect(result).toContain('export async function getUser');
    });

    it('imports getContext from the context module', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain("import { getContext } from '@shoplayer/database/context'");
    });

    it('uses per-shop ID strategy by default', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('idFromName(ctx.session.shop)');
    });

    it('uses global ID strategy when configured', () => {
      const globalDatabase = { ...mockDatabase, instance: 'global' as const };
      const result = generateRpcStubs(globalDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain("idFromName('global')");
    });

    it('returns comment when no actions defined', () => {
      const result = generateRpcStubs(mockDatabase, [], {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('No actions defined');
    });

    it('uses correct binding name format', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('env.MAIN_DATABASE_DO');
    });

    it('includes arktype validation', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain("import { type } from 'arktype'");
      expect(result).toContain('argsSchema');
    });

    it('includes source file in JSDoc', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('@source');
      expect(result).toContain('createUser.ts');
    });

    it('includes source file in error messages in DO module', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('defined in');
      expect(result).toContain('createUser.ts');
    });

    it('generates direct RPC calls not fetch', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('stub.createUser(');
      expect(result).toContain('stub.getUser(');
      expect(result).not.toContain('stub.fetch');
    });

    it('only passes instanceKey for actions with cross-DB calls', () => {
      const actionsWithCrossDb: ActionInfo[] = [
        {
          exportName: 'simpleAction',
          argsSchemaSource: `{ id: 'string' }`,
          handlerSource: `async (db, args) => db.selectFrom('users').execute()`,
          databaseName: 'main',
          sourceFile: 'src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [], // No cross-DB calls
        },
        {
          exportName: 'crossDbAction',
          argsSchemaSource: `{ id: 'string' }`,
          handlerSource: `async (db, args) => { await logEvent({}); }`,
          databaseName: 'main',
          sourceFile: 'src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: ['logEvent'], // Has cross-DB calls
        },
      ];

      const result = generateRpcStubs(mockDatabase, actionsWithCrossDb, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      // simpleAction should NOT have instanceKey
      expect(result).toMatch(/stub\.simpleAction\(validatedArgs\)/);
      // crossDbAction should have instanceKey
      expect(result).toMatch(/stub\.crossDbAction\(validatedArgs,\s*\{\s*instanceKey/);
    });
  });

  describe('generateDurableObjectsModule', () => {
    it('generates DO class that extends SqliteDurableObject', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('extends SqliteDurableObject');
      expect(result).toContain('class MainDatabaseDO');
    });

    it('imports SqliteDurableObject and arktype', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain("import { SqliteDurableObject } from '@shoplayer/database/db'");
      expect(result).toContain("import { type } from 'arktype'");
    });

    it('generates methods for each action', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('async createUser(args: unknown');
      expect(result).toContain('async getUser(args: unknown');
    });

    it('includes validation logic in methods', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('const validator = type(');
      expect(result).toContain('validator(args)');
    });

    it('exports the DO class', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('export class MainDatabaseDO');
    });

    it('transforms internal action calls to this.*', () => {
      const actionsWithInternalCalls: ActionInfo[] = [
        {
          exportName: 'getUser',
          argsSchemaSource: `{ id: 'string' }`,
          handlerSource: `async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst()`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
        {
          exportName: 'createUserIfNotExists',
          argsSchemaSource: `{ name: 'string', email: 'string' }`,
          handlerSource: `async (db, args) => {
            const existing = await getUser({ id: args.email });
            if (existing) return existing;
            return db.insertInto('users').values(args).execute();
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: ['getUser'],
          crossDbActionCalls: [],
        },
      ];

      const actionsByDatabase = new Map([['main', actionsWithInternalCalls]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, actionsWithInternalCalls);

      // The handler should have getUser transformed to this.getUser
      expect(result).toContain('this.getUser');
    });

    it('generates migrations property', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('migrations =');
    });

    it('handles multiple databases', () => {
      const analyticsDb: DatabaseInfo = {
        filePath: '/src/databases/analytics.js',
        name: 'analytics',
        className: 'AnalyticsDatabaseDO',
        bindingName: 'ANALYTICS_DATABASE_DO',
        instance: 'global',
        migrationsDir: './migrations',
        schemaImport: './schema',
        schemaTableNames: ['events'],
      };

      const analyticsActions: ActionInfo[] = [
        {
          exportName: 'logEvent',
          argsSchemaSource: `{ type: 'string' }`,
          handlerSource: `async (db, args) => db.insertInto('events').values(args).execute()`,
          databaseName: 'analytics',
          sourceFile: '/src/databases/analytics.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
      ];

      const allActions = [...mockActions, ...analyticsActions];
      const actionsByDatabase = new Map([
        ['main', mockActions],
        ['analytics', analyticsActions],
      ]);
      const result = generateDurableObjectsModule([mockDatabase, analyticsDb], actionsByDatabase, allActions);

      expect(result).toContain('class MainDatabaseDO');
      expect(result).toContain('class AnalyticsDatabaseDO');
    });

    it('handles database with no actions', () => {
      const actionsByDatabase = new Map([['main', [] as ActionInfo[]]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, []);

      expect(result).toContain('class MainDatabaseDO');
    });
  });

  describe('generateReExportModule', () => {
    it('generates re-export statement for actions', () => {
      const result = generateReExportModule('main', mockActions);

      expect(result).toBe("export { createUser, getUser } from 'shoplayer/databases/main';");
    });

    it('returns comment when no actions', () => {
      const result = generateReExportModule('main', []);

      expect(result).toContain('No actions to re-export');
    });

    it('handles single action', () => {
      const singleAction = [mockActions[0]];
      const result = generateReExportModule('main', singleAction);

      expect(result).toBe("export { createUser } from 'shoplayer/databases/main';");
    });

    it('preserves action order', () => {
      const result = generateReExportModule('main', mockActions);

      const createUserIndex = result.indexOf('createUser');
      const getUserIndex = result.indexOf('getUser');
      expect(createUserIndex).toBeLessThan(getUserIndex);
    });
  });
});
