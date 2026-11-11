import { describe, it, expect, vi } from 'vitest';
import { createActionOutbox, outboxRetryDelay, outboxSink, queueOutboxSink, tenantOfInstanceKey } from '../../src/db/outbox';
import { generateDurableObjectsModule } from '../../src/vite/modules/generator';
import type { DatabaseInfo } from '../../src/db';

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
    const envelopes = Array.from({ length: 150 }, (_, i) => ({ message: { n: i }, instanceKey: 'acme', tenantId: 'acme', recordedAt: 0 }));
    await queueOutboxSink('JOBS').deliver(envelopes, { env: { JOBS: { sendBatch } } });
    expect(sendBatch.mock.calls.map(([batch]) => (batch as unknown[]).length)).toEqual([100, 50]);
    expect((sendBatch.mock.calls[0] as unknown as [Array<{ body: unknown }>])[0][0]).toEqual({ body: { n: 0 } });
    await expect(queueOutboxSink('NOPE').deliver(envelopes, { env: {} })).rejects.toThrow('Queue binding NOPE');
  });

  it('takes a sink module as a function or an object with deliver', () => {
    const deliver = async () => {};
    expect(outboxSink(deliver).deliver).toBe(deliver);
    expect(outboxSink({ deliver }).deliver).toBe(deliver);
    expect(() => outboxSink({} as never)).toThrow('default-export a deliver function');
  });

  it("names an instance key's tenant, null for a global database (dev epoch dropped)", () => {
    expect(tenantOfInstanceKey('acme')).toBe('acme');
    expect(tenantOfInstanceKey('acme__dev_abc')).toBe('acme');
    expect(tenantOfInstanceKey('global')).toBeNull();
    expect(tenantOfInstanceKey('global__dev_abc')).toBeNull();
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
