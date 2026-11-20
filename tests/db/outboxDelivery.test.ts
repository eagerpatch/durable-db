import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSqlite } from '../../src/testing';
import type { OutboxDelivery, OutboxEnvelope, OutboxSink } from '../../src/db/outbox';

// The outbox's delivery (SqliteDurableObject's alarm) over a real in-memory
// SQLite: what the sink is handed, and what is kept, retried and moved aside.

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('@outerbase/browsable-durable-object', () => ({
  BrowsableHandler: class {},
  Browsable: () => (cls: any) => cls,
  studio: () => new Response('studio'),
}));

const { SqliteDurableObject } = await import('../../src/db/SqliteDurableObject');

/** The clock the object reads. */
let now = 1_000_000;

function createState() {
  const { DatabaseSync } = loadSqlite();
  const sqlite = new DatabaseSync(':memory:');
  let alarm: number | null = null;
  const state = {
    storage: {
      sql: {
        exec(query: string, ...params: unknown[]) {
          const rows = sqlite.prepare(query).all(...(params as never[]));
          return { toArray: () => rows };
        },
      },
      getCurrentBookmark: vi.fn().mockRejectedValue(new Error('PITR not available')),
      onNextSessionRestoreBookmark: vi.fn(),
      setAlarm: vi.fn(async (at: number) => {
        alarm = at;
      }),
      getAlarm: async () => alarm,
    },
    id: { toString: () => 'test-id' },
    abort: vi.fn(),
  };
  const rows = (table = '__outbox') =>
    sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
  return { state, sqlite, rows, alarmAt: () => alarm };
}

type Deliver = (envelopes: OutboxEnvelope[]) => OutboxDelivery | Promise<OutboxDelivery>;

/** A database the way a test drives it: `record()` is an action pushing messages, `deliver` the sink. */
function outboxDatabase(options: {
  name?: string;
  instance?: 'per-tenant' | 'global';
  devEpochSuffix?: string;
  maxAttempts?: number;
  className?: string;
}) {
  const handed: OutboxEnvelope[][] = [];
  let deliver: Deliver = () => {};
  class Database extends SqliteDurableObject {
    migrations = {};
    protected outboxSink: OutboxSink = {
      deliver: (envelopes) => {
        handed.push(envelopes);
        return deliver(envelopes);
      },
    };
    async record(instanceKey: string, messages: unknown[]): Promise<void> {
      const ctx: { instanceKey: string; outbox?: { push(message: unknown): void } } = { instanceKey };
      await this.runWithOutbox(ctx, async () => {
        for (const message of messages) ctx.outbox!.push(message as never);
      });
    }
  }
  if (options.className) Object.defineProperty(Database, 'name', { value: options.className });
  const { state, sqlite, rows, alarmAt } = createState();
  const database = new Database(state as never, {});
  const settings = database as unknown as Record<string, unknown>;
  if (options.name !== undefined) settings.databaseName = options.name;
  if (options.instance !== undefined) settings.databaseInstance = options.instance;
  if (options.devEpochSuffix !== undefined) settings.devEpochSuffix = options.devEpochSuffix;
  if (options.maxAttempts !== undefined) settings.outboxMaxAttempts = options.maxAttempts;
  return {
    database,
    sqlite,
    rows,
    alarmAt,
    handed,
    sink(next: Deliver) {
      deliver = next;
    },
  };
}

