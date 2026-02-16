import { describe, it, expect, afterEach } from 'vitest';
import { getTenantId, runWithTenantId, hasTenantId, setTenantIdResolver } from '../../src/context';

describe('context', () => {
  describe('runWithTenantId', () => {
    it('makes tenant ID available within callback', () => {
      runWithTenantId('test-tenant', () => {
        expect(getTenantId()).toBe('test-tenant');
      });
    });

    it('returns the result of the callback', () => {
      const result = runWithTenantId('test-tenant', () => 42);

      expect(result).toBe(42);
    });

    it('returns promise result from async callback', async () => {
      const result = await runWithTenantId('test-tenant', async () => {
        await Promise.resolve();
        return 'async result';
      });

      expect(result).toBe('async result');
    });

    it('propagates errors from callback', () => {
      expect(() =>
        runWithTenantId('test-tenant', () => {
          throw new Error('test error');
        })
      ).toThrow('test error');
    });

    it('propagates rejected promises from async callback', async () => {
      await expect(
        runWithTenantId('test-tenant', async () => {
          throw new Error('async error');
        })
      ).rejects.toThrow('async error');
    });

    it('allows nested contexts', () => {
      runWithTenantId('outer-tenant', () => {
        expect(getTenantId()).toBe('outer-tenant');

        runWithTenantId('inner-tenant', () => {
          expect(getTenantId()).toBe('inner-tenant');
        });

        // After inner context, outer context is restored
        expect(getTenantId()).toBe('outer-tenant');
      });
    });
  });

  describe('getTenantId', () => {
    it('throws when called outside of runWithTenantId', () => {
      expect(() => getTenantId()).toThrow('getTenantId() called outside of request context');
    });

    it('returns the tenant ID string', () => {
      runWithTenantId('my-tenant-123', () => {
        expect(getTenantId()).toBe('my-tenant-123');
      });
    });
  });

  describe('setTenantIdResolver', () => {
    afterEach(() => {
      setTenantIdResolver(null);
    });

    it('provides tenant ID via resolver when no ALS store', () => {
      setTenantIdResolver(() => 'resolved-tenant');

      expect(getTenantId()).toBe('resolved-tenant');
    });

    it('ALS store takes priority over resolver', () => {
      setTenantIdResolver(() => 'resolver-tenant');

      runWithTenantId('als-tenant', () => {
        expect(getTenantId()).toBe('als-tenant');
      });
    });

    it('can be cleared by passing null', () => {
      setTenantIdResolver(() => 'some-tenant');

      setTenantIdResolver(null);

      expect(() => getTenantId()).toThrow('getTenantId() called outside of request context');
    });

    it('hasTenantId returns true when resolver is set', () => {
      setTenantIdResolver(() => 'some-tenant');

      expect(hasTenantId()).toBe(true);
    });
  });

  describe('hasTenantId', () => {
    it('returns false outside of runWithTenantId', () => {
      expect(hasTenantId()).toBe(false);
    });

    it('returns true inside runWithTenantId', () => {
      runWithTenantId('test-tenant', () => {
        expect(hasTenantId()).toBe(true);
      });
    });

    it('returns false after runWithTenantId completes', () => {
      runWithTenantId('test-tenant', () => {});

      expect(hasTenantId()).toBe(false);
    });
  });
});
