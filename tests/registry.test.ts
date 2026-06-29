import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAction,
  getAction,
  getDoContext,
  runWithDoContext,
  callAction,
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
// callAction
// ============================================================================

describe('callAction', () => {
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
    await callAction({}, 'validationDb', 'validatedAction', { test: true }, ctx);

    expect(validatorCalled).toBe(true);
  });

  it('calls handler directly for same database', async () => {
    const action = createMockAction('sameDbAction');
    registerAction('sameDb', 'sameDbAction', action);

    const ctx = createMockContext('sameDb');
    const result = await callAction({}, 'sameDb', 'sameDbAction', { foo: 'bar' }, ctx);

    expect(result).toEqual({ action: 'sameDbAction', args: { foo: 'bar' } });
  });

  it('throws for unregistered action', async () => {
    const ctx = createMockContext('main');

    await expect(
      callAction({}, 'main', 'unknownAction', {}, ctx)
    ).rejects.toThrow('Action not registered');
  });

  it('args-validation error names the db/action that failed', async () => {
    const { type } = await import('arktype');
    const validator = type({ name: 'string' }) as unknown as ActionDefinition['validator'];
    registerAction('argCtxDb', 'argCtxAction', {
      validator,
      handler: async (_db, args) => args,
    });

    const ctx = createMockContext('argCtxDb');
    await expect(
      callAction({}, 'argCtxDb', 'argCtxAction', { name: 123 }, ctx)
    ).rejects.toThrow(/Invalid args for argCtxDb\/argCtxAction/);
  });

  it('error for unregistered action lists known actions on that database', async () => {
    registerAction('errorListDb', 'existingOne', createMockAction('existingOne'));
    registerAction('errorListDb', 'existingTwo', createMockAction('existingTwo'));

    const ctx = createMockContext('errorListDb');
    await expect(
      callAction({}, 'errorListDb', 'missing', {}, ctx)
    ).rejects.toThrow(/existingOne.*existingTwo|existingTwo.*existingOne/);
  });

  it('error for unknown database mentions other known databases', async () => {
    registerAction('knownA', 'foo', createMockAction('foo'));
    registerAction('knownB', 'bar', createMockAction('bar'));

    const ctx = createMockContext('knownA');
    await expect(
      callAction({}, 'totallyUnknownDb', 'foo', {}, ctx)
    ).rejects.toThrow(/database 'totallyUnknownDb' has no registered actions/);
  });

  it('throws for missing binding on cross-db call', async () => {
    const action = createMockAction('crossAction');
    registerAction('otherDb', 'crossAction', action);

    const ctx = createMockContext('main');
    // otherDb is not in dbBindingNames

    await expect(
      callAction({}, 'otherDb', 'crossAction', {}, ctx)
    ).rejects.toThrow('Missing binding');
  });

  it('missing-binding error lists known bindings', async () => {
    registerAction('unreachable', 'ping', createMockAction('ping'));

    const ctx: RpcContext = {
      env: {},
      dbName: 'main',
      dbBindingNames: { main: 'MAIN_DO', analytics: 'ANALYTICS_DO' },
      instanceKey: 'test-shop',
    };

    await expect(
      callAction({}, 'unreachable', 'ping', {}, ctx)
    ).rejects.toThrow(/Known database bindings: main, analytics/);
  });

  it('missing-binding error hints at Vite plugin discovery', async () => {
    registerAction('unreachable', 'ping', createMockAction('ping'));

    const ctx: RpcContext = {
      env: {},
      dbName: 'main',
      dbBindingNames: { main: 'MAIN_DO' },
      instanceKey: 'test-shop',
    };

    await expect(
      callAction({}, 'unreachable', 'ping', {}, ctx)
    ).rejects.toThrow(/didn't discover 'unreachable\.ts'/);
  });

  it('propagates errors from cross-db RPC', async () => {
    registerAction('analytics', 'explodeRpc', createMockAction('explodeRpc'));

    const rpcSpy = vi.fn().mockRejectedValue(new Error('remote failure'));
    const ctx = createMockContext('main');
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue({}),
        get: vi.fn().mockReturnValue({ rpc: rpcSpy }),
      },
    };

    await expect(
      callAction({}, 'analytics', 'explodeRpc', {}, ctx)
    ).rejects.toThrow('remote failure');
  });

  it('uses websocket transport for cross-db when dbTransports says websocket', async () => {
    registerAction('analytics', 'wsPing', createMockAction('wsPing'));

    // Minimal fake WebSocket round-trip
    const listeners = new Map<string, Function[]>();
    const sent: string[] = [];
    const ws: any = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn((data: string) => {
        sent.push(data);
        // Echo back a success response using the id from the request
        const { id } = JSON.parse(data);
        queueMicrotask(() => {
          for (const h of listeners.get('message') ?? []) {
            h({ data: JSON.stringify({ id, ok: true, result: { pong: true } }) });
          }
        });
      }),
      close: vi.fn(),
      addEventListener: vi.fn((event: string, handler: Function) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(handler);
      }),
    };
    const stub = {
      rpc: vi.fn(),
      fetch: vi.fn().mockResolvedValue({ webSocket: ws }),
    };

    const ctx = createMockContext('main');
    ctx.dbTransports = { analytics: 'websocket' };
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue({}),
        get: vi.fn().mockReturnValue(stub),
      },
    };

    const result = await callAction({}, 'analytics', 'wsPing', {}, ctx);
    expect(result).toEqual({ pong: true });
    expect(stub.rpc).not.toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it('websocket transport also fails fast on missing binding', async () => {
    registerAction('unreachableWs', 'ping', createMockAction('ping'));

    const ctx: RpcContext = {
      env: {},
      dbName: 'main',
      dbBindingNames: { main: 'MAIN_DO' }, // no unreachableWs entry
      dbTransports: { unreachableWs: 'websocket' },
      instanceKey: 'test-shop',
    };

    await expect(
      callAction({}, 'unreachableWs', 'ping', {}, ctx)
    ).rejects.toThrow(/Missing binding for db: unreachableWs/);
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

    const result = await callAction(
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

  it('strips the RPC Symbol.dispose so results are RSC-serializable plain clones', async () => {
    registerAction('analytics', 'getThing', { validator: (args) => args, handler: vi.fn() });

    // Cloudflare's DO RPC attaches a Symbol.dispose to the top-level result;
    // React Server Components refuse to serialize symbol-keyed props.
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const rpcResult: Record<string | symbol, unknown> = { id: 'x', createdAt };
    rpcResult[Symbol.dispose] = () => {};
    const rpcSpy = vi.fn().mockResolvedValue(rpcResult);

    const ctx = createMockContext('main');
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue({ id: 'analytics-id' }),
        get: vi.fn().mockReturnValue({ rpc: rpcSpy }),
      },
    };

    const result = (await callAction({}, 'analytics', 'getThing', {}, ctx)) as Record<string, unknown>;

    // No symbol-keyed props survive, and it's a clone (not the RPC object).
    expect(Object.getOwnPropertySymbols(result)).toHaveLength(0);
    expect(result).not.toBe(rpcResult);
    // Data preserved — including the Date type (structuredClone, not a JSON round-trip).
    expect(result.id).toBe('x');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect((result.createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
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
      callAction(mockDb, 'main', 'internalAction', { key: 'value' }, ctx)
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
      callAction({}, 'analytics', 'logMetric', { metric: 'cpu' }, ctx)
    );

    expect(result).toEqual({ logged: true });
    expect(rpcSpy).toHaveBeenCalledWith('logMetric', { metric: 'cpu' }, { instanceKey: 'test-shop' });
    expect(analyticsHandler).not.toHaveBeenCalled();
  });

  it('uses RPC when dbTransports is not set (backwards compat)', async () => {
    registerAction('analytics', 'trackCompat', {
      validator: (args) => args,
      handler: vi.fn(),
    });

    const rpcSpy = vi.fn().mockResolvedValue({ ok: true });
    const mockStub = { rpc: rpcSpy };
    const mockId = { id: 'a-id' };

    const ctx = createMockContext('main');
    // No dbTransports set
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue(mockId),
        get: vi.fn().mockReturnValue(mockStub),
      },
    };

    const result = await callAction({}, 'analytics', 'trackCompat', { x: 1 }, ctx);
    expect(result).toEqual({ ok: true });
    expect(rpcSpy).toHaveBeenCalled();
  });

  it('uses RPC for cross-db when dbTransports says rpc', async () => {
    registerAction('analytics', 'trackRpc', {
      validator: (args) => args,
      handler: vi.fn(),
    });

    const rpcSpy = vi.fn().mockResolvedValue({ tracked: true });
    const mockStub = { rpc: rpcSpy };
    const mockId = { id: 'a-id' };

    const ctx = createMockContext('main');
    ctx.dbTransports = { analytics: 'rpc' };
    ctx.env = {
      ANALYTICS_DO: {
        idFromName: vi.fn().mockReturnValue(mockId),
        get: vi.fn().mockReturnValue(mockStub),
      },
    };

    const result = await callAction({}, 'analytics', 'trackRpc', {}, ctx);
    expect(result).toEqual({ tracked: true });
    expect(rpcSpy).toHaveBeenCalled();
  });
});