describe('the outbox delivery', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands the sink envelopes that name their database and how many deliveries failed before', async () => {
    const t = outboxDatabase({ name: 'billing' });
    await t.database.record('acme', [{ job: 'invoice-sent' }]);
    t.sink(() => {
      throw new Error('sink is down');
    });
    await t.database.alarm();
    now += 5_000;
    t.sink(() => {});
    await t.database.alarm();
    expect(t.handed.map((envelopes) => envelopes.map(({ database, attempts }) => ({ database, attempts })))).toEqual([
      [{ database: 'billing', attempts: 0 }],
      [{ database: 'billing', attempts: 1 }],
    ]);
    expect(t.handed[0]![0]).toEqual({
      message: { job: 'invoice-sent' },
      database: 'billing',
      instanceKey: 'acme',
      tenantId: 'acme',
      recordedAt: 1_000_000,
      attempts: 0,
    });
    expect(t.rows()).toEqual([]);
  });

  it('names a hand-written database by its class name when it sets no databaseName', async () => {
    for (const [className, database] of [
      ['OrderItemsDatabaseDO', 'order-items'],
      ['Ledger', 'Ledger'],
    ] as const) {
      const t = outboxDatabase({ className });
      await t.database.record('acme', ['x']);
      await t.database.alarm();
      expect(t.handed[0]![0]!.database).toBe(database);
    }
  });

  it("answers a per-tenant database's tenant named 'global' as that tenant, a global database's key as none", async () => {
    const perTenant = outboxDatabase({ name: 'main', instance: 'per-tenant' });
    await perTenant.database.record('global', ['for the tenant called global']);
    await perTenant.database.alarm();
    expect(perTenant.handed[0]![0]).toMatchObject({ instanceKey: 'global', tenantId: 'global' });

    const global = outboxDatabase({ name: 'catalog', instance: 'global' });
    await global.database.record('global', ['for everyone']);
    await global.database.alarm();
    expect(global.handed[0]![0]).toMatchObject({ database: 'catalog', instanceKey: 'global', tenantId: null });
  });

  it('keeps a tenant id containing "__dev_" whole in production, and strips exactly the epoch a dev build applied', async () => {
    const production = outboxDatabase({ name: 'main' });
    await production.database.record('team__dev_ops', ['x']);
    await production.database.alarm();
    expect(production.handed[0]![0]!.tenantId).toBe('team__dev_ops');

    const dev = outboxDatabase({ name: 'main', devEpochSuffix: '__dev_mw20' });
    await dev.database.record('team__dev_ops__dev_mw20', ['x']);
    await dev.database.alarm();
    expect(dev.handed[0]![0]).toMatchObject({ instanceKey: 'team__dev_ops__dev_mw20', tenantId: 'team__dev_ops' });
  });

  it('reads the tenant of a key an earlier dev epoch made (an object `db reset` left behind) without that epoch', async () => {
    // Rows recorded under the epoch k1 wait for their retry; `db reset` moved the build to k2.
    const dev = outboxDatabase({ name: 'main', devEpochSuffix: '__dev_k2' });
    await dev.database.record('acme__dev_k1', ['x']);
    await dev.database.record('team__dev_ops__dev_k1', ['y']);
    await dev.database.alarm();
    expect(dev.handed.flat().map(({ instanceKey, tenantId }) => ({ instanceKey, tenantId }))).toEqual([
      { instanceKey: 'acme__dev_k1', tenantId: 'acme' },
      { instanceKey: 'team__dev_ops__dev_k1', tenantId: 'team__dev_ops' },
    ]);

    // In production nothing is cut: the key is the tenant.
    const production = outboxDatabase({ name: 'main' });
    await production.database.record('acme__dev_k1', ['x']);
    await production.database.alarm();
    expect(production.handed[0]![0]!.tenantId).toBe('acme__dev_k1');
  });

  it('upgrades an outbox an older version created (no next_attempt_at) and delivers what it holds', async () => {
    const t = outboxDatabase({ name: 'main' });
    t.sqlite.exec(`CREATE TABLE __outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_key TEXT NOT NULL,
      message TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`);
    t.sqlite.exec(`INSERT INTO __outbox (instance_key, message, recorded_at, attempts) VALUES ('acme', '"left over"', 5, 2)`);
    await t.database.alarm();
    expect(t.handed).toEqual([[expect.objectContaining({ message: 'left over', recordedAt: 5, attempts: 2 })]]);
    const columns = (t.sqlite.prepare('PRAGMA table_info(__outbox)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['next_attempt_at', 'batch']));
    // Once is enough: a new message is recorded and delivered on the upgraded table.
    await t.database.record('acme', ['new']);
    await t.database.alarm();
    expect(t.handed[1]!.map((e) => e.message)).toEqual(['new']);
  });

  it('retries a failed message on its own clock, so it never holds back the messages behind it', async () => {
    const t = outboxDatabase({ name: 'main' });
    // The sink cannot take the poison message: every delivery that holds it throws.
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 'poison')) throw new Error('poison');
    });
    await t.database.record('acme', ['poison']);
    await t.database.alarm();
    expect(t.rows()).toMatchObject([{ message: '"poison"', attempts: 1, last_error: 'Error: poison', next_attempt_at: 1_005_000 }]);
    // The alarm comes back when the poison is due again.
    expect(t.alarmAt()).toBe(1_005_000);

    now += 1_000;
    await t.database.record('acme', ['fresh', 'fresher']);
    await t.database.alarm();
    expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['poison'], ['fresh', 'fresher']]);
    expect(t.rows().map((row) => row.message)).toEqual(['"poison"']);
    expect(t.alarmAt()).toBe(1_005_000);

    // Due again: retried alone, backing off further.
    now = 1_005_000;
    await t.database.alarm();
    expect(t.handed[2]!.map((e) => e.message)).toEqual(['poison']);
    expect(t.rows()).toMatchObject([{ attempts: 2, next_attempt_at: 1_015_000 }]);
  });

  it('cuts a message that fails every delivery holding it off from the ones it was delivered with', async () => {
    // The webhook answers 400 for P, and the sink throws for the delivery: A must not go down with it.
    const t = outboxDatabase({ name: 'main', maxAttempts: 5 });
    const delivered: unknown[] = [];
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 'P')) throw new Error('400 for P');
      delivered.push(...envelopes.map((e) => e.message));
    });
    await t.database.record('acme', ['A', 'P']);
    for (let alarm = 0; alarm < 20 && t.rows().length > 0; alarm++) {
      await t.database.alarm();
      now = Math.max(now, t.alarmAt() ?? now);
    }
    expect(delivered).toEqual(['A']);
    // A went at the first retry, alone; P failed alone from then on.
    expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['A', 'P'], ['A'], ['P'], ['P'], ['P'], ['P']]);
    expect(t.rows('__outbox_dead').map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: '"P"', attempts: 5 }]);
  });

  it('splits a failed delivery in two for its retry, each half a delivery of its own, until the failing message is alone', async () => {
    const t = outboxDatabase({ name: 'main' });
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 5)) throw new Error('5 bounced');
    });
    await t.database.record('acme', [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let alarm = 0; alarm < 8; alarm++) {
      await t.database.alarm();
      now = Math.max(now, t.alarmAt() ?? now);
    }
    // One delivery an alarm; every message but 5 delivered within three retries.
    expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [4, 5],
      [6, 7],
      [4],
      [5],
      [5],
    ]);
    expect(t.rows().map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: '5', attempts: 5 }]);

    // Messages recorded while 5 is due again are not taken into its delivery: they go with the other new ones.
    await t.database.record('acme', [8, 9]);
    await t.database.alarm();
    await t.database.alarm();
    expect(t.handed.slice(-2).map((envelopes) => envelopes.map((e) => e.message))).toEqual([[5], [8, 9]]);
  });

  it('of 100 messages pushed together, one of them bad, delivers the other 99 within seven retries (about ten minutes)', async () => {
    const t = outboxDatabase({ name: 'main' });
    const deliveredAt: Array<{ message: unknown; attempts: number; at: number }> = [];
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 63)) throw new Error('63 bounced');
      deliveredAt.push(...envelopes.map(({ message, attempts }) => ({ message, attempts, at: now })));
    });
    await t.database.record('acme', Array.from({ length: 100 }, (_, i) => i));
    for (let alarm = 0; alarm < 100 && deliveredAt.length < 99; alarm++) {
      await t.database.alarm();
      now = Math.max(now, t.alarmAt() ?? now);
    }
    expect(deliveredAt.map((d) => d.message).sort((a, b) => (a as number) - (b as number))).toEqual(
      Array.from({ length: 100 }, (_, i) => i).filter((i) => i !== 63),
    );
    expect(Math.max(...deliveredAt.map((d) => d.attempts))).toBe(7);
    expect(Math.max(...deliveredAt.map((d) => d.at)) - 1_000_000).toBe(5_000 + 10_000 + 20_000 + 40_000 + 80_000 + 160_000 + 300_000);
    // Fifteen deliveries, not one a message.
    expect(t.handed.length).toBe(15);
  });

  it('splits the envelopes a { retry } answers too, and moves the ones answered in { dead } aside at once', async () => {
    const t = outboxDatabase({ name: 'main' });
    await t.database.record('acme', [1, 2, 3, 4, 5]);
    const refused = new Error('the webhook answered 410 for 5');
    t.sink((envelopes) => ({
      retry: envelopes.filter((e) => e.message === 1 || e.message === 3),
      dead: envelopes.filter((e) => e.message === 5),
      error: refused,
    }));
    await t.database.alarm();
    expect(t.rows().map(({ message, attempts }) => ({ message, attempts }))).toEqual([
      { message: '1', attempts: 1 },
      { message: '3', attempts: 1 },
    ]);
    expect(t.rows('__outbox_dead')).toEqual([
      {
        id: 5,
        instance_key: 'acme',
        message: '5',
        recorded_at: 1_000_000,
        attempts: 1,
        last_error: 'Error: the webhook answered 410 for 5',
        dead_at: 1_000_000,
      },
    ]);
    const logged = errors.mock.calls.map(([text]) => String(text));
    expect(logged.some((text) => text.includes('1 outbox message(s) of main the sink answered in { dead }') && text.includes('__outbox_dead'))).toBe(
      true,
    );
    // 1 and 3 are retried each on its own.
    now += 5_000;
    t.sink(() => {});
    await t.database.alarm();
    await t.database.alarm();
    expect(t.handed.slice(1).map((envelopes) => envelopes.map((e) => e.message))).toEqual([[1], [3]]);
    expect(t.rows()).toEqual([]);
  });

  it('settles a delivery one by one: { retry } keeps exactly those, every other envelope of it delivered', async () => {
    const t = outboxDatabase({ name: 'main' });
    await t.database.record('acme', [1, 2, 3, 4]);
    const bounced = new Error('odd ones bounced');
    t.sink((envelopes) => ({ retry: envelopes.filter((e) => (e.message as number) % 2 === 1), error: bounced }));
    await t.database.alarm();
    expect(t.rows().map(({ message, attempts, last_error }) => ({ message, attempts, last_error }))).toEqual([
      { message: '1', attempts: 1, last_error: 'Error: odd ones bounced' },
      { message: '3', attempts: 1, last_error: 'Error: odd ones bounced' },
    ]);
    expect(String(errors.mock.calls[0]![0])).toContain('2 of 4 outbox message(s) of main not delivered (attempt 1 of 100); retrying in 5s');

    // A sink answering envelopes it was not handed delivered nothing: all of it is retried (1 and 3, each its own delivery now).
    now += 5_000;
    t.sink((envelopes) => ({ retry: envelopes.map((e) => ({ ...e })) }));
    await t.database.alarm();
    await t.database.alarm();
    expect(t.rows().map(({ message, attempts }) => ({ message, attempts }))).toEqual([
      { message: '1', attempts: 2 },
      { message: '3', attempts: 2 },
    ]);
  });

  it('delivers due messages oldest first, at most 100 a delivery, and comes back at once for the rest', async () => {
    const t = outboxDatabase({ name: 'main' });
    await t.database.record('acme', Array.from({ length: 150 }, (_, i) => i));
    await t.database.alarm();
    expect(t.handed[0]!.map((e) => e.message)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(t.alarmAt()).toBe(now);
    await t.database.alarm();
    expect(t.handed[1]!.map((e) => e.message)).toEqual(Array.from({ length: 50 }, (_, i) => i + 100));
    expect(t.rows()).toEqual([]);
  });

  it('records into a new outbox after destroyDatabase wiped the storage', async () => {
    const t = outboxDatabase({ name: 'main' });
    await t.database.record('acme', ['before']);
    // What sys('destroyDatabase') does: deleteAll(), then resetMigrationState().
    t.sqlite.exec('DROP TABLE __outbox');
    (t.database as unknown as { resetMigrationState(): void }).resetMigrationState();
    await t.database.record('acme', ['after']);
    expect(t.rows().map((row) => row.message)).toEqual(['"after"']);
  });

  it('moves a message that failed maxAttempts deliveries to __outbox_dead, logged, and never retries it', async () => {
    const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
    await t.database.record('acme', ['doomed']);
    t.sink(() => {
      throw new Error('sink is down');
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.database.alarm();
      now += 60_000;
    }
    expect(t.handed).toHaveLength(3);
    expect(t.rows()).toEqual([]);
    expect(t.rows('__outbox_dead')).toEqual([
      {
        id: 1,
        instance_key: 'acme',
        message: '"doomed"',
        recorded_at: 1_000_000,
        attempts: 3,
        last_error: 'Error: sink is down',
        dead_at: 1_120_000,
      },
    ]);
    const logged = errors.mock.calls.map(([text]) => String(text));
    expect(logged.at(-1)).toContain('1 outbox message(s) of main reached 3 failed deliveries');
    expect(logged.at(-1)).toContain('__outbox_dead');
    // Nothing left to deliver: no alarm, and another alarm hands the sink nothing.
    const scheduled = t.alarmAt();
    await t.database.alarm();
    expect(t.handed).toHaveLength(3);
    expect(t.alarmAt()).toBe(scheduled);
  });
});
