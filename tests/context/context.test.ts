import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTenantId, hasTenantId, setTenantIdResolver } from '../../src/context';

/**
 * Act as if running inside a Durable Object whose instance key is
 * `instanceKey`; `tenant` is the tenant the object worked out, as a generated
 * class hands it to the store (left out: a store built by hand).
 */
function insideDurableObject<T>(instanceKey: string, fn: () => T, tenant?: { tenantId: string | null }): T {
  const slot = Symbol.for('durable-db.doContext');
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[slot];
  globals[slot] = () => ({ instanceKey, ...tenant });
  try {
    return fn();
  } finally {
    globals[slot] = previous;
  }
}

describe('context', () => {
  afterEach(() => {
    setTenantIdResolver(null);
  });

  describe('getTenantId', () => {
    it('throws when no resolver is configured', () => {
      expect(() => getTenantId()).toThrow('getTenantId() called without a resolver');
    });

    it('returns the tenant ID from the resolver', () => {
      setTenantIdResolver(() => 'my-tenant-123');

      expect(getTenantId()).toBe('my-tenant-123');
    });

    it('reflects resolver changes', () => {
      setTenantIdResolver(() => 'tenant-a');
      expect(getTenantId()).toBe('tenant-a');

      setTenantIdResolver(() => 'tenant-b');
      expect(getTenantId()).toBe('tenant-b');
    });
  });

  describe('setTenantIdResolver', () => {
    it('provides tenant ID via resolver', () => {
      setTenantIdResolver(() => 'resolved-tenant');

      expect(getTenantId()).toBe('resolved-tenant');
    });

    it('can be cleared by passing null', () => {
      setTenantIdResolver(() => 'some-tenant');

      setTenantIdResolver(null);

      expect(() => getTenantId()).toThrow('getTenantId() called without a resolver');
    });
  });

  describe('hasTenantId', () => {
    it('returns false when no resolver is configured', () => {
      expect(hasTenantId()).toBe(false);
    });

    it('returns true when resolver is set', () => {
      setTenantIdResolver(() => 'some-tenant');

      expect(hasTenantId()).toBe(true);
    });

    it('returns false after resolver is cleared', () => {
      setTenantIdResolver(() => 'some-tenant');
      setTenantIdResolver(null);

      expect(hasTenantId()).toBe(false);
    });
  });
  describe('inside a Durable Object', () => {
    it('answers the tenant the object worked out, never a cut of its key', () => {
      // A dev key: the object stripped exactly its epoch.
      expect(insideDurableObject('acme__dev_mw20xi9e', () => getTenantId(), { tenantId: 'acme' })).toBe('acme');
      // Production: a tenant id containing "__dev_" is the key whole.
      expect(insideDurableObject('team__dev_ops', () => getTenantId(), { tenantId: 'team__dev_ops' })).toBe('team__dev_ops');
      // A per-tenant database's tenant named 'global' is that tenant.
      expect(insideDurableObject('global', () => getTenantId(), { tenantId: 'global' })).toBe('global');
    });

    it("a global database's object has no tenant, whatever its key", () => {
      expect(insideDurableObject('global', () => hasTenantId(), { tenantId: null })).toBe(false);
      expect(insideDurableObject('global__dev_mw20xi9e', () => hasTenantId(), { tenantId: null })).toBe(false);
      expect(() => insideDurableObject('global', () => getTenantId(), { tenantId: null })).toThrow(
        'getTenantId() called without a resolver'
      );
    });

    it("reads a store that does not say (built by hand) as its key, the key 'global' as no tenant", () => {
      expect(insideDurableObject('acme', () => getTenantId())).toBe('acme');
      expect(insideDurableObject('team__dev_ops', () => getTenantId())).toBe('team__dev_ops');
      expect(insideDurableObject('global', () => hasTenantId())).toBe(false);
    });

    it("answers a per-tenant object's own tenant before an installed resolver, which is never asked there", () => {
      // The worker module's top level runs in every object's isolate: its resolver is installed there too, and reads a request there is none of.
      const resolver = vi.fn((): string => {
        throw new Error('no request in this context');
      });
      setTenantIdResolver(resolver);
      expect(insideDurableObject('acme__dev_mw20xi9e', () => getTenantId(), { tenantId: 'acme' })).toBe('acme');
      expect(insideDurableObject('acme', () => hasTenantId(), { tenantId: 'acme' })).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
      // Nor can a resolver answer another tenant for code running in the object.
      setTenantIdResolver(() => 'other');
      expect(insideDurableObject('acme', () => getTenantId(), { tenantId: 'acme' })).toBe('acme');
    });

    it("asks the resolver in a global database's object, and in a store built by hand, as outside an object", () => {
      setTenantIdResolver(() => 'from-the-request');
      expect(insideDurableObject('global', () => getTenantId(), { tenantId: null })).toBe('from-the-request');
      expect(insideDurableObject('acme', () => getTenantId())).toBe('from-the-request');
      expect(getTenantId()).toBe('from-the-request');
    });
  });
});
