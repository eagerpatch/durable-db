import { describe, it, expect } from 'vitest';
import { defineDatabase } from '../../src/db/defineDatabase';
import { type } from '../../src/arktypeConfig';
import { actionArgsType } from '../../src/db/actionArgs';
import { table, text } from '../../src/schema';

describe('db', () => {
  describe('defineDatabase', () => {
    it('returns an object with action function', () => {
      const { action } = defineDatabase({
        schema: {},
      });

      expect(typeof action).toBe('function');
    });

    it('action returns a function', () => {
      const { action } = defineDatabase({
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
        schema: {},
      });

      const myAction = action({
        args: { name: 'string' },
        handler: async (db, args) => args.name,
      });

      // Valid args should still throw because transformation hasn't run
      // and the error should include the args schema keys for identifiability
      await expect(myAction({ name: 'test' })).rejects.toThrow(
        /Action \(args: \{ name \}\) called without transformation/
      );
    });

    it('says how to run an untransformed action in a test, naming no Vite config', async () => {
      const notes = table('notes', { id: text().primaryKey() });
      const tags = table('tags', { id: text().primaryKey() });
      const { action } = defineDatabase({ schema: { notes, tags } });
      const myAction = action({ args: { id: 'string' }, handler: async () => null });

      const error = await myAction({ id: 'n1' }).then(() => null, (e: Error) => e);
      expect(error?.message).toContain('action() call sites are transformed by the build');
      expect(error?.message).toContain('createTestDatabase({ schema: { notes, tags } })');
      expect(error?.message).toContain('db.run(action, args)');
      expect(error?.message).not.toMatch(/Vite config/);
    });

    it('does not dump ArkType internals when args is a type(...)', async () => {
      const { action } = defineDatabase({ schema: {} });
      const myAction = action({
        args: type({ id: 'string' }) as never,
        handler: async () => null,
      });

      const untransformed = await myAction({ id: 'x' } as never).then(() => null, (e: Error) => e);
      expect(untransformed?.message).toMatch(/^Action called without transformation/);
      expect(untransformed?.message).not.toMatch(/\bkind\b|\bimpl\b/);

      const invalid = await myAction({ id: 1 } as never).then(() => null, (e: Error) => e);
      expect(invalid?.message).toMatch(/^Invalid args for action: id must be a string/);
    });

    it('accepts an optional key passed as undefined (the inferred type allows it)', async () => {
      const { action } = defineDatabase({ schema: {} });
      const myAction = action({
        args: { name: 'string', 'photoKey?': 'string' },
        handler: async (db, args) => args,
      });

      // Type-checks: `{ photoKey?: string }` accepts undefined. Validation
      // must agree, so this reaches the untransformed-call error, not
      // "photoKey must be a string (was undefined)".
      await expect(myAction({ name: 'a', photoKey: undefined })).rejects.toThrow(
        /called without transformation/
      );
      // Still validated when present, and a required key is still required.
      await expect(myAction({ name: 'a', photoKey: 1 as never })).rejects.toThrow(/Invalid args/);
      await expect(myAction({ name: undefined as never })).rejects.toThrow(/Invalid args/);
    });

    it('accepts an undefined optional key in an args schema built with the registry\'s type(...)', async () => {
      const { action } = defineDatabase({ schema: {} });
      const myAction = action({
        args: actionArgsType({ name: 'string', 'photoKey?': 'string' }) as never,
        handler: async () => null,
      });

      await expect(myAction({ name: 'a', photoKey: undefined } as never)).rejects.toThrow(
        /called without transformation/
      );
    });

    it('keeps a required key that admits undefined required (TypeScript makes it so)', async () => {
      const { action } = defineDatabase({ schema: {} });
      const myAction = action({
        args: { id: 'string', note: 'string | undefined' },
        handler: async (db, args) => args,
      });

      await expect(myAction({ id: 'a', note: undefined })).rejects.toThrow(/called without transformation/);
      await expect(myAction({ id: 'a' } as never)).rejects.toThrow(/note must be a string or undefined \(was missing\)/);
    });

    it('includes args schema keys in invalid-args error', async () => {
      const { action } = defineDatabase({ schema: {} });
      const myAction = action({
        args: { name: 'string', email: 'string.email' },
        handler: async () => undefined,
      });

      await expect(
        myAction({ name: 'test', email: 'not-an-email' } as any)
      ).rejects.toThrow(/Invalid args for action \(args: \{ name, email \}\)/);
    });

    it('supports complex args schemas', async () => {
      const { action } = defineDatabase({
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
        /called without transformation/
      );
    });

    it('supports different instance strategies', () => {
      const perShop = defineDatabase({
        schema: {},
        instance: 'per-tenant',
      });

      const global = defineDatabase({
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
        schema: mockSchema,
      });

      expect(typeof action).toBe('function');
    });
  });
});
