import { describe, it, expect, afterEach } from 'vitest';
import { getTenantId, hasTenantId, setTenantIdResolver } from '../../src/context';

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
});
