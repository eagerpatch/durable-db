import { describe, it, expect, beforeEach } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';

/** The outbox in workerd: written with the action, delivered by the alarm, kept and retried when the sink fails. */
interface OutboxStub {
  record(instanceKey: string, messages: unknown[], fail?: boolean): Promise<number | string>;
  outboxRows(): Promise<Array<{ message: string; attempts: number; last_error: string | null }>>;
  notes(): Promise<number>;
  alarmAt(): Promise<number | null>;
}
interface TestEnv {
  TEST_OUTBOX_DO: DurableObjectNamespace;
  OUTBOX_LOG: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

function newStub(): DurableObjectStub & OutboxStub {
  return testEnv.TEST_OUTBOX_DO.get(testEnv.TEST_OUTBOX_DO.idFromName(`o-${crypto.randomUUID()}`)) as never;
}
const delivered = async () => JSON.parse((await testEnv.OUTBOX_LOG.get('delivered')) ?? '[]') as Array<{ message: unknown; tenantId: string | null }>;

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
    await testEnv.OUTBOX_LOG.delete('delivered');
    await testEnv.OUTBOX_LOG.delete('fail');
  });

  it("writes an action's messages with its writes, then the alarm delivers and deletes them", async () => {
    const stub = newStub();
    // The sink is down: the messages stay where the action wrote them.
    await testEnv.OUTBOX_LOG.put('fail', '1');
    expect(await stub.record('acme', [{ job: 'welcome', args: { id: 1 } }, 'second'])).toBe(2);
    expect(await stub.notes()).toBe(1);
    expect((await stub.outboxRows()).map((row) => JSON.parse(row.message))).toEqual([{ job: 'welcome', args: { id: 1 } }, 'second']);
    await testEnv.OUTBOX_LOG.delete('fail');
    await deliver(stub, async () => (await delivered()).length === 2);
    expect(await delivered()).toEqual([
      { message: { job: 'welcome', args: { id: 1 } }, tenantId: 'acme' },
      { message: 'second', tenantId: 'acme' },
    ]);
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('records nothing for an action that throws', async () => {
    const stub = newStub();
    expect(await stub.record('acme', ['lost'], true)).toBe('the action failed');
    expect(await stub.outboxRows()).toEqual([]);
    expect(await stub.alarmAt()).toBeNull();
  });

  it('keeps a failed delivery with its error and retries it with backoff', async () => {
    const stub = newStub();
    await testEnv.OUTBOX_LOG.put('fail', '1');
    await stub.record('global', ['retry me']);
    await deliver(stub, async () => ((await stub.outboxRows())[0]?.attempts ?? 0) >= 1);
    const [failed] = await stub.outboxRows();
    expect(failed!.attempts).toBeGreaterThanOrEqual(1);
    expect(failed!.last_error).toBe('Error: sink is down');
    expect((await stub.alarmAt())! - Date.now()).toBeGreaterThan(1000);
    await testEnv.OUTBOX_LOG.delete('fail');
    await deliver(stub, async () => (await delivered()).length === 1);
    expect(await delivered()).toEqual([{ message: 'retry me', tenantId: null }]);
    expect(await stub.outboxRows()).toEqual([]);
  });

  it('delivers more than one batch, in order', async () => {
    const stub = newStub();
    await stub.record('acme', Array.from({ length: 150 }, (_, i) => i));
    await deliver(stub, async () => (await delivered()).length === 150);
    expect((await delivered()).map((d) => d.message)).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(await stub.outboxRows()).toEqual([]);
  });
});
