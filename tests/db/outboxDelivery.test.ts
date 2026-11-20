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
    expect(columns).toContain('next_attempt_at');
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

    // A sink answering envelopes it was not handed delivered nothing: all of it is retried.
    now += 5_000;
    t.sink((envelopes) => ({ retry: envelopes.map((e) => ({ ...e })) }));
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
