import { describe, it, expect } from 'vitest';
import {
  parseDatabaseFile,
  toPascalCase,
  toScreamingSnakeCase,
  findActionCallsInSource,
  transformHandlerForDO,
  resolveInternalActionCalls
} from '../parser';

describe('parser', () => {
  describe('toPascalCase', () => {
    it('converts kebab-case to PascalCase', () => {
      expect(toPascalCase('my-database')).toBe('MyDatabase');
    });

    it('converts snake_case to PascalCase', () => {
      expect(toPascalCase('my_database')).toBe('MyDatabase');
    });

    it('handles single word', () => {
      expect(toPascalCase('main')).toBe('Main');
    });
  });

  describe('toScreamingSnakeCase', () => {
    it('converts kebab-case to SCREAMING_SNAKE_CASE', () => {
      expect(toScreamingSnakeCase('my-database')).toBe('MY_DATABASE');
    });

    it('converts camelCase to SCREAMING_SNAKE_CASE', () => {
      expect(toScreamingSnakeCase('myDatabase')).toBe('MY_DATABASE');
    });

    it('handles single word', () => {
      expect(toScreamingSnakeCase('main')).toBe('MAIN');
    });
  });

  describe('findActionCallsInSource', () => {
    it('finds direct action calls in handler', () => {
      const source = `async (db, args) => {
        const user = await getUser({ id: args.userId });
        return user;
      }`;
      const knownActions = new Set(['getUser', 'createUser', 'deleteUser']);

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toEqual(['getUser']);
    });

    it('finds multiple action calls', () => {
      const source = `async (db, args) => {
        const user = await getUser({ id: args.userId });
        await logEvent({ type: 'viewed' });
        return user;
      }`;
      const knownActions = new Set(['getUser', 'logEvent', 'createUser']);

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toContain('getUser');
      expect(calls).toContain('logEvent');
    });

    it('ignores non-action function calls', () => {
      const source = `async (db, args) => {
        const result = await someOtherFunction();
        console.log(result);
        return result;
      }`;
      const knownActions = new Set(['getUser', 'createUser']);

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toEqual([]);
    });
  });

  describe('transformHandlerForDO', () => {
    it('transforms action calls to this.actionName()', () => {
      const source = `async (db, args) => {
        const user = await getUser({ id: args.userId });
        return user;
      }`;

      const transformed = transformHandlerForDO(source, ['getUser']);
      expect(transformed).toContain('this.getUser');
      expect(transformed).not.toMatch(/(?<!this\.)getUser\(/);
    });

    it('transforms multiple action calls', () => {
      const source = `async (db, args) => {
        const user = await getUser({ id: args.userId });
        await logEvent({ type: 'created' });
        return user;
      }`;

      const transformed = transformHandlerForDO(source, ['getUser', 'logEvent']);
      expect(transformed).toContain('this.getUser');
      expect(transformed).toContain('this.logEvent');
    });

    it('returns original if no actions to transform', () => {
      const source = `async (db, args) => db.selectFrom('users').execute()`;
      const transformed = transformHandlerForDO(source, []);
      expect(transformed).toBe(source);
    });
  });

  describe('resolveInternalActionCalls', () => {
    it('detects action calls between actions in same database', () => {
      const actions = [
        {
          exportName: 'getUser',
          argsSchemaSource: `{ id: 'string' }`,
          handlerSource: `async (db, args) => db.selectFrom('users').execute()`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
        {
          exportName: 'createUser',
          argsSchemaSource: `{ name: 'string', email: 'string' }`,
          handlerSource: `async (db, args) => {
            const existing = await getUser({ id: args.email });
            if (existing) return null;
            return db.insertInto('users').values(args).execute();
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
      ];

      resolveInternalActionCalls(actions, actions);

      expect(actions[0].internalActionCalls).toEqual([]);
      expect(actions[0].crossDbActionCalls).toEqual([]);
      expect(actions[1].internalActionCalls).toEqual(['getUser']);
      expect(actions[1].crossDbActionCalls).toEqual([]);
    });

    it('detects cross-database action calls', () => {
      const mainDbActions = [
        {
          exportName: 'createUser',
          argsSchemaSource: `{ name: 'string' }`,
          handlerSource: `async (db, args) => {
            const user = await db.insertInto('users').values(args).execute();
            await logEvent({ type: 'user_created' });
            return user;
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
      ];

      const analyticsDbActions = [
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

      const allActions = [...mainDbActions, ...analyticsDbActions];
      resolveInternalActionCalls(mainDbActions, allActions);

      expect(mainDbActions[0].internalActionCalls).toEqual([]);
      expect(mainDbActions[0].crossDbActionCalls).toEqual(['logEvent']);
    });

    it('excludes self-recursive calls', () => {
      const actions = [
        {
          exportName: 'processItems',
          argsSchemaSource: `{ items: 'string[]' }`,
          handlerSource: `async (db, args) => {
            if (args.items.length > 10) {
              await processItems({ items: args.items.slice(10) });
            }
            return db.insertInto('items').values(args.items.slice(0, 10)).execute();
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
      ];

      resolveInternalActionCalls(actions, actions);

      // Self-calls should not be in either list
      expect(actions[0].internalActionCalls).toEqual([]);
      expect(actions[0].crossDbActionCalls).toEqual([]);
    });

    it('separates internal and cross-DB calls correctly', () => {
      const mainDbActions = [
        {
          exportName: 'getUser',
          argsSchemaSource: `{ id: 'string' }`,
          handlerSource: `async (db, args) => db.selectFrom('users').execute()`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
        {
          exportName: 'createUserWithAnalytics',
          argsSchemaSource: `{ name: 'string' }`,
          handlerSource: `async (db, args) => {
            const existing = await getUser({ id: args.name });
            if (existing) return existing;
            const user = await db.insertInto('users').values(args).execute();
            await logEvent({ type: 'user_created' });
            return user;
          }`,
          databaseName: 'main',
          sourceFile: '/src/databases/main.js',
          internalActionCalls: [],
          crossDbActionCalls: [],
        },
      ];

      const analyticsDbActions = [
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

      const allActions = [...mainDbActions, ...analyticsDbActions];
      resolveInternalActionCalls(mainDbActions, allActions);

      // createUserWithAnalytics calls getUser (same DB) and logEvent (different DB)
      expect(mainDbActions[1].internalActionCalls).toEqual(['getUser']);
      expect(mainDbActions[1].crossDbActionCalls).toEqual(['logEvent']);
    });
  });

  describe('parseDatabaseFile', () => {
    it('extracts database configuration from defineDatabase call', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users, posts } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users, posts },
          instance: 'per-shop',
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.database).not.toBeNull();
      expect(result.database!.name).toBe('main');
      expect(result.database!.className).toBe('MainDatabaseDO');
      expect(result.database!.bindingName).toBe('MAIN_DATABASE_DO');
      expect(result.database!.instance).toBe('per-shop');
      expect(result.database!.migrationsDir).toBe('./migrations');
      expect(result.database!.schemaImport).toBe('./schema');
      expect(result.database!.schemaTableNames).toEqual(['users', 'posts']);
    });

    it('extracts action definitions', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
        });

        export const createUser = action({
          args: {
            name: 'string',
            email: 'string.email',
          },
          handler: async (db, args) => {
            return db.insertInto('users').values({
              id: crypto.randomUUID(),
              name: args.name,
              email: args.email,
            }).execute();
          },
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].exportName).toBe('createUser');
      expect(result.actions[0].databaseName).toBe('main');
      expect(result.actions[0].argsSchemaSource).toContain("'string'");
      expect(result.actions[0].argsSchemaSource).toContain("'string.email'");
      expect(result.actions[0].handlerSource).toContain('insertInto');
    });

    it('extracts multiple actions', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
        });

        export const createUser = action({
          args: { name: 'string' },
          handler: async (db, args) => db.insertInto('users').values({ name: args.name }).execute(),
        });

        export const getUser = action({
          args: { id: 'string' },
          handler: async (db, args) => db.selectFrom('users').where('id', '=', args.id).executeTakeFirst(),
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.actions).toHaveLength(2);
      expect(result.actions.map(a => a.exportName)).toEqual(['createUser', 'getUser']);
    });

    it('tracks imports for dependency resolution', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users, posts } from './schema';
        import { helperFn } from './helpers';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users, posts },
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.localImports.has('defineDatabase')).toBe(true);
      expect(result.localImports.get('defineDatabase')?.source).toBe('@shoplayer/database/db');

      expect(result.localImports.has('users')).toBe(true);
      expect(result.localImports.get('users')?.source).toBe('./schema');

      expect(result.localImports.has('helperFn')).toBe(true);
      expect(result.localImports.get('helperFn')?.source).toBe('./helpers');
    });

    it('handles global instance strategy', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { settings } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { settings },
          instance: 'global',
        });
      `;

      const result = parseDatabaseFile('/src/databases/settings.js', code);

      expect(result.database!.instance).toBe('global');
    });

    it('handles renamed action factory', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action: createAction } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
        });

        export const createUser = createAction({
          args: { name: 'string' },
          handler: async (db, args) => db.insertInto('users').values({ name: args.name }).execute(),
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].exportName).toBe('createUser');
    });
  });
});
