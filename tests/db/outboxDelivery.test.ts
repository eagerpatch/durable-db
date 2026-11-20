import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSqlite } from '../../src/testing';
import { queueOutboxSink, type OutboxDelivery, type OutboxEnvelope, type OutboxSink } from '../../src/db/outbox';

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
  /** Rows written (INSERT, UPDATE, DELETE), and the reads of `__outbox` itself, since the test began. */
  const counted = { written: 0, outboxReads: 0 };
  const state = {
    storage: {
      sql: {
        exec(query: string, ...params: unknown[]) {
          const statement = sqlite.prepare(query);
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
            counted.written += Number(statement.run(...(params as never[])).changes);
            return { toArray: () => [] };
          }
          if (/^\s*SELECT\b[\s\S]*\bFROM __outbox\b/i.test(query)) counted.outboxReads++;
          const rows = statement.all(...(params as never[]));
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
  return {
    state,
    sqlite,
    rows,
    alarmAt: () => alarm,
    clearAlarm: () => {
      alarm = null;
    },
    counted,
  };
}

type Deliver = (envelopes: readonly OutboxEnvelope[]) => OutboxDelivery | Promise<OutboxDelivery>;

/** A database the way a test drives it: `record()` is an action pushing messages, `deliver` the sink. */
function outboxDatabase(options: {
  name?: string;
  instance?: 'per-tenant' | 'global';
  devEpochSuffix?: string;
  maxAttempts?: number;
  className?: string;
}) {
  const handed: Array<readonly OutboxEnvelope[]> = [];
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
  const { state, sqlite, rows, alarmAt, clearAlarm, counted } = createState();
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
    counted,
    handed,
    /**
     * Runs every alarm due until `ms` from now, recording a message each
     * `every` ms when given; answers how many alarms ran. The clock moves to
     * each alarm's time.
     */
    async run(ms: number, every?: { ms: number; record: (at: number) => unknown[] }): Promise<number> {
      const end = now + ms;
      let push = every ? now + every.ms : Infinity;
      let alarms = 0;
      for (;;) {
        const at = alarmAt();
        const next = Math.min(at === null ? Infinity : Math.max(at, now), push);
        if (next > end) break;
        now = next;
        if (next === push) {
          await database.record('acme', every!.record(now));
          push += every!.ms;
          continue;
        }
        clearAlarm();
        alarms++;
        await database.alarm();
      }
      now = end;
      return alarms;
    },
    /** `__outbox_dead`'s rows, none while nothing was moved there. */
    dead: () =>
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__outbox_dead'`).all().length > 0
        ? rows('__outbox_dead')
        : [],
    sink(next: Deliver) {
      deliver = next;
    },
  };
}

/** An outbox as durable-db 0.13 left it: no next_attempt_at, no batch. */
const OUTBOX_0_13 = `CREATE TABLE __outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
)`;

/** What sys('destroyDatabase') does: deleteAll() — every table, the AUTOINCREMENT counters with them — then resetMigrationState(). */
function destroy(t: ReturnType<typeof outboxDatabase>): void {
  const tables = t.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  for (const { name } of tables) t.sqlite.exec(`DROP TABLE ${name}`);
  t.sqlite.exec('DELETE FROM sqlite_sequence');
  (t.database as unknown as { resetMigrationState(): void }).resetMigrationState();
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

  it('upgrades an outbox an older version created (no next_attempt_at) and delivers what it holds, its attempts counted from 0', async () => {
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
    // 0.13 counted its batch's failures on every row of it: the upgrade starts the row's own count.
    expect(t.handed).toEqual([[expect.objectContaining({ message: 'left over', recordedAt: 5, attempts: 0 })]]);
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
    for (let alarm = 0; alarm < 6; alarm++) {
      await t.database.alarm();
      now = Math.max(now, t.alarmAt() ?? now);
    }
    expect(delivered).toEqual(['A']);
    // A went at the first retry, alone; P failed alone from then on.
    expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['A', 'P'], ['A'], ['P'], ['P'], ['P'], ['P'], ['P']]);
    // Past the cap, but buried only for a failure while something else gets through: alone, P may be failing for the sink.
    expect(t.dead()).toEqual([]);
    expect(t.rows()).toMatchObject([{ message: '"P"', attempts: 6 }]);

    // Something else is delivered: P's next failure alone is its own, and buries it.
    await t.database.record('acme', ['B']);
    await t.database.alarm();
    now = t.alarmAt()!;
    await t.database.alarm();
    expect(delivered).toEqual(['A', 'B']);
    expect(t.dead().map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: '"P"', attempts: 7 }]);
  });

  it('splits a failed delivery in two for its retry, each half a delivery of its own, until the failing message is alone', async () => {
    const t = outboxDatabase({ name: 'main' });
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 5)) throw new Error('5 bounced');
    });
    await t.database.record('acme', [0, 1, 2, 3, 4, 5, 6, 7]);
    const alarms: unknown[][][] = [];
    for (let alarm = 0; alarm < 5; alarm++) {
      const before = t.handed.length;
      await t.database.alarm();
      alarms.push(t.handed.slice(before).map((envelopes) => envelopes.map((e) => e.message)));
      now = Math.max(now, t.alarmAt() ?? now);
    }
    // An alarm delivers the oldest half; once a delivery went through, what else is due goes in one more —
    // when it holds nothing but the failing half, that second delivery fails and is split again.
    expect(alarms).toEqual([
      [[0, 1, 2, 3, 4, 5, 6, 7]],
      [[0, 1, 2, 3], [4, 5, 6, 7]],
      [[4, 5], [6, 7]],
      [[4], [5]],
      [[5]],
    ]);
    // Every message but 5 delivered within three retries; 5 failed alone from the fourth on.
    expect(t.rows().map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: '5', attempts: 5 }]);

    // Messages recorded while 5 is due again are not taken into its delivery: they go with the other new ones, first —
    // and 5, which failed while others went through, in a delivery of its own after them.
    await t.database.record('acme', [8, 9]);
    await t.database.alarm();
    expect(t.handed.slice(-2).map((envelopes) => envelopes.map((e) => e.message))).toEqual([[8, 9], [5]]);
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

  it('retries the envelopes a { retry } names together, unsplit, and moves the ones answered in { dead } aside at once', async () => {
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
    // The sink said which: 1 and 3 are retried together, in one delivery.
    now += 5_000;
    t.sink(() => {});
    await t.database.alarm();
    expect(t.handed.slice(1).map((envelopes) => envelopes.map((e) => e.message))).toEqual([[1, 3]]);
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

  it('moves a message that failed maxAttempts deliveries of its own to __outbox_dead, logged, and never retries it', async () => {
    const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
    t.sink((envelopes) => {
      if (envelopes.some((e) => e.message === 'doomed')) throw new Error('doomed bounced');
    });
    await t.database.record('acme', ['doomed']);
    // Alone, with nothing else delivered: it may be the sink that fails — the attempt is counted, not as its own.
    await t.database.alarm();
    // Each time it is due again, something else is recorded: delivered first, so its failure is its own.
    for (const fine of ['fine 1', 'fine 2']) {
      now = t.alarmAt()!;
      await t.database.record('acme', [fine]);
      await t.database.alarm();
    }
    expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['doomed'], ['fine 1'], ['doomed'], ['fine 2'], ['doomed']]);
    expect(t.rows()).toEqual([]);
    expect(t.rows('__outbox_dead')).toEqual([
      {
        id: 1,
        instance_key: 'acme',
        message: '"doomed"',
        recorded_at: 1_000_000,
        attempts: 3,
        last_error: 'Error: doomed bounced',
        dead_at: 1_015_000,
      },
    ]);
    const logged = errors.mock.calls.map(([text]) => String(text));
    expect(logged.at(-1)).toContain('1 outbox message(s) of main reached 3 failed deliveries');
    expect(logged.at(-1)).toContain('__outbox_dead');
    // Nothing left to deliver: no alarm, and another alarm hands the sink nothing.
    const scheduled = t.alarmAt();
    await t.database.alarm();
    expect(t.handed).toHaveLength(5);
    expect(t.alarmAt()).toBe(scheduled);
  });

  it('buries no message that fails while nothing else gets through: alone, it is retried on its backoff, one delivery a round', async () => {
    const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
    await t.database.record('acme', ['alone']);
    t.sink(() => {
      throw new Error('sink is down');
    });
    const rounds: number[] = [];
    for (let round = 0; round < 10; round++) {
      const before = t.handed.length;
      await t.database.alarm();
      rounds.push(t.handed.length - before);
      now = t.alarmAt()!;
    }
    expect(rounds).toEqual(Array.from({ length: 10 }, () => 1));
    expect(t.dead()).toEqual([]);
    expect(t.rows()).toMatchObject([{ message: '"alone"', attempts: 10 }]);
    // A lone message failing again says nothing of the sink: a message recorded now is tried at once.
    await t.database.record('acme', ['new']);
    expect(t.alarmAt()).toBe(now);
  });

  describe('what the sink does to its list', () => {
    it('hands the sink a frozen list of its own: a sink that splices it to chunk counts nothing it did not send as delivered', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', Array.from({ length: 100 }, (_, i) => i));
      const sent: unknown[] = [];
      let chunks = 0;
      t.sink((envelopes) => {
        expect(Object.isFrozen(envelopes)).toBe(true);
        const list = envelopes as OutboxEnvelope[];
        while (list.length) {
          const chunk = list.splice(0, 10);
          if (++chunks === 3) throw new Error('down');
          sent.push(...chunk.map((e) => e.message));
        }
      });
      await t.database.alarm();
      // Every message is sent or kept for its retry: none deleted unsent.
      const kept = t.rows().map((row) => JSON.parse(row.message as string));
      expect(Array.from({ length: 100 }, (_, i) => i).filter((m) => !sent.includes(m) && !kept.includes(m))).toEqual([]);
      expect(String(errors.mock.calls[0]![1])).toContain('TypeError');

      // A sink that chunks a copy of it does as it means to: what it sent before failing is sent again (at least once).
      t.sink((envelopes) => {
        const list = [...envelopes];
        while (list.length) sent.push(...list.splice(0, 10).map((e) => e.message));
      });
      now += 5_000;
      await t.database.alarm();
      expect(t.rows()).toEqual([]);
      expect(new Set(sent).size).toBe(100);
    });

    it('settles by the envelope objects, never their places: a sink that sorts keeps the message it did not send', async () => {
      // The sink sends by priority: 'b' (p 1) goes out, 'a' (p 2) cannot go now.
      const bySort = (sent: string[]) => (envelopes: OutboxEnvelope[]) => {
        envelopes.sort((x: any, y: any) => x.message.p - y.message.p);
        sent.push((envelopes[0]!.message as any).m);
        return { retry: [envelopes[1]!] };
      };
      const kept = (t: ReturnType<typeof outboxDatabase>) => t.rows().map((row) => JSON.parse(row.message as string).m);

      // In place: the frozen list refuses, and the delivery is retried whole — 'a' is not lost.
      const inPlace = outboxDatabase({ name: 'main' });
      await inPlace.database.record('acme', [{ p: 2, m: 'a' }, { p: 1, m: 'b' }]);
      const notSent: string[] = [];
      inPlace.sink((envelopes) => bySort(notSent)(envelopes as OutboxEnvelope[]));
      await inPlace.database.alarm();
      expect(notSent).toEqual([]);
      expect(kept(inPlace)).toEqual(['a', 'b']);

      // A sorted copy: 'b' delivered, 'a' kept.
      const copy = outboxDatabase({ name: 'main' });
      await copy.database.record('acme', [{ p: 2, m: 'a' }, { p: 1, m: 'b' }]);
      const sent: string[] = [];
      copy.sink((envelopes) => bySort(sent)([...envelopes]));
      await copy.database.alarm();
      expect(sent).toEqual(['b']);
      expect(kept(copy)).toEqual(['a']);
    });
  });

  describe('maxAttempts counts a failure of its own', () => {
    it('upgrades a 0.13 outbox stuck behind a poison message: its attempts counted from 0, the other 99 delivered, none buried', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sqlite.exec(OUTBOX_0_13);
      // 0.13 retried the 100 oldest together forever, counting each failure on all of them.
      for (let i = 0; i < 100; i++) {
        t.sqlite.exec(`INSERT INTO __outbox (instance_key, message, recorded_at, attempts) VALUES ('acme', '${JSON.stringify(i === 0 ? 'poison' : `m${i}`)}', 5, 120)`);
      }
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'poison')) throw new Error('poison');
        delivered.push(...envelopes.map((e) => e.message));
      });
      for (let alarm = 0; alarm < 50 && delivered.length < 99; alarm++) {
        await t.database.alarm();
        now = Math.max(now, t.alarmAt() ?? now);
      }
      expect(delivered).toHaveLength(99);
      expect(t.dead()).toEqual([]);
      expect(t.rows()).toMatchObject([{ message: '"poison"' }]);
      expect(t.rows()[0]!.attempts).toBeLessThan(10);
    });

    it('never buries a message beside the bad one: with maxAttempts 3, of 10 messages one bad, the other 9 are delivered', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      await t.database.record('acme', Array.from({ length: 10 }, (_, i) => (i === 9 ? 'poison' : `m${i}`)));
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'poison')) throw new Error('poison');
        delivered.push(...envelopes.map((e) => e.message));
      });
      for (let alarm = 0; alarm < 20 && t.rows().length > 0; alarm++) {
        await t.database.alarm();
        now = Math.max(now, t.alarmAt() ?? now);
      }
      expect(delivered).toEqual(Array.from({ length: 9 }, (_, i) => `m${i}`));
      // Past the cap inside a delivery that threw with others in it; buried at its first failure alone.
      expect(t.dead().map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: '"poison"', attempts: 4 }]);
    });

    it('buries at the cap a message the sink names in { retry } while it delivers the others', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 1 });
      await t.database.record('acme', ['a', 'b', 'c']);
      t.sink((envelopes) => ({ retry: envelopes.filter((e) => e.message !== 'c'), error: new Error('429') }));
      await t.database.alarm();
      expect(t.rows()).toEqual([]);
      expect(t.dead().map(({ message, attempts }) => ({ message, attempts }))).toEqual([
        { message: '"a"', attempts: 1 },
        { message: '"b"', attempts: 1 },
      ]);
    });

    it('reads a { retry } of everything it did not give up on as a delivery that failed whole: split, no message buried for it', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 1 });
      await t.database.record('acme', ['a', 'b', 'c']);
      t.sink((envelopes) => ({ retry: [...envelopes], error: new Error('the queue refused the batch') }));
      await t.database.alarm();
      expect(t.dead()).toEqual([]);
      expect(t.rows().map(({ message, attempts, batch }) => ({ message, attempts, batch }))).toEqual([
        { message: '"a"', attempts: 1, batch: 1 },
        { message: '"b"', attempts: 1, batch: 1 },
        { message: '"c"', attempts: 1, batch: 3 },
      ]);
    });
  });

  describe('one alarm, at most three deliveries', () => {
    it('tries what no delivery has failed yet first, the rest in one once it went through, and a suspect batch alone after them', async () => {
      const t = outboxDatabase({ name: 'main' });
      // P failed while others went through (its batch negated: suspect); x and y were retried together; z and w are new.
      await t.database.record('acme', ['P', 'x', 'y', 'z', 'w']);
      t.sqlite.exec(
        `UPDATE __outbox SET batch = CASE id WHEN 1 THEN -1 WHEN 2 THEN 2 WHEN 3 THEN 2 ELSE 0 END, ` +
          `attempts = CASE WHEN id <= 3 THEN 1 ELSE 0 END, failed_at = CASE WHEN id <= 3 THEN 995000 ELSE 0 END`,
      );
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'P')) throw new Error('P bounced');
      });
      await t.database.alarm();
      expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['z', 'w'], ['x', 'y'], ['P']]);
      expect(t.rows()).toMatchObject([{ message: '"P"', attempts: 2, batch: -1 }]);
    });

    it('tries the second batch when the first takes nothing; the first, failing while the second went through, is suspect from then on', async () => {
      const t = outboxDatabase({ name: 'main' });
      // P and a failed together long ago; x and y failed together since; nothing new.
      await t.database.record('acme', ['P', 'a', 'x', 'y']);
      t.sqlite.exec(
        `UPDATE __outbox SET batch = CASE WHEN id <= 2 THEN 1 ELSE 3 END, attempts = 1, failed_at = CASE WHEN id <= 2 THEN 900000 ELSE 990000 END`,
      );
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'P')) throw new Error('P bounced');
        delivered.push(...envelopes.map((e) => e.message));
      });
      await t.database.alarm();
      expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['P', 'a'], ['x', 'y']]);
      expect(t.rows().map(({ message, batch }) => ({ message, batch }))).toEqual([
        { message: '"P"', batch: -1 },
        { message: '"a"', batch: -2 },
      ]);
      // Its halves are never merged into another delivery: each is one of its own.
      now = t.alarmAt()!;
      await t.database.record('acme', ['new']);
      await t.database.alarm();
      expect(t.handed.slice(2).map((envelopes) => envelopes.map((e) => e.message))).toEqual([['new'], ['P'], ['a']]);
      expect(delivered).toEqual(['x', 'y', 'new', 'a']);
    });

    it('a sink that is down costs two failing deliveries a round, however much waits; recovery delivers 100 an alarm', async () => {
      const t = outboxDatabase({ name: 'main' });
      for (let i = 0; i < 2_000; i += 100) await t.database.record('acme', Array.from({ length: 100 }, (_, j) => i + j));
      t.sink(() => {
        throw new Error('sink is down');
      });
      const rounds: Array<{ alarms: number; deliveries: number; written: number }> = [];
      for (let round = 0; round < 12; round++) {
        const [handed, written] = [t.handed.length, t.counted.written];
        let alarms = 0;
        while ((t.alarmAt() ?? Infinity) <= now && alarms < 1_000) {
          await t.database.alarm();
          alarms++;
        }
        rounds.push({ alarms, deliveries: t.handed.length - handed, written: t.counted.written - written });
        now = t.alarmAt()!;
      }
      // Two telling deliveries that take nothing — the 100 oldest, then the next 100 — and the sink is taken for down;
      // from then on one alarm a round, trying two batches of the 100 oldest.
      expect(rounds[0]).toMatchObject({ alarms: 2, deliveries: 2 });
      for (const round of rounds.slice(1)) {
        expect(round).toMatchObject({ alarms: 1, deliveries: 2 });
        // What the round tried (at most 100 messages) and the one row of what the outbox knows of its sink.
        expect(round.written).toBeLessThanOrEqual(101);
      }
      // The messages no delivery took are as they were: no attempt counted, not split, their time not touched.
      const untouched = t.sqlite.prepare('SELECT count(*) AS n FROM __outbox WHERE attempts = 0 AND batch = 0 AND next_attempt_at = 0').get() as {
        n: number;
      };
      expect(untouched.n).toBe(1_800);
      expect(t.dead()).toEqual([]);

      // The sink is back: the backlog goes 100 messages an alarm, in at most three deliveries each.
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        delivered.push(...envelopes.map((e) => e.message));
      });
      const recovery: Array<{ deliveries: number; delivered: number }> = [];
      for (let alarm = 0; alarm < 100 && t.rows().length > 0; alarm++) {
        const [handed, before] = [t.handed.length, delivered.length];
        now = Math.max(now, t.alarmAt() ?? now);
        await t.database.alarm();
        recovery.push({ deliveries: t.handed.length - handed, delivered: delivered.length - before });
      }
      expect(new Set(delivered).size).toBe(2_000);
      expect(recovery.map((alarm) => alarm.delivered)).toEqual(Array.from({ length: 20 }, () => 100));
      for (const alarm of recovery) expect(alarm.deliveries).toBeLessThanOrEqual(3);
    });

    it('a message recorded while the sink is down waits for its next try: no alarm or delivery of its own, no attempt counted', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 100 });
      t.sink(() => {
        throw new Error('sink is down');
      });
      await t.database.record('acme', Array.from({ length: 300 }, (_, n) => `backlog ${n}`));
      // Ten hours down, a message recorded every seven minutes.
      const calls: number[] = [];
      t.sink(() => {
        calls.push(now);
        throw new Error('sink is down');
      });
      const start = now;
      const alarms: number[] = [];
      let recorded = 0;
      const record = (at: number) => [`during ${(recorded++, at)}`];
      for (let hour = 0; hour < 10; hour++) alarms.push(await t.run(3_600_000, { ms: 7 * 60_000, record }));
      // At the five-minute ceiling: twelve rounds an hour, each one alarm and two failing deliveries.
      expect(alarms.at(-1)).toBe(12);
      expect(calls.filter((at) => at >= start + 9 * 3_600_000)).toHaveLength(24);
      // The messages recorded meanwhile were not tried (beyond the 100 oldest read), nor counted, nor buried.
      expect(t.dead()).toEqual([]);
      const during = t.rows().filter((row) => String(row.message).startsWith('"during'));
      expect(during).toHaveLength(recorded);
      expect(recorded).toBe(80);
      for (const row of during) expect(row).toMatchObject({ attempts: 0, next_attempt_at: 0 });
      // Recording one sets the alarm to the sink's next try, not to now.
      const next = t.alarmAt()!;
      expect(next).toBeGreaterThan(now);
      await t.database.record('acme', ['one more']);
      expect(t.alarmAt()).toBe(next);
    });

    it('buries nothing while the sink is down, however many rounds: a throwing sink and a Queue that refuses every sendBatch', async () => {
      for (const kind of ['throws', 'queue'] as const) {
        const t = outboxDatabase({ name: 'main', maxAttempts: 5 });
        let down = true;
        const queue = queueOutboxSink('EVENTS');
        const env = {
          EVENTS: {
            async sendBatch() {
              if (down) throw new Error('Queue send failed: Too Many Requests');
            },
          },
        };
        t.sink((envelopes) => {
          if (kind === 'queue') return queue.deliver(envelopes, { env });
          if (down) throw new Error('webhook is down');
        });
        for (let i = 0; i < 2_000; i += 100) await t.database.record('acme', Array.from({ length: 100 }, (_, j) => i + j));
        // Eight hours: about a hundred rounds, twenty times maxAttempts.
        await t.run(8 * 3_600_000);
        expect({ kind, dead: t.dead().length }).toEqual({ kind, dead: 0 });
        expect(Math.max(...t.rows().map((row) => row.attempts as number))).toBeLessThan(5);
        down = false;
        await t.run(3_600_000);
        expect({ kind, left: t.rows().length }).toEqual({ kind, left: 0 });
      }
    });

    it('a message known to fail on its own costs no delivery of its own while the sink is down', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'poison')) throw new Error('cannot take it');
      });
      // The poison fails beside a message that goes through: suspect, on its own clock.
      await t.database.record('acme', ['poison', 'fine']);
      await t.database.alarm();
      now = t.alarmAt()!;
      await t.database.alarm();
      expect(t.rows()).toMatchObject([{ message: '"poison"', batch: -1 }]);
      // Then the sink goes down, 300 messages waiting.
      t.sink(() => {
        throw new Error('sink is down');
      });
      await t.database.record('acme', Array.from({ length: 300 }, (_, i) => i));
      await t.run(3_600_000);
      const handed = t.handed.length;
      const alarms = await t.run(3_600_000);
      expect({ alarms, deliveries: t.handed.length - handed }).toEqual({ alarms: 12, deliveries: 24 });
      expect(t.dead()).toEqual([]);
    });

    it("at the sink's next try, two messages that take nothing end the alarm: a suspect one due with them is not tried", async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['a', 'b', 'poison']);
      // a and b failed alone while the sink was down; the poison failed while others went through; the sink's next try is due.
      t.sqlite.exec(`UPDATE __outbox SET attempts = 1, failed_at = 990000, batch = CASE id WHEN 3 THEN -3 ELSE id END`);
      t.sqlite.exec(`INSERT INTO __outbox_sink (id, failing, down_until, down_rounds) VALUES (1, 4, 999000, 3)`);
      t.sink(() => {
        throw new Error('sink is down');
      });
      await t.database.alarm();
      expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['a'], ['b']]);
      // Still down, the next try backed off further; nothing counted.
      expect(t.alarmAt()).toBe(now + 40_000);
      expect(t.rows().map(({ attempts }) => attempts)).toEqual([1, 1, 1]);
    });

    it('two messages that fail on their own are no outage: a message due with them is delivered in that alarm', async () => {
      const t = outboxDatabase({ name: 'main' });
      // A sink that refuses them without any I/O (a validation): in a Worker the clock stands still, so their retries keep step.
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('poison'))) throw new Error('cannot take it');
      });
      await t.database.record('acme', ['poison 1', 'poison 2']);
      for (let alarm = 0; alarm < 10; alarm++) {
        await t.database.alarm();
        now = t.alarmAt()!;
      }
      expect(t.rows().map(({ message, next_attempt_at }) => ({ message, next_attempt_at }))).toEqual([
        { message: '"poison 1"', next_attempt_at: now },
        { message: '"poison 2"', next_attempt_at: now },
      ]);
      // Recorded just before their alarm runs: delivered by it.
      await t.database.record('acme', ['healthy']);
      const before = t.handed.length;
      await t.database.alarm();
      expect(t.handed.slice(before).map((envelopes) => envelopes.map((e) => e.message))).toEqual([['healthy'], ['poison 1', 'poison 2']]);
      expect(t.rows().map((row) => row.message)).toEqual(['"poison 1"', '"poison 2"']);

      // Recorded while their delivery is in flight: delivered by the next alarm, at once.
      now = t.alarmAt()!;
      t.sink(async (envelopes) => {
        if (envelopes.some((e) => e.message === 'poison 1')) await t.database.record('acme', ['in flight']);
        if (envelopes.some((e) => String(e.message).startsWith('poison'))) throw new Error('cannot take it');
      });
      await t.database.alarm();
      expect(t.alarmAt()).toBe(now);
      await t.database.alarm();
      expect(t.handed.at(-1)!.map((e) => e.message)).toEqual(['in flight']);
      expect(t.rows().map((row) => row.message)).toEqual(['"poison 1"', '"poison 2"']);
    });

    it('of four messages pushed together, two of them bad, the two good ones are delivered within a minute', async () => {
      const t = outboxDatabase({ name: 'main' });
      const deliveredAt = new Map<unknown, number>();
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('p'))) throw new Error('cannot take it');
        for (const e of envelopes) deliveredAt.set(e.message, now);
      });
      await t.database.record('acme', ['p1', 'x', 'p2', 'y']);
      await t.run(60_000);
      expect([...deliveredAt.keys()].sort()).toEqual(['x', 'y']);
      expect(Math.max(...deliveredAt.values()) - 1_000_000).toBeLessThan(60_000);
    });

    it('reads the table at most twice an alarm, once when the sink is down, and not at all before its next try', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', Array.from({ length: 100 }, (_, i) => i));
      // 5 000 more wait for their retry.
      const wait = t.sqlite.prepare(`INSERT INTO __outbox (instance_key, message, recorded_at, attempts, next_attempt_at, batch) VALUES ('acme', '"w"', 1, 1, ?, 9)`);
      for (let i = 0; i < 5_000; i++) wait.run(now + 60_000);
      let reads = t.counted.outboxReads;
      // A full read the sink took: the messages due, then the earliest waiting.
      await t.database.alarm();
      expect(t.counted.outboxReads - reads).toBe(2);
      expect(t.alarmAt()).toBe(now + 60_000);

      // Down: the messages due, nothing after.
      now += 60_000;
      t.sink(() => {
        throw new Error('sink is down');
      });
      reads = t.counted.outboxReads;
      await t.database.alarm();
      await t.database.alarm();
      expect(t.counted.outboxReads - reads).toBe(3);
      const next = t.alarmAt()!;
      expect(next).toBeGreaterThan(now);
      // An alarm before its next try (one a message recorded earlier set) reads one row of what the outbox knows of its sink.
      reads = t.counted.outboxReads;
      const handed = t.handed.length;
      await t.database.alarm();
      expect(t.counted.outboxReads - reads).toBe(0);
      expect(t.handed).toHaveLength(handed);
      expect(t.alarmAt()).toBe(next);
    });
  });

  describe('destroyDatabase() while a delivery is in flight', () => {
    it("settles nothing on the storage that replaced the one it read: a message pushed after the wipe is not taken for the old one's", async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['old']);
      let release!: () => void;
      t.sink(async (envelopes) => {
        if (envelopes.some((e) => e.message === 'old')) await new Promise<void>((resolve) => (release = resolve));
      });
      const alarm = t.database.alarm();
      await new Promise((resolve) => setTimeout(resolve, 0));
      destroy(t);
      // AUTOINCREMENT starts again at 1: the new message has the id 'old' had.
      await t.database.record('acme', ['new']);
      release();
      await alarm;
      expect(t.rows()).toMatchObject([{ id: 1, message: '"new"', attempts: 0 }]);
      expect(errors).not.toHaveBeenCalled();
      // A later alarm delivers it.
      await t.database.alarm();
      expect(t.handed.map((envelopes) => envelopes.map((e) => e.message))).toEqual([['old'], ['new']]);
      expect(t.rows()).toEqual([]);
    });

    it('nor fails on the storage the wipe left without an outbox', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['old']);
      let fail!: (error: Error) => void;
      t.sink(() => new Promise<void>((_, reject) => (fail = reject)));
      const alarm = t.database.alarm();
      await new Promise((resolve) => setTimeout(resolve, 0));
      destroy(t);
      fail(new Error('sink is down'));
      await expect(alarm).resolves.toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
    });
  });
});
