import { describe, it, expect, beforeEach } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';

/** The outbox in workerd: written with the action, delivered by the alarm, kept and retried when the sink fails. */
interface OutboxStub {
  record(instanceKey: string, messages: unknown[], fail?: boolean): Promise<number | string>;
  recordInOldOutbox(instanceKey: string, messages: unknown[]): Promise<void>;
  makeDue(): Promise<void>;
  outboxRows(): Promise<Array<{ message: string; attempts: number; last_error: string | null }>>;
  outboxColumns(): Promise<string[]>;
  deadRows(): Promise<Array<{ message: string; instance_key: string; attempts: number; last_error: string | null }>>;
  notes(): Promise<number>;
  alarmAt(): Promise<number | null>;
  startHeldDelivery(instanceKey: string, message: unknown): Promise<void>;
  destroyAndRecord(instanceKey: string, message: unknown): Promise<{ rows: Array<{ id: number; message: string; attempts: number }>; threw: string | null }>;
  tenantInside(instanceKey: string): Promise<string>;
}
interface TestEnv {
  TEST_OUTBOX_DO: DurableObjectNamespace;
  TEST_GLOBAL_OUTBOX_DO: DurableObjectNamespace;
  OUTBOX_LOG: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

function newStub(namespace: DurableObjectNamespace = testEnv.TEST_OUTBOX_DO): DurableObjectStub & OutboxStub {
  return namespace.get(namespace.idFromName(`o-${crypto.randomUUID()}`)) as never;
}
interface Delivered {
  message: unknown;
  database: string;
  tenantId: string | null;
  attempts: number;
}
const delivered = async () => JSON.parse((await testEnv.OUTBOX_LOG.get('delivered')) ?? '[]') as Delivered[];

/**
 * Runs the alarm until the outbox is empty or `until` holds. The alarm set to
 * "now" may also fire by itself in the test runtime: either way, what is
 * asserted is what the alarm did.
 */
async function deliver(stub: DurableObjectStub & OutboxStub, until: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50 && !(await until()); i++) {
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the outbox (real workerd)', () => {
  beforeEach(async () => {
    for (const key of ['delivered', 'fail', 'poison', 'retry-odd']) await testEnv.OUTBOX_LOG.delete(key);
  });

  it("writes an action's messages with its writes, then the alarm delivers and deletes them", async () => {
    const stub = newStub();
    // The sink is down: the messages stay where the action wrote them.
    await testEnv.OUTBOX_LOG.put('fail', '1');
    expect(await stub.record('acme', [{ job: 'welcome', args: { id: 1 } }, 'second'])).toBe(2);
    expect(await stub.notes()).toBe(1);
    expect((await stub.outboxRows()).map((row) => JSON.parse(row.message))).toEqual([{ job: 'welcome', args: { id: 1 } }, 'second']);
    await testEnv.OUTBOX_LOG.delete('fail');
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 2);
    // Delivered on the first try, or after the alarm that fired by itself found the sink down.
    const attempts = (await delivered())[0]!.attempts;
    expect(await delivered()).toEqual([
      { message: { job: 'welcome', args: { id: 1 } }, database: 'notes', tenantId: 'acme', attempts },
      { message: 'second', database: 'notes', tenantId: 'acme', attempts },
    ]);
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('records nothing for an action that throws', async () => {
    const stub = newStub();
    expect(await stub.record('acme', ['lost'], true)).toBe('the action failed');
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.alarmAt()).toBeNull();
  });

  it("keeps a failed delivery with its error and retries it with backoff — a tenant named 'global' is that tenant", async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.record('global', ['retry me']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.attempts ?? 0) >= 1);
    const [failed] = await stub.outboxRows();
    expect(failed!.attempts).toBe(1);
    expect(failed!.last_error).toBe('Error: sink is down');
    // The alarm waits for the row's own backoff.
    expect((await stub.alarmAt())! - Date.now()).toBeGreaterThan(1000);
    await testEnv.OUTBOX_LOG.delete('fail');
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'retry me', database: 'notes', tenantId: 'global', attempts: 1 }]);
    expect(await stub.outboxRows()).toEqual([]);
  });

  it("delivers a global database's messages with no tenant, its database named", async () => {
    const stub = newStub(testEnv.TEST_GLOBAL_OUTBOX_DO);
    await stub.record('global', ['for everyone']);
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'for everyone', database: 'catalog', tenantId: null, attempts: 0 }]);
  });

  it('delivers more than one batch, in order', async () => {
    const stub = newStub();
    await stub.record('acme', Array.from({ length: 150 }, (_, i) => i));
    await deliver(stub, async () => (await delivered()).length === 150);
    expect((await delivered()).map((d) => d.message)).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('upgrades an outbox an older version left (no next_attempt_at) and delivers what waits in it', async () => {
    const stub = newStub();
    await stub.recordInOldOutbox('acme', ['left over']);
    expect(await stub.outboxColumns()).not.toContain('next_attempt_at');
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'left over', database: 'notes', tenantId: 'acme', attempts: 0 }]);
    expect(await stub.outboxColumns()).toEqual(expect.arrayContaining(['next_attempt_at', 'batch']));
    await stub.record('acme', ['new']);
    await deliver(stub, async () => (await delivered()).length === 2);
    expect((await delivered()).map((d) => d.message)).toEqual(['left over', 'new']);
  });

  it('a message the sink cannot take does not hold back the ones recorded after it', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('poison', '1');
    await stub.record('acme', ['poison']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.attempts ?? 0) >= 1);
    await stub.record('acme', ['fresh']);
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'fresh', database: 'notes', tenantId: 'acme', attempts: 0 }]);
    expect(await stub.outboxRows()).toEqual([{ message: '"poison"', attempts: 1, last_error: 'Error: poison' }]);
  });

  it('cuts a message that fails every delivery holding it off from the one it was delivered with', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('poison', '1');
    await stub.record('acme', ['innocent', 'poison']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.attempts ?? 0) >= 1);
    expect(await delivered()).toEqual([]);
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'innocent', database: 'notes', tenantId: 'acme', attempts: 1 }]);
    const [poison, ...rest] = await stub.outboxRows();
    expect(rest).toEqual([]);
    expect(poison).toMatchObject({ message: '"poison"', last_error: 'Error: poison' });
    expect(poison!.attempts).toBeGreaterThanOrEqual(1);
  });

  it('settles a delivery one by one: the envelopes answered in { retry } are retried, the others delivered', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('retry-odd', '1');
    await stub.record('acme', [1, 2, 3, 4]);
    await deliver(stub, async () => (await delivered()).length === 2);
    expect((await delivered()).map((d) => d.message)).toEqual([2, 4]);
    expect(await stub.outboxRows()).toEqual([
      { message: '1', attempts: 1, last_error: 'Error: odd ones bounced' },
      { message: '3', attempts: 1, last_error: 'Error: odd ones bounced' },
    ]);
  });

  it('moves a message that failed maxAttempts deliveries to __outbox_dead and stops retrying it', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.record('acme', ['doomed']);
    // maxAttempts is 3 on this class: three failed deliveries, each once due.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await deliver(stub, async () => (await stub.deadRows()).length > 0 || ((await stub.outboxRows())[0]?.attempts ?? 0) >= attempt);
      await stub.makeDue();
    }
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.deadRows()).toEqual([{ message: '"doomed"', instance_key: 'acme', attempts: 3, last_error: 'Error: sink is down' }]);
    expect(await stub.alarmAt()).toBeNull();
    expect(await delivered()).toEqual([]);
  });

  it('settles nothing on the storage deleteAll() left while the delivery was in flight: the new message with the old id is kept', async () => {
    const stub = newStub();
    await stub.startHeldDelivery('acme', 'old');
    const { rows, threw } = await stub.destroyAndRecord('acme', 'new');
    expect(threw).toBeNull();
    expect(rows).toEqual([{ id: 1, message: '"new"', attempts: 0 }]);
  });

  it("answers getTenantId() inside a per-tenant object with its own tenant, never asking a resolver that reads a request", async () => {
    expect(await newStub().tenantInside('acme')).toBe('acme');
    expect(await newStub().tenantInside('global')).toBe('global');
    // A global database's object has no tenant of its own: the resolver is asked, as in the worker.
    expect(await newStub(testEnv.TEST_GLOBAL_OUTBOX_DO).tenantInside('global')).toBe('threw: no request in this context');
  });
});
