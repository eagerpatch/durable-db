import { describe, it, expect, afterEach, vi } from 'vitest';
import { createDebug } from '../../src/utils/debug';

// The debug module is in the worker's and the Durable Object's bundle. In
// workerd the first read of `process` builds Node's whole process object
// (about 7 ms of an isolate's startup), so a debugger reads DEBUG when it is
// first asked, never when the module makes it.
describe('createDebug', () => {
  const saved = process.env.DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = saved;
  });

  it('reads nothing of process when a debugger is made', () => {
    const env = Object.getOwnPropertyDescriptor(process, 'env')!;
    let reads = 0;
    Object.defineProperty(process, 'env', {
      configurable: true,
      get: () => {
        reads++;
        return env.value;
      },
    });
    try {
      createDebug('database:probe');
    } finally {
      Object.defineProperty(process, 'env', env);
    }
    expect(reads).toBe(0);
  });

  it('reads DEBUG at the first read of `enabled` and keeps it', () => {
    delete process.env.DEBUG;
    const debug = createDebug('database:probe');
    process.env.DEBUG = 'database:*';
    expect(debug.enabled).toBe(true);
    delete process.env.DEBUG;
    expect(debug.enabled).toBe(true);
    debug.enabled = false;
    expect(debug.enabled).toBe(false);
  });

  it('is asked by a call', () => {
    process.env.DEBUG = '-database:probe,database:*';
    const quiet = createDebug('database:probe');
    const loud = createDebug('database:other');
    expect(quiet.enabled).toBe(false);
    expect(loud.enabled).toBe(true);
    expect(loud.extend('sub').namespace).toBe('database:other:sub');
  });
});

// A Durable Object hands its env's DEBUG over (SqliteDurableObject's
// constructor), so no debugger in its isolate reads `process`.
describe('setDebugSpec', () => {
  const saved = process.env.DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = saved;
  });

  it('is read instead of process.env by every debugger asked after it', async () => {
    vi.resetModules();
    const { createDebug, setDebugSpec } = await import('../../src/utils/debug');
    process.env.DEBUG = 'database:*';
    setDebugSpec('database:probe');
    expect(createDebug('database:probe').enabled).toBe(true);
    expect(createDebug('database:other').enabled).toBe(false);
    setDebugSpec(undefined);
    expect(createDebug('database:probe').enabled).toBe(false);
  });
});
