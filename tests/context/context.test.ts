import { describe, it, expect, afterEach } from 'vitest';
import { getTenantId, hasTenantId, setTenantIdResolver } from '../../src/context';

/** Act as if running inside a Durable Object whose instance key is `instanceKey`. */
function insideDurableObject<T>(instanceKey: string, fn: () => T): T {
  const slot = Symbol.for('durable-db.doContext');
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[slot];
  globals[slot] = () => ({ instanceKey });
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
    it('reads the tenant from the instance key, without the dev epoch', () => {
      expect(insideDurableObject('acme', () => getTenantId())).toBe('acme');
      expect(insideDurableObject('acme__dev_mw20xi9e', () => getTenantId())).toBe('acme');
    });

    it('a global database has no tenant — in dev too, where its key carries an epoch', () => {
      expect(insideDurableObject('global', () => hasTenantId())).toBe(false);
      expect(insideDurableObject('global__dev_mw20xi9e', () => hasTenantId())).toBe(false);
      expect(() => insideDurableObject('global__dev_mw20xi9e', () => getTenantId())).toThrow(
        'getTenantId() called without a resolver'
      );
    });
  });
});
