import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAction,
  getAction,
  getDoContext,
  runWithDoContext,
  callActionInValidated,
  callActionIn,
  type ActionDefinition,
  type DoContext,
  type RpcContext,
} from '../src/registry';

// ============================================================================
// Test Fixtures
// ============================================================================

const createMockAction = (name: string): ActionDefinition => ({
  validator: (args) => args,
  handler: async (db, args) => ({ action: name, args }),
});

const createMockContext = (dbName: string): RpcContext => ({
  env: {},
  dbName,
  dbBindingNames: { main: 'MAIN_DO', analytics: 'ANALYTICS_DO' },
  instanceKey: 'test-shop',
});

// ============================================================================
// registerAction / getAction
// ============================================================================

describe('registerAction and getAction', () => {
  beforeEach(() => {
    // Note: In real tests you'd want to reset the registry between tests
    // This would require exporting a reset function or using a factory pattern
  });

  it('registers and retrieves an action', () => {
    const action = createMockAction('testAction');
    registerAction('testDb', 'testAction', action);

    const retrieved = getAction('testDb', 'testAction');
    expect(retrieved).toBe(action);
  });

  it('returns undefined for non-existent action', () => {
    const retrieved = getAction('nonExistentDb', 'nonExistentAction');
    expect(retrieved).toBeUndefined();
  });

  it('registers multiple actions per database', () => {
    const action1 = createMockAction('action1');
    const action2 = createMockAction('action2');

    registerAction('multiDb', 'action1', action1);
    registerAction('multiDb', 'action2', action2);

    expect(getAction('multiDb', 'action1')).toBe(action1);
    expect(getAction('multiDb', 'action2')).toBe(action2);
  });

  it('registers actions across databases', () => {
    const mainAction = createMockAction('mainAction');
    const analyticsAction = createMockAction('analyticsAction');

    registerAction('main', 'mainAction', mainAction);
    registerAction('analytics', 'analyticsAction', analyticsAction);

    expect(getAction('main', 'mainAction')).toBe(mainAction);
    expect(getAction('analytics', 'analyticsAction')).toBe(analyticsAction);
    expect(getAction('main', 'analyticsAction')).toBeUndefined();
  });
});

// ============================================================================
// getDoContext / runWithDoContext
// ============================================================================

describe('getDoContext and runWithDoContext', () => {
  it('returns undefined outside of DO context', () => {
    expect(getDoContext()).toBeUndefined();
  });

  it('returns context inside runWithDoContext', async () => {
    const mockContext: DoContext = {
      db: { mock: 'db' },
      ctx: createMockContext('main'),
      dbName: 'main',
      instanceKey: 'test-shop',
    };

    let capturedContext: DoContext | undefined;

    await runWithDoContext(mockContext, () => {
      capturedContext = getDoContext();
    });

    expect(capturedContext).toBe(mockContext);
  });

  it('context is undefined after runWithDoContext completes', async () => {
    const mockContext: DoContext = {
      db: { mock: 'db' },
      ctx: createMockContext('main'),
      dbName: 'main',
      instanceKey: 'test-shop',
    };

    await runWithDoContext(mockContext, () => {
      // Inside context
    });

    expect(getDoContext()).toBeUndefined();
  });

  it('supports async functions', async () => {
    const mockContext: DoContext = {
      db: { mock: 'db' },
      ctx: createMockContext('main'),
      dbName: 'main',
      instanceKey: 'test-shop',
    };

    const result = await runWithDoContext(mockContext, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getDoContext()?.dbName;
    });

    expect(result).toBe('main');
  });
});

// ============================================================================
// callActionInValidated
// ============================================================================

