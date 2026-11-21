import { describe, it, expect, beforeEach } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';

/** The outbox in workerd: written with the action, delivered by the alarm, kept and retried when the sink fails. */
interface OutboxStub {
  record(instanceKey: string, messages: unknown[], fail?: boolean): Promise<number | string>;
  recordInOldOutbox(instanceKey: string, messages: unknown[]): Promise<void>;
  makeDue(): Promise<void>;
  sinkDown(): Promise<boolean>;
  outboxRows(): Promise<Array<{ message: string; tries: number; counted: number; last_error: string | null }>>;
  outboxColumns(): Promise<string[]>;
  deadRows(): Promise<Array<{ message: string; instance_key: string; attempts: number; last_error: string | null }>>;
  notes(): Promise<number>;
  alarmAt(): Promise<number | null>;
  startHeldDelivery(instanceKey: string, message: unknown): Promise<void>;
  destroyAndRecord(instanceKey: string, message: unknown): Promise<{ rows: Array<{ id: number; message: string; counted: number }>; threw: string | null }>;
  tenantInside(instanceKey: string): Promise<string>;
  holdSinkCall(calls: number): Promise<void>;
  sinkCallHeld(): Promise<boolean>;
  releaseHeld(): Promise<void>;
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
    // In one call — or, when the alarm that fired by itself found the sink down, the next try's message first.
    expect(await delivered()).toHaveLength(2);
    expect(await delivered()).toEqual(
      expect.arrayContaining([
        { message: { job: 'welcome', args: { id: 1 } }, database: 'notes', tenantId: 'acme', attempts: 0 },
        { message: 'second', database: 'notes', tenantId: 'acme', attempts: 0 },
      ]),
    );
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('records nothing for an action that throws', async () => {
    const stub = newStub();
    expect(await stub.record('acme', ['lost'], true)).toBe('the action failed');
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.alarmAt()).toBeNull();
  });

  it("keeps a message that failed alone with its error and retries it — a tenant named 'global' is that tenant", async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.record('global', ['retry me']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.tries ?? 0) >= 1);
    // Nothing else was delivered since it was recorded: not counted, and the sink is taken for down.
    expect(await stub.outboxRows()).toEqual([{ message: '"retry me"', tries: 1, counted: 0, last_error: 'Error: sink is down' }]);
    expect(await stub.sinkDown()).toBe(true);
    expect((await stub.alarmAt())! - Date.now()).toBeGreaterThan(1000);
    await testEnv.OUTBOX_LOG.delete('fail');
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'retry me', database: 'notes', tenantId: 'global', attempts: 0 }]);
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.sinkDown()).toBe(false);
  });

  it("delivers a global database's messages with no tenant, its database named", async () => {
    const stub = newStub(testEnv.TEST_GLOBAL_OUTBOX_DO);
    await stub.record('global', ['for everyone']);
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'for everyone', database: 'catalog', tenantId: null, attempts: 0 }]);
  });

  it('delivers more than one call, in order', async () => {
    const stub = newStub();
    await stub.record('acme', Array.from({ length: 150 }, (_, i) => i));
    await deliver(stub, async () => (await delivered()).length === 150);
    expect((await delivered()).map((d) => d.message)).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('upgrades an outbox 0.13 left (none of the new columns) and delivers what waits in it', async () => {
    const stub = newStub();
    await stub.recordInOldOutbox('acme', ['left over']);
    expect(await stub.outboxColumns()).not.toContain('tries');
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'left over', database: 'notes', tenantId: 'acme', attempts: 0 }]);
    expect(await stub.outboxColumns()).toEqual(expect.arrayContaining(['tries', 'counted', 'next_attempt_at', 'tried_at', 'failed_after']));
    await stub.record('acme', ['new']);
    await deliver(stub, async () => (await delivered()).length === 2);
    expect((await delivered()).map((d) => d.message)).toEqual(['left over', 'new']);
  });

  it('a message the sink cannot take holds back no message recorded after it', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('poison', '1');
    await stub.record('acme', ['poison']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.tries ?? 0) >= 1);
    // Alone, with nothing else delivered: the sink is taken for down until its next try.
    expect(await stub.sinkDown()).toBe(true);
    await stub.record('acme', ['fresh']);
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 1);
    // The next try hands the sink the newest message that failed least; then the poison fails alone again — counted.
    expect(await delivered()).toEqual([{ message: 'fresh', database: 'notes', tenantId: 'acme', attempts: 0 }]);
    expect(await stub.outboxRows()).toEqual([{ message: '"poison"', tries: 2, counted: 1, last_error: 'Error: poison' }]);
  });

  it('halves a call that fails until the message the sink cannot take is alone, in the same alarm', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('poison', '1');
    await stub.record('acme', ['innocent', 'poison']);
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'innocent', database: 'notes', tenantId: 'acme', attempts: 0 }]);
    // It failed alone after 'innocent' was delivered: counted.
    expect(await stub.outboxRows()).toEqual([{ message: '"poison"', tries: 1, counted: 1, last_error: 'Error: poison' }]);
  });

  it('settles a call one by one: the envelopes answered in { retry } are retried, the others delivered', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('retry-odd', '1');
    await stub.record('acme', [1, 2, 3, 4]);
    await deliver(stub, async () => (await delivered()).length === 2);
    expect((await delivered()).map((d) => d.message)).toEqual([2, 4]);
    expect(await stub.outboxRows()).toEqual([
      { message: '1', tries: 1, counted: 1, last_error: 'Error: odd ones bounced' },
      { message: '3', tries: 1, counted: 1, last_error: 'Error: odd ones bounced' },
    ]);
  });

  it('moves a message to __outbox_dead after maxAttempts counted failures, and stops retrying it', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('poison', '1');
    await stub.record('acme', ['poison']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.tries ?? 0) >= 1);
    // maxAttempts is 3 on this class: each time something else is delivered before it fails alone again, the failure counts.
    for (const [round, fine] of ['fine 1', 'fine 2', 'fine 3'].entries()) {
      await stub.record('acme', [fine]);
      await stub.makeDue();
      await deliver(
        stub,
        async () =>
          (await delivered()).some((d) => d.message === fine) &&
          ((await stub.deadRows()).length > 0 || ((await stub.outboxRows())[0]?.counted ?? 0) > round),
      );
    }
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.deadRows()).toEqual([{ message: '"poison"', instance_key: 'acme', attempts: 3, last_error: 'Error: poison' }]);
    expect(await stub.alarmAt()).toBeNull();
    expect((await delivered()).map((d) => d.message)).toEqual(['fine 1', 'fine 2', 'fine 3']);
  });

  it('takes the sink for down: what is recorded meanwhile waits for its next try, each try is one message, and nothing is counted', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.record('acme', ['a', 'b']);
    await deliver(stub, async () => stub.sinkDown());
    // Recorded while it is down: the alarm stays at the sink's next try.
    await stub.record('acme', ['c']);
    expect((await stub.alarmAt())! - Date.now()).toBeGreaterThan(1000);
    // Tried again and again, past maxAttempts (3): nothing counted, nothing buried.
    for (let attempt = 0; attempt < 5; attempt++) {
      await stub.makeDue();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await stub.sinkDown()).toBe(true);
    }
    expect(await stub.deadRows()).toEqual([]);
    expect((await stub.outboxRows()).map((row) => row.counted)).toEqual([0, 0, 0]);
    // Back: everything delivered.
    await testEnv.OUTBOX_LOG.delete('fail');
    await stub.makeDue();
    await deliver(stub, async () => (await delivered()).length === 3);
    expect((await delivered()).map((d) => d.message).sort()).toEqual(['a', 'b', 'c']);
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.sinkDown()).toBe(false);
  });

  it("stamps a message an action records while the alarm awaits a later sink call with the alarm's count: an outage after it counts nothing", async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('retry-odd', '1');
    // The first call delivers 2 and answers 1 and 3 for a retry; 1 fails alone; the call for 3 alone waits.
    await stub.holdSinkCall(2);
    await stub.record('acme', [2, 1, 3]);
    const alarm = runDurableObjectAlarm(stub);
    for (let i = 0; i < 100 && !(await stub.sinkCallHeld()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await stub.sinkCallHeld()).toBe(true);
    // An action runs while the alarm awaits the sink, after it delivered 2; then the sink goes down.
    expect(await stub.record('acme', ['x'])).toBe(1);
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.releaseHeld();
    await alarm;
    await deliver(stub, async () => (await stub.outboxRows()).some((row) => row.message === '"x"' && row.tries === 1));
    // 1 and 3 failed alone after 2 was delivered: counted. 'x' was recorded after that and failed alone with
    // nothing delivered since: not counted.
    expect(await stub.outboxRows()).toEqual([
      { message: '1', tries: 1, counted: 1, last_error: 'Error: odd ones bounced' },
      { message: '3', tries: 1, counted: 1, last_error: 'Error: sink is down' },
      { message: '"x"', tries: 1, counted: 0, last_error: 'Error: sink is down' },
    ]);
  });

  it('settles nothing on the storage deleteAll() left while the call was in flight: the new message with the old id is kept', async () => {
    const stub = newStub();
    await stub.startHeldDelivery('acme', 'old');
    const { rows, threw } = await stub.destroyAndRecord('acme', 'new');
    expect(threw).toBeNull();
    expect(rows).toEqual([{ id: 1, message: '"new"', counted: 0 }]);
  });

  it("answers getTenantId() inside a per-tenant object with its own tenant, never asking a resolver that reads a request", async () => {
    expect(await newStub().tenantInside('acme')).toBe('acme');
    expect(await newStub().tenantInside('global')).toBe('global');
    // A global database's object has no tenant of its own: the resolver is asked, as in the worker.
    expect(await newStub(testEnv.TEST_GLOBAL_OUTBOX_DO).tenantInside('global')).toBe('threw: no request in this context');
  });
});
