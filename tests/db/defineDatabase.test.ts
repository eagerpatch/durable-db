import { describe, it, expect } from 'vitest';
import { defineDatabase } from '../../src/db/defineDatabase';

describe('db', () => {
  describe('defineDatabase', () => {
    it('returns an object with action function', () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      expect(typeof action).toBe('function');
    });

    it('action returns a function', () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      const myAction = action({
        args: { name: 'string' },
        handler: async (db, args) => args.name,
      });

      expect(typeof myAction).toBe('function');
    });

    it('validates args using arktype', async () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      const myAction = action({
        args: { name: 'string', age: 'number' },
        handler: async (db, args) => args,
      });

      // Invalid args should throw
      await expect(myAction({ name: 123, age: 'not a number' } as any)).rejects.toThrow('Invalid args');
    });

    it('throws error when action called without transformation', async () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      const myAction = action({
        args: { name: 'string' },
        handler: async (db, args) => args.name,
      });

      // Valid args should still throw because transformation hasn't run
      await expect(myAction({ name: 'test' })).rejects.toThrow(
        'Action called without transformation'
      );
    });

    it('supports complex args schemas', async () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      const myAction = action({
        args: {
          user: {
            name: 'string',
            email: 'string.email',
          },
          tags: 'string[]',
        },
        handler: async (db, args) => args,
      });

      // Invalid email should fail validation
      await expect(
        myAction({
          user: { name: 'John', email: 'not-an-email' },
          tags: ['a', 'b'],
        })
      ).rejects.toThrow('Invalid args');
    });

    it('supports optional args', async () => {
      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
      });

      const myAction = action({
        args: {
          name: 'string',
          nickname: 'string?',
        },
        handler: async (db, args) => args,
      });

      // Should validate successfully (but then throw the transformation error)
      await expect(myAction({ name: 'test' })).rejects.toThrow(
        'Action called without transformation'
      );
    });

    it('supports different instance strategies', () => {
      const perShop = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
        instance: 'per-shop',
      });

      const global = defineDatabase({
        migrationsDir: './migrations',
        schema: {},
        instance: 'global',
      });

      expect(typeof perShop.action).toBe('function');
      expect(typeof global.action).toBe('function');
    });

    it('accepts drizzle schema tables', () => {
      // Mock schema object (real drizzle tables are complex)
      const mockSchema = {
        users: { 
          name: { columnName: 'name' },
          email: { columnName: 'email' },
        } as any,
      };

      const { action } = defineDatabase({
        migrationsDir: './migrations',
        schema: mockSchema,
      });

      expect(typeof action).toBe('function');
    });
  });
});
