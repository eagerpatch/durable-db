import { describe, it, expect, vi } from 'vitest';
import {
  createActionOutbox,
  outboxRetryDelay,
  outboxSink,
  queueOutboxSink,
  settleOutboxDelivery,
  tenantOfInstanceKey,
  type OutboxEnvelope,
} from '../../src/db/outbox';
import { generateDurableObjectsModule } from '../../src/vite/modules/generator';
import type { DatabaseInfo } from '../../src/db';

const envelope = (message: unknown, rest: Partial<OutboxEnvelope> = {}): OutboxEnvelope => ({
  message,
  database: 'main',
  instanceKey: 'acme',
  tenantId: 'acme',
  recordedAt: 0,
  attempts: 0,
  ...rest,
});

describe('the outbox', () => {
  it('collects JSON messages for one action run, and refuses without a sink, naming the option', () => {
    const outbox = createActionOutbox(true);
    outbox.push({ job: 'welcome', args: { id: 1 } });
    outbox.push('plain');
    expect(outbox.take()).toEqual(['{"job":"welcome","args":{"id":1}}', '"plain"']);
    expect(outbox.take()).toEqual([]);
    expect(() => outbox.push(undefined as never)).toThrow('a message must be a JSON value');
    expect(() => createActionOutbox(false).push('x')).toThrow(/no outbox sink is configured — durableDb\(\{ outbox/);
  });

  it('sends to a Queue binding in batches of 100, each message as it was pushed', async () => {
    const sendBatch = vi.fn(async () => {});
    const envelopes = Array.from({ length: 150 }, (_, i) => envelope({ n: i }));
    expect(await queueOutboxSink('JOBS').deliver(envelopes, { env: { JOBS: { sendBatch } } })).toBeUndefined();
    expect(sendBatch.mock.calls.map(([batch]) => (batch as unknown[]).length)).toEqual([100, 50]);
    expect((sendBatch.mock.calls[0] as unknown as [Array<{ body: unknown }>])[0][0]).toEqual({ body: { n: 0 } });
    await expect(queueOutboxSink('NOPE').deliver(envelopes, { env: {} })).rejects.toThrow('Queue binding NOPE');
  });

  it('answers the envelopes a failed sendBatch left unsent for a retry, the batches before it delivered', async () => {
    const down = new Error('queue is down');
    const sendBatch = vi.fn(async () => {
      if (sendBatch.mock.calls.length === 2) throw down;
    });
    const envelopes = Array.from({ length: 250 }, (_, i) => envelope(i));
    const answer = await queueOutboxSink('JOBS').deliver(envelopes, { env: { JOBS: { sendBatch } } });
    expect(answer).toEqual({ retry: envelopes.slice(100), error: down });
    expect((answer as { retry: OutboxEnvelope[] }).retry[0]).toBe(envelopes[100]);
    // Nothing went: every envelope is retried.
    const failing = vi.fn(async () => {
      throw down;
    });
    expect(await queueOutboxSink('JOBS').deliver(envelopes.slice(0, 10), { env: { JOBS: { sendBatch: failing } } })).toEqual({
      retry: envelopes.slice(0, 10),
      error: down,
    });
  });

  it('settles a delivery: nothing answered delivered all, { retry } retries exactly those', () => {
    const [a, b, c] = [envelope('a'), envelope('b'), envelope('c')];
    expect(settleOutboxDelivery([a, b, c], undefined).retry.size).toBe(0);
    // A sink that returns a value of its own (a fetch's Response) delivered everything, as before { retry }.
    expect(settleOutboxDelivery([a, b, c], { ok: true, status: 200 }).retry.size).toBe(0);
    expect(settleOutboxDelivery([a, b, c], { retry: [] }).retry.size).toBe(0);
    const why = new Error('b bounced');
    const settled = settleOutboxDelivery([a, b, c], { retry: [b, b], error: why });
    expect([...settled.retry]).toEqual([b]);
    expect(settled.error).toBe(why);
    expect(String(settleOutboxDelivery([a, b, c], { retry: [c] }).error)).toContain('answered it in { retry }');
  });

  it('retries every envelope of a delivery whose { retry } names one it was not handed', () => {
    const [a, b] = [envelope('a'), envelope('b')];
    for (const answer of [{ retry: [{ ...a }] }, { retry: 'a' }, { retry: [a, envelope('x')] }]) {
      const settled = settleOutboxDelivery([a, b], answer);
      expect(settled.retry).toEqual(new Set([a, b]));
      expect(String(settled.error)).toContain('answer the envelope objects it was handed');
    }
  });

  it('takes a sink module as a function or an object with deliver', () => {
    const deliver = async () => {};
    expect(outboxSink(deliver).deliver).toBe(deliver);
    expect(outboxSink({ deliver }).deliver).toBe(deliver);
    expect(() => outboxSink({} as never)).toThrow('default-export a deliver function');
  });

  it("names a per-tenant instance key's tenant, a tenant named 'global' too; a global database's key has none", () => {
    const perTenant = { instance: 'per-tenant' } as const;
    expect(tenantOfInstanceKey('acme', perTenant)).toBe('acme');
    expect(tenantOfInstanceKey('global', perTenant)).toBe('global');
    expect(tenantOfInstanceKey('global', { instance: 'global' })).toBeNull();
    expect(tenantOfInstanceKey('global__dev_abc', { instance: 'global', devEpochSuffix: '__dev_abc' })).toBeNull();
  });

  it('keeps a tenant id containing "__dev_" whole in production (no suffix applied)', () => {
    expect(tenantOfInstanceKey('team__dev_ops', { instance: 'per-tenant' })).toBe('team__dev_ops');
    expect(tenantOfInstanceKey('team__dev_ops', { instance: 'per-tenant', devEpochSuffix: '' })).toBe('team__dev_ops');
  });

  it('strips exactly the dev epoch the build applied, and only where the key ends with it', () => {
    const dev = { instance: 'per-tenant', devEpochSuffix: '__dev_mw20' } as const;
    expect(tenantOfInstanceKey('acme__dev_mw20', dev)).toBe('acme');
    expect(tenantOfInstanceKey('team__dev_ops__dev_mw20', dev)).toBe('team__dev_ops');
    expect(tenantOfInstanceKey('global__dev_mw20', dev)).toBe('global');
    // A key of another epoch (an object `db reset` left behind) is not cut at a guess.
    expect(tenantOfInstanceKey('acme__dev_old', dev)).toBe('acme__dev_old');
  });

  it('refuses a key alone: the instance kind decides', () => {
    expect(() => (tenantOfInstanceKey as (key: string) => string | null)('global')).toThrow("say the database's instance kind");
  });

  it('backs off 5 s, doubling, at most 5 minutes', () => {
    expect([1, 2, 3, 7, 20].map(outboxRetryDelay)).toEqual([5_000, 10_000, 20_000, 300_000, 300_000]);
  });
});

describe('the generated Durable Objects and the outbox', () => {
  const database: DatabaseInfo = {
    filePath: '/app/src/databases/main.ts',
    name: 'main',
    className: 'MainDatabaseDO',
    bindingName: 'MAIN_DATABASE_DO',
    instance: 'per-tenant',
    migrationsDir: 'migrations/main',
    schemaImport: null,
    schemaExport: null,
    schemaTableNames: [],
    browsable: false,
    transport: 'rpc',
  };

  it('runs every handler with ctx.outbox, and sets no sink without the option', () => {
    const code = generateDurableObjectsModule([database], 'durable-db/registry');
    expect(code).toContain('this.runWithOutbox(ctx, async () => entry.handler(this.db, validated, ctx))');
    expect(code).not.toContain('outboxSink');
    expect(code).not.toContain('outboxMaxAttempts');
  });

  it("gives every class its instance kind and the epoch suffix the build applies to its keys", () => {
    const code = generateDurableObjectsModule([database, { ...database, name: 'catalog', className: 'CatalogDatabaseDO', instance: 'global' }], 'durable-db/registry');
    expect(code).toMatch(/import \{ applyDevEpoch \} from "virtual:durable-db\/__devEpoch"/);
    expect(code).toMatch(/class MainDatabaseDO extends SqliteDurableObject \{[\s\S]*?databaseInstance = "per-tenant";\s*devEpochSuffix = applyDevEpoch\("", "main"\);/);
    expect(code).toMatch(/class CatalogDatabaseDO extends SqliteDurableObject \{[\s\S]*?databaseInstance = "global";\s*devEpochSuffix = applyDevEpoch\("", "catalog"\);/);
  });

  it('hands an action the tenant the object worked out (rpc and WebSocket alike)', () => {
    const code = generateDurableObjectsModule([{ ...database, transport: 'websocket' }], 'durable-db/registry');
    expect(code.match(/instanceKey: ctx\.instanceKey,\s*tenantId: this\.tenantOf\(ctx\.instanceKey\)/g)).toHaveLength(2);
  });

  it('sets outboxMaxAttempts only when the option says', () => {
    expect(generateDurableObjectsModule([database], 'durable-db/registry', false, [], [], { queue: 'JOBS', maxAttempts: 12 })).toContain(
      'outboxMaxAttempts = 12',
    );
    expect(generateDurableObjectsModule([database], 'durable-db/registry', false, [], [], { module: '/app/src/outbox.ts' })).not.toContain(
      'outboxMaxAttempts',
    );
  });

  it('gives every class the Queue sink of { queue }', () => {
    const code = generateDurableObjectsModule([database], 'durable-db/registry', false, [], [], { queue: 'JOBS' });
    expect(code).toMatch(/import \{ queueOutboxSink \} from "durable-db\/db"/);
    expect(code).toContain('const __ddOutbox = queueOutboxSink("JOBS")');
    expect(code).toContain('outboxSink = __ddOutbox');
  });

  it("gives every class the module sink of { module }: the module's default export", () => {
    const code = generateDurableObjectsModule([database], 'durable-db/registry', false, [], [], { module: '/app/src/outbox.ts' });
    expect(code).toContain('import __ddOutboxModule from "/app/src/outbox.ts"');
    expect(code).toContain('const __ddOutbox = outboxSink(__ddOutboxModule)');
    expect(code).toContain('outboxSink = __ddOutbox');
  });
});
