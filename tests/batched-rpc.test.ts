import { describe, it, expect, vi } from 'vitest';
import { batchedRpc, cachedArgsSchema, type BatchedResult } from '../src/registry';
// The Durable Object base class extends cloudflare:workers' DurableObject, which only workerd has.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { SqliteDurableObject } = await import('../src/db/SqliteDurableObject');

// The worker → Durable Object path: every action call used to be its own RPC.
// Calls to the same object started in the same turn now share one (rpcBatch);
// a lone call stays a plain rpc.
function namespace(options: { batch?: (calls: Array<{ action: string; args: unknown }>) => BatchedResult[] | Promise<BatchedResult[]> } = {}) {
  const rpc = vi.fn(async (action: string, args: unknown) => {
    const value = { action, args };
    // Cloudflare's RPC attaches a top-level Symbol.dispose to the result.
    return Object.assign(value, { [Symbol.dispose]: () => {} });
  });
  const rpcBatch = vi.fn(async (calls: Array<{ action: string; args: unknown }>) =>
    options.batch ? options.batch(calls) : calls.map((call) => ({ ok: true as const, value: { action: call.action, args: call.args } })),
  );
  const ids: string[] = [];
  return {
    rpc,
    rpcBatch,
    ids,
    ns: {
      idFromName: (name: string) => (ids.push(name), `id:${name}`),
      get: () => ({ rpc, rpcBatch }),
    },
  };
}

describe('batchedRpc', () => {
  it('sends a lone call as a plain rpc, its result a plain value', async () => {
    const { ns, rpc, rpcBatch } = namespace();
    const result = await batchedRpc(ns, 'acme', 'count', {});
    expect(rpc).toHaveBeenCalledExactlyOnceWith('count', {}, { instanceKey: 'acme' });
    expect(rpcBatch).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'count', args: {} });
    expect(Object.getOwnPropertySymbols(result as object)).toEqual([]);
  });

  it('sends calls to one object started in the same turn as ONE rpcBatch, in order, each result to its caller', async () => {
    const { ns, rpc, rpcBatch, ids } = namespace();
    const results = await Promise.all([
      batchedRpc(ns, 'acme', 'count', {}),
      batchedRpc(ns, 'acme', 'list', { featuredOnly: true }),
      batchedRpc(ns, 'acme', 'get', { id: 'cup' }),
    ]);
    expect(rpc).not.toHaveBeenCalled();
    expect(rpcBatch).toHaveBeenCalledExactlyOnceWith(
      [
        { action: 'count', args: {} },
        { action: 'list', args: { featuredOnly: true } },
        { action: 'get', args: { id: 'cup' } },
      ],
      { instanceKey: 'acme' },
    );
    expect(results.map((r) => (r as { action: string }).action)).toEqual(['count', 'list', 'get']);
    expect(ids).toEqual(['acme']);
  });

  it('rejects only the call that failed in a batch, with its name and message', async () => {
    const { ns } = namespace({
      batch: (calls) => calls.map((call) =>
        call.action === 'bad' ? { ok: false as const, error: { name: 'TypeError', message: 'no such product' } } : { ok: true as const, value: call.action },
      ),
    });
    const [good, bad] = await Promise.allSettled([batchedRpc(ns, 'acme', 'good', {}), batchedRpc(ns, 'acme', 'bad', {})]);
    expect(good).toEqual({ status: 'fulfilled', value: 'good' });
    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason).toMatchObject({ name: 'TypeError', message: 'no such product' });
  });

  it('rejects every call of a batch whose RPC failed', async () => {
    const { ns } = namespace({ batch: () => Promise.reject(new Error('network gone')) });
    const settled = await Promise.allSettled([batchedRpc(ns, 'acme', 'a', {}), batchedRpc(ns, 'acme', 'b', {})]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
  });

  it('keeps objects apart, and calls made one after another apart', async () => {
    const { ns, rpc, rpcBatch } = namespace();
    await Promise.all([batchedRpc(ns, 'acme', 'count', {}), batchedRpc(ns, 'fika', 'count', {})]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpcBatch).not.toHaveBeenCalled();
    await batchedRpc(ns, 'acme', 'count', {});
    await batchedRpc(ns, 'acme', 'list', {});
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpcBatch).not.toHaveBeenCalled();
  });
});

describe('cachedArgsSchema', () => {
  it('builds an action\'s schema once per isolate', () => {
    const make = vi.fn(() => ({ assert: (value: unknown) => value }));
    const first = cachedArgsSchema('main/createUser', make);
    const second = cachedArgsSchema('main/createUser', make);
    expect(first).toBe(second);
    expect(make).toHaveBeenCalledOnce();
  });
});

describe('SqliteDurableObject.rpcBatch', () => {
  it('runs each call through rpc in order, an error in its place without stopping the next', async () => {
    const order: string[] = [];
    const self = {
      rpc: async (action: string, args: { n: number }) => {
        order.push(action);
        if (action === 'fail') throw new RangeError('out of range');
        return args.n * 2;
      },
    };
    const results = await SqliteDurableObject.prototype.rpcBatch.call(
      self as never,
      [
        { action: 'double', args: { n: 1 } },
        { action: 'fail', args: { n: 2 } },
        { action: 'double', args: { n: 3 } },
      ],
      { instanceKey: 'acme' },
    );
    expect(order).toEqual(['double', 'fail', 'double']);
    expect(results).toEqual([
      { ok: true, value: 2 },
      { ok: false, error: { name: 'RangeError', message: 'out of range' } },
      { ok: true, value: 6 },
    ]);
  });
});
