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

/** A Queue binding that refuses what Cloudflare Queues refuses: a sendBatch of more than 100 messages or 256 KB, a message over 128 KB (about 100 bytes of each the queue's own). */
function strictQueue() {
  const sent: unknown[][] = [];
  const bytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).byteLength + 100;
  const sendBatch = vi.fn(async (messages: Array<{ body: unknown; contentType?: string }>) => {
    if (messages.some((m) => m.contentType !== 'json')) throw new Error('sent as something other than JSON');
    if (messages.length > 100) throw new Error('Too many messages in the batch');
    const sizes = messages.map((m) => bytes(m.body));
    if (sizes.some((size) => size > 128_000)) throw new Error('Message too large');
    if (sizes.reduce((sum, size) => sum + size, 0) > 256_000) throw new Error('Batch too large');
    sent.push(messages.map((m) => m.body));
  });
  return { sent, sendBatch };
}

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
    expect((sendBatch.mock.calls[0] as unknown as [Array<{ body: unknown }>])[0][0]).toEqual({ body: { n: 0 }, contentType: 'json' });
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

  it("packs a Queue's sendBatch by its bytes as well as its count: at most 100 messages and 256 KB a call", async () => {
    const queue = strictQueue();
    // 100 email jobs of about 3 KB: one sendBatch of them would be 310 KB.
    const emails = Array.from({ length: 100 }, (_, i) => envelope({ job: 'email', html: 'x'.repeat(3_000), i }));
    expect(await queueOutboxSink('JOBS').deliver(emails, { env: { JOBS: queue } })).toBeUndefined();
    expect(queue.sent.flat()).toEqual(emails.map((e) => e.message));
    expect(queue.sent.length).toBeGreaterThan(1);
    // Bytes, not characters: three messages of 50 000 'å' are 150 KB of text and 300 KB of UTF-8.
    const wide = strictQueue();
    const letters = Array.from({ length: 3 }, () => envelope('å'.repeat(50_000)));
    expect(await queueOutboxSink('JOBS').deliver(letters, { env: { JOBS: wide } })).toBeUndefined();
    expect(wide.sent.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('answers a message too large for a queue message in { dead } at once, and sends the others', async () => {
    const queue = strictQueue();
    const small = Array.from({ length: 99 }, (_, i) => envelope(i));
    const large = envelope({ job: 'import', rows: 'x'.repeat(200_000) });
    const answer = (await queueOutboxSink('JOBS').deliver([...small.slice(0, 50), large, ...small.slice(50)], { env: { JOBS: queue } })) as {
      retry?: OutboxEnvelope[];
      dead: OutboxEnvelope[];
      error: unknown;
    };
    expect(queue.sent.flat()).toEqual(small.map((e) => e.message));
    expect(answer.retry).toBeUndefined();
    expect(answer.dead).toEqual([large]);
    expect(answer.dead[0]).toBe(large);
    expect(String(answer.error)).toMatch(/1 message\(s\) of 200\d{3} bytes, more than a queue message holds \(128000\)/);

    // Both at once: the unsent ones retried, the large one given up on, the error saying both.
    const down = new Error('queue is down');
    const failing = vi.fn(async () => {
      throw down;
    });
    const both = (await queueOutboxSink('JOBS').deliver([small[0]!, large], { env: { JOBS: { sendBatch: failing } } })) as {
      retry: OutboxEnvelope[];
      dead: OutboxEnvelope[];
      error: unknown;
    };
    expect(both.retry).toEqual([small[0]]);
    expect(both.dead).toEqual([large]);
    expect(String(both.error)).toContain('queue is down');
    expect(String(both.error)).toContain('more than a queue message holds');
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
    // The sink said which, and delivered the others: b's failure is its own.
    expect(settled.named).toBe(true);
    expect(settled.delivered).toBe(2);
    expect(String(settleOutboxDelivery([a, b, c], { retry: [c] }).error)).toContain('answered it in { retry }');
    // A { retry } of everything it did not give up on — a Queue whose first sendBatch failed — says no more than a
    // throw: the delivery failed whole, no envelope's own.
    for (const answer of [{ retry: [a, b, c] }, { retry: [a, b], dead: [c] }]) {
      expect(settleOutboxDelivery([a, b, c], answer)).toMatchObject({ named: false, delivered: 0 });
    }
  });

  it('settles the envelopes a delivery answers in { dead }: given up on, the others delivered', () => {
    const [a, b, c] = [envelope('a'), envelope('b'), envelope('c')];
    const gone = new Error('410 for c');
    const settled = settleOutboxDelivery([a, b, c], { retry: [a], dead: [c], error: gone });
    expect([...settled.retry]).toEqual([a]);
    expect([...settled.dead]).toEqual([c]);
    expect(settled.error).toBe(gone);
    expect(settled.deadError).toBe(gone);
    const alone = settleOutboxDelivery([a, b, c], { dead: [b] });
    expect([...alone.retry]).toEqual([]);
    expect([...alone.dead]).toEqual([b]);
    expect(String(alone.deadError)).toContain('answered it in { dead }');
    // An envelope both retried and given up on is the sink's mistake: every envelope is retried.
    for (const answer of [{ retry: [a], dead: [a] }, { dead: 'c' }, { dead: [{ ...c }] }]) {
      const mistaken = settleOutboxDelivery([a, b, c], answer);
      expect(mistaken.retry).toEqual(new Set([a, b, c]));
      expect(mistaken.dead.size).toBe(0);
    }
  });

  it('retries every envelope of a delivery whose { retry } names one it was not handed', () => {
    const [a, b] = [envelope('a'), envelope('b')];
    for (const answer of [{ retry: [{ ...a }] }, { retry: 'a' }, { retry: [a, envelope('x')] }]) {
      const settled = settleOutboxDelivery([a, b], answer);
      expect(settled.retry).toEqual(new Set([a, b]));
      expect(String(settled.error)).toContain('answer the envelope objects it was handed');
      // Retried whole, as a throw is: no envelope's own failure.
      expect(settled.named).toBe(false);
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
  });

  it("in dev, reads a key of an earlier epoch (an object `db reset` left behind) without that epoch: every dev key has one", () => {
    const dev = { instance: 'per-tenant', devEpochSuffix: '__dev_mw20' } as const;
    expect(tenantOfInstanceKey('acme__dev_mw1z', dev)).toBe('acme');
    expect(tenantOfInstanceKey('team__dev_ops__dev_mw1z', dev)).toBe('team__dev_ops');
    // A key without an epoch is kept whole; in production a key is the tenant whole.
    expect(tenantOfInstanceKey('acme', dev)).toBe('acme');
    expect(tenantOfInstanceKey('acme__dev_mw1z', { instance: 'per-tenant' })).toBe('acme__dev_mw1z');
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
