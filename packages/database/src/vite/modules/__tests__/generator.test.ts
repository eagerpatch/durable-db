import { describe, it, expect } from 'vitest';
import { generateRpcStubs, generateDurableObjectsModule, generateReExportModule } from '../generator';
import type { DatabaseInfo, ActionInfo } from '../../../db/types';

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
      sourceFile: '/src/databases/main.js',
      internalActionCalls: [],
      crossDbActionCalls: [],
    },
    {
      exportName: 'getUser',
      argsSchemaSource: `{ id: 'string' }`,
      handlerSource: `async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst()`,
      databaseName: 'main',
      sourceFile: '/src/databases/main.js',
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

    it('passes instanceKey in RPC calls', () => {
      const result = generateRpcStubs(mockDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('instanceKey: ctx.session.shop');
    });

    it('passes global instanceKey for global databases', () => {
      const globalDatabase = { ...mockDatabase, instance: 'global' as const };
      const result = generateRpcStubs(globalDatabase, mockActions, {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain("instanceKey: 'global'");
    });

    it('returns comment when no actions defined', () => {
      const result = generateRpcStubs(mockDatabase, [], {
        contextImport: '@shoplayer/database/context',
        shopIdPath: 'session.shop',
      });

      expect(result).toContain('No actions defined');
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

    it('generates methods for each action with rpcContext parameter', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('async createUser(args: unknown, rpcContext?: { instanceKey?: string })');
      expect(result).toContain('async getUser(args: unknown, rpcContext?: { instanceKey?: string })');
    });

    it('includes validation logic in methods', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('const validator = type(');
      expect(result).toContain('validator(args)');
      expect(result).toContain('type.errors');
    });

    it('includes instanceKey in context', () => {
      const actionsByDatabase = new Map([['main', mockActions]]);
      const result = generateDurableObjectsModule([mockDatabase], actionsByDatabase, mockActions);

      expect(result).toContain('instanceKey: rpcContext?.instanceKey');
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
      expect(result).toContain('internal calls');
    });

    it('transforms cross-DB action calls to RPC calls', () => {
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

      const actionsWithCrossDbCalls: ActionInfo[] = [
        {
          exportName: 'createUserWithAnalytics',
          argsSchemaSource: `{ name: 'string' }`,
          handlerSource: `async (db, args) => {
            const user = await db.insertInto('users').values(args).execute();
            await logEvent({ type: 'user_created' });
            return user;
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: ['logEvent'],
        },
      ];

      const allActions = [...actionsWithCrossDbCalls, ...analyticsActions];
      const actionsByDatabase = new Map([
        ['main', actionsWithCrossDbCalls],
        ['analytics', analyticsActions],
      ]);
      const result = generateDurableObjectsModule([mockDatabase, analyticsDb], actionsByDatabase, allActions);

      // Should transform the cross-DB call to an RPC call
      expect(result).toContain('cross-DB calls');
      expect(result).toContain('ANALYTICS_DATABASE_DO');
      expect(result).toContain('idFromName');
      expect(result).toContain('instanceKey');
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
  });
});
