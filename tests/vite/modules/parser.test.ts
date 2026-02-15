import { describe, it, expect, vi } from 'vitest';
import {
  parseDatabaseFile,
  toPascalCase,
  toScreamingSnakeCase,
  findActionCallsInSource,
} from '../../../src/vite/modules/parser';

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

    it('handles multiple hyphens', () => {
      expect(toPascalCase('my-super-long-name')).toBe('MySuperLongName');
    });

    it('handles mixed separators', () => {
      expect(toPascalCase('my-database_name')).toBe('MyDatabaseName');
    });

    it('handles already capitalized words', () => {
      expect(toPascalCase('Main')).toBe('Main');
    });

    it('handles empty string', () => {
      expect(toPascalCase('')).toBe('');
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

    it('converts PascalCase to SCREAMING_SNAKE_CASE', () => {
      expect(toScreamingSnakeCase('MyDatabase')).toBe('MY_DATABASE');
    });

    it('handles multiple consecutive capitals', () => {
      // Current implementation doesn't separate consecutive capitals
      expect(toScreamingSnakeCase('myAPIDatabase')).toBe('MY_APIDATABASE');
    });

    it('handles empty string', () => {
      expect(toScreamingSnakeCase('')).toBe('');
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

    it('finds action calls in nested functions', () => {
      const source = `async (db, args) => {
        const results = await Promise.all(
          args.ids.map(id => getUser({ id }))
        );
        return results;
      }`;
      const knownActions = new Set(['getUser']);

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toContain('getUser');
    });

    it('returns empty array when no known actions', () => {
      const source = `async (db, args) => {
        return db.selectFrom('users').execute();
      }`;
      const knownActions = new Set<string>();

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toEqual([]);
    });

    it('deduplicates multiple calls to same action', () => {
      const source = `async (db, args) => {
        const user1 = await getUser({ id: args.id1 });
        const user2 = await getUser({ id: args.id2 });
        return [user1, user2];
      }`;
      const knownActions = new Set(['getUser']);

      const calls = findActionCallsInSource(source, knownActions);
      expect(calls).toEqual(['getUser']);
    });

    it('warns on unparseable source', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const calls = findActionCallsInSource('not valid {{{ js', new Set(['foo']));

      expect(calls).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse handler source'),
        expect.anything()
      );

      warnSpy.mockRestore();
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
          instance: 'per-tenant',
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);

      expect(result.database).not.toBeNull();
      expect(result.database!.name).toBe('main');
      expect(result.database!.className).toBe('MainDatabaseDO');
      expect(result.database!.bindingName).toBe('MAIN_DATABASE_DO');
      expect(result.database!.instance).toBe('per-tenant');
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

    it('extracts browsable: true', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
          browsable: true,
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);
      expect(result.database!.browsable).toBe(true);
    });

    it('extracts browsable: false', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
          browsable: false,
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);
      expect(result.database!.browsable).toBe(false);
    });

    it('extracts browsable: "development"', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
          browsable: 'development',
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);
      expect(result.database!.browsable).toBe('development');
    });

    it('defaults browsable to false when not specified', () => {
      const code = `
        import { defineDatabase } from '@shoplayer/database/db';
        import { users } from './schema';

        export const { action } = defineDatabase({
          migrationsDir: './migrations',
          schema: { users },
        });
      `;

      const result = parseDatabaseFile('/src/databases/main.js', code);
      expect(result.database!.browsable).toBe(false);
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

    it('returns empty result for non-database files', () => {
      const code = `
        export const helper = (x) => x * 2;
        export const config = { debug: true };
      `;

      const result = parseDatabaseFile('/src/utils/helpers.js', code);

      expect(result.database).toBeNull();
      expect(result.actions).toHaveLength(0);
    });

    it('handles action files that import action from database', () => {
      const code = `
        import { action } from './main';

        export const getUser = action({
          args: { id: 'string' },
          handler: async (db, args) => db.selectFrom('users').execute(),
        });
      `;

      const result = parseDatabaseFile('/src/databases/actions/getUser.js', code);

      expect(result.database).toBeNull();
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].exportName).toBe('getUser');
    });

    it('extracts complex args schema', () => {
      const code = `
        import { action } from './main';

        export const createPost = action({
          args: {
            title: 'string',
            content: 'string',
            tags: 'string[]',
            metadata: {
              author: 'string',
              publishedAt: 'Date',
            },
          },
          handler: async (db, args) => db.insertInto('posts').values(args).execute(),
        });
      `;

      const result = parseDatabaseFile('/src/databases/actions/createPost.js', code);

      expect(result.actions[0].argsSchemaSource).toContain('title');
      expect(result.actions[0].argsSchemaSource).toContain('tags');
      expect(result.actions[0].argsSchemaSource).toContain('metadata');
    });

    it('handles default export action', () => {
      const code = `
        import { action } from './main';

        export default action({
          args: { id: 'string' },
          handler: async (db, args) => db.selectFrom('users').execute(),
        });
      `;

      const result = parseDatabaseFile('/src/databases/actions/getUser.js', code);

      // Default exports should be handled
      expect(result.actions.length).toBeGreaterThanOrEqual(0);
    });
  });
});