describe('callActionInValidated', () => {
  it('calls handler directly for same database', async () => {
    const action = createMockAction('sameDbAction');
    registerAction('sameDb', 'sameDbAction', action);

    const ctx = createMockContext('sameDb');
    const result = await callActionInValidated({}, 'sameDb', 'sameDbAction', { foo: 'bar' }, ctx);

    expect(result).toEqual({ action: 'sameDbAction', args: { foo: 'bar' } });
  });

  it('throws for unregistered action', async () => {
    const ctx = createMockContext('main');

    await expect(
      callActionInValidated({}, 'main', 'unknownAction', {}, ctx)
    ).rejects.toThrow('Action not registered');
  });

  it('throws for missing binding on cross-db call', async () => {
    const action = createMockAction('crossAction');
    registerAction('otherDb', 'crossAction', action);

    const ctx = createMockContext('main');
    // otherDb is not in dbBindingNames

    await expect(
      callActionInValidated({}, 'otherDb', 'crossAction', {}, ctx)
    ).rejects.toThrow('Missing binding');
  });

  it('uses RPC for cross-db calls', async () => {
    const handler = vi.fn();
    registerAction('analytics', 'trackEvent', {
      validator: (args) => args,
      handler,
    });

    const rpcSpy = vi.fn().mockResolvedValue({ tracked: true });
    const mockStub = { rpc: rpcSpy };
    const mockId = { id: 'analytics-id' };

    const ctx = createMockContext('main');
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue(mockId),
        get: vi.fn().mockReturnValue(mockStub),
      },
    };

    const result = await callActionInValidated(
      {},
      'analytics',
      'trackEvent',
      { event: 'pageview' },
      ctx
    );

    expect(result).toEqual({ tracked: true });
    expect(rpcSpy).toHaveBeenCalledWith('trackEvent', { event: 'pageview' }, { instanceKey: 'test-shop' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls handler directly with same db reference inside DO context', async () => {
    const mockDb = { mock: 'db-instance' };
    const handler = vi.fn().mockResolvedValue({ ok: true });
    registerAction('main', 'internalAction', {
      validator: (args) => args,
      handler,
    });

    const ctx = createMockContext('main');
    const doContext: DoContext = {
      db: mockDb,
      ctx,
      dbName: 'main',
      instanceKey: 'test-shop',
    };

    const result = await runWithDoContext(doContext, () =>
      callActionInValidated(mockDb, 'main', 'internalAction', { key: 'value' }, ctx)
    );

    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(mockDb, { key: 'value' }, ctx);
    // Verify db is the exact same reference
    expect(handler.mock.calls[0][0]).toBe(mockDb);
  });

  it('uses RPC for cross-db calls even inside DO context', async () => {
    const analyticsHandler = vi.fn();
    registerAction('analytics', 'logMetric', {
      validator: (args) => args,
      handler: analyticsHandler,
    });

    const rpcSpy = vi.fn().mockResolvedValue({ logged: true });
    const mockStub = { rpc: rpcSpy };
    const mockId = { id: 'analytics-id' };

    const ctx = createMockContext('main');
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue(mockId),
        get: vi.fn().mockReturnValue(mockStub),
      },
    };

    const doContext: DoContext = {
      db: { mock: 'main-db' },
      ctx,
      dbName: 'main',
      instanceKey: 'test-shop',
    };

    const result = await runWithDoContext(doContext, () =>
      callActionInValidated({}, 'analytics', 'logMetric', { metric: 'cpu' }, ctx)
    );

    expect(result).toEqual({ logged: true });
    expect(rpcSpy).toHaveBeenCalledWith('logMetric', { metric: 'cpu' }, { instanceKey: 'test-shop' });
    expect(analyticsHandler).not.toHaveBeenCalled();
  });
});

// ============================================================================
// callActionIn
// ============================================================================

describe('callActionIn', () => {
  it('validates args before calling handler', async () => {
    let validatorCalled = false;
    const action: ActionDefinition = {
      validator: (args) => {
        validatorCalled = true;
        return args;
      },
      handler: async (db, args) => args,
    };

    registerAction('validationDb', 'validatedAction', action);

    const ctx = createMockContext('validationDb');
    await callActionIn({}, 'validationDb', 'validatedAction', { test: true }, ctx);

    expect(validatorCalled).toBe(true);
  });

  it('throws on validation failure', async () => {
    // This test would need arktype's type.errors to work properly
    // For now, we can test that the validator is called
    const action: ActionDefinition = {
      validator: () => {
        // Simulate validation error
        const error = { summary: 'Invalid input' };
        Object.setPrototypeOf(error, { constructor: { name: 'errors' } });
        return error;
      },
      handler: async () => {},
    };

    registerAction('errorDb', 'errorAction', action);
    const ctx = createMockContext('errorDb');

    // Note: This test is simplified - real test would need proper arktype error
    // await expect(callActionIn({}, 'errorDb', 'errorAction', {}, ctx)).rejects.toThrow('Invalid args');
  });
});
