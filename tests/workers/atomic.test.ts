import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * An action is one transaction of its object (`runAction`), against a real
 * workerd: all of its writes and messages or none, no other call of the
 * object in between, a part that may fail on its own (`ctx.transaction`),
 * Kysely's own transactions refused, and a call back into an object waiting
 * on it refused at once instead of waiting 30 s for itself.
 */
type Result = { ok: true; value: unknown } | { ok: false; error: string };
type State = { vouchers: unknown[]; lines: string[]; balance: number | null; messages: unknown[] };

interface AtomicEnv {
  TEST_ATOMIC_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub & {
      call: (method: string, args: unknown, instanceKey?: string) => Promise<Result>;
      state: () => Promise<State>;
    };
  };
}

const atomic = (env as unknown as AtomicEnv).TEST_ATOMIC_DO;
const newObject = () => atomic.get(atomic.idFromName(`atomic-${crypto.randomUUID()}`));

describe('an action is one transaction (real workerd)', () => {
  it('keeps none of its writes when a statement fails part-way', async () => {
    const object = newObject();
    expect(await object.call('post', { number: 1 })).toEqual({ ok: true, value: 1 });
    const failed = await object.call('post', { number: 2, again: true });
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/UNIQUE constraint failed/) });
    const state = await object.state();
    expect(state.vouchers).toEqual([{ series: 'A', number: 1 }]);
    expect(state.lines).toEqual(['debit 1', 'credit 1']);
  });

  it('records no message when it throws after pushing, and its writes go too', async () => {
    const object = newObject();
    expect(await object.call('pushThenThrow', {})).toEqual({ ok: false, error: 'after the push' });
    expect(await object.call('pushAndWrite', {})).toEqual({ ok: true, value: 'ok' });
    const state = await object.state();
    expect(state.lines).toEqual(['pushed']);
    expect(state.messages).toEqual([{ job: 'kept' }]);
  });

  it('runs calls of the object one after the other, also across an await on I/O', async () => {
    const object = newObject();
    await object.call('noop', {});
    const sums = await Promise.all(Array.from({ length: 5 }, () => object.call('addToBalance', { amount: 10, wait: 15 })));
    expect(sums.map((sum) => (sum as { value: number }).value).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    expect((await object.state()).balance).toBe(50);
  });

  it('runs the calls that waited on its migrations one after the other', async () => {
    const object = newObject();
    const sums = await Promise.all(Array.from({ length: 5 }, () => object.call('addToBalance', { amount: 10 })));
    expect(sums.every((sum) => sum.ok)).toBe(true);
    expect((await object.state()).balance).toBe(50);
  });

  it('rolls back a part that fails on its own — its writes and its messages — and goes on', async () => {
    const object = newObject();
    expect(await object.call('withPart', { fail: true })).toEqual({ ok: true, value: 'the part failed' });
    expect(await object.state()).toMatchObject({ lines: ['before', 'after'], messages: ['outer'] });
    expect(await object.call('withPart', { fail: false })).toEqual({ ok: true, value: null });
    expect(await object.state()).toMatchObject({ lines: ['before', 'after', 'before', 'part', 'after'], messages: ['outer', 'outer', 'part'] });
  });

  it('runs two parts started at once one after the other', async () => {
    const object = newObject();
    const result = await object.call('siblingParts', {});
    expect(result).toEqual({ ok: true, value: ['first starts', 'first throws', 'first rolled back', 'second starts', 'second ends'] });
    expect((await object.state()).lines).toEqual(['second']);
  });

  it('rolls back an action of the same database called from it when that one throws', async () => {
    const object = newObject();
    expect(await object.call('callsFailing', {})).toEqual({ ok: true, value: 'the callee failed' });
    expect((await object.state()).lines).toEqual(['caller before', 'caller after']);
  });

  it("refuses Kysely's db.transaction(), naming ctx.transaction()", async () => {
    const object = newObject();
    const result = await object.call('kyselyTransaction', {});
    expect(result).toMatchObject({ ok: true, value: expect.stringContaining('ctx.transaction(') });
    expect((await object.state()).lines).toEqual([]);
  });

  it('refuses at once a call back into an object waiting on it', async () => {
    const object = newObject();
    const result = (await object.call('callOther', {})) as { ok: true; value: { error: string | null; ms: number } };
    expect(result.ok).toBe(true);
    expect(result.value.error).toMatch(/^ActionCycleError: \[db\] noop: a call into ledger \(acme\), which is waiting on this call: ledger \(acme\) → other \(acme\) → ledger \(acme\)/);
    expect(result.value.ms).toBeLessThan(5_000);
    // The object was not reset: it answers.
    expect(await object.call('noop', {})).toEqual({ ok: true, value: 'noop' });
  });

  it('calls another database from an action', async () => {
    expect(await newObject().call('callOtherPlainly', {})).toEqual({ ok: true, value: 'echo' });
  });
});
