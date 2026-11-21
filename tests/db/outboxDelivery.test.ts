import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSqlite } from '../../src/testing';
import { queueOutboxSink, type OutboxDelivery, type OutboxEnvelope, type OutboxSink } from '../../src/db/outbox';

// The outbox's delivery (SqliteDurableObject's alarm) over a real in-memory
// SQLite and a controlled clock: what the sink is handed, what is kept,
// retried and moved aside, and what it costs. Grouped by what the delivery
// promises — one call; I1 nothing lost; I2 buried only by the rule; I3 cost;
// I4 liveness — then each of its documented limits, the upgrade from 0.13
// and the rollback to it.

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

/** What one alarm did: when it ran, its sink calls (the size of each) and the rows it wrote. */
type AlarmStats = { at: number; calls: number[]; written: number };

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
  const stats: AlarmStats[] = [];
  /** Runs the alarm once, as the runtime would, and keeps what it did. */
  const alarm = async (): Promise<AlarmStats> => {
    const [calls, written] = [handed.length, counted.written];
    clearAlarm();
    await database.alarm();
    const done = { at: now, calls: handed.slice(calls).map((envelopes) => envelopes.length), written: counted.written - written };
    stats.push(done);
    return done;
  };
  return {
    database,
    sqlite,
    rows,
    alarmAt,
    counted,
    handed,
    stats,
    alarm,
    /** What `handed` holds, as the messages of each call. */
    calls: (from = 0) => handed.slice(from).map((envelopes) => envelopes.map((e) => e.message)),
    /**
     * Runs every alarm due until `ms` from now, recording messages each
     * `every.ms` when given and calling `after` after each alarm; answers the
     * alarms that ran. The clock moves to each alarm's time.
     */
    async run(ms: number, every?: { ms: number; record: (at: number) => unknown[] } | null, after?: () => void): Promise<AlarmStats[]> {
      const end = now + ms;
      let push = every ? now + every.ms : Infinity;
      const ran: AlarmStats[] = [];
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
        ran.push(await alarm());
        after?.();
      }
      now = end;
      return ran;
    },
    /** `__outbox_dead`'s rows, none while nothing was moved there. */
    dead: () =>
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__outbox_dead'`).all().length > 0
        ? rows('__outbox_dead')
        : [],
    /** What the outbox knows of its sink. */
    sinkState: () =>
      (sqlite.prepare('SELECT down_until, down_rounds FROM __outbox_sink WHERE id = 1').get() as Record<string, number> | undefined) ?? {
        down_until: 0,
        down_rounds: 0,
      },
    sink(next: Deliver) {
      deliver = next;
    },
  };
}

type TestDatabase = ReturnType<typeof outboxDatabase>;

/** A sink that delivers everything but the calls that hold a message `bad()` says it cannot take: those throw. */
function failingOn(bad: (message: unknown) => boolean, delivered: unknown[] = []): Deliver {
  return (envelopes) => {
    if (envelopes.some((e) => bad(e.message))) throw new Error('400 bad payload');
    delivered.push(...envelopes.map((e) => e.message));
  };
}

/** A sink that delivers the first `n` envelopes it is handed in all, then none: what it did not send it answers in { retry }. */
function quota(n: number, delivered: unknown[] = []): Deliver {
  return (envelopes) => {
    const sent = envelopes.slice(0, Math.max(0, n));
    n -= sent.length;
    delivered.push(...sent.map((e) => e.message));
    if (sent.length < envelopes.length) return { retry: envelopes.slice(sent.length), error: new Error('429 quota spent') };
  };
}

const down = (): never => {
  throw new Error('sink is down');
};

/** An outbox as durable-db 0.13 left it: none of the columns added since. */
const OUTBOX_0_13 = `CREATE TABLE __outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
)`;

/** What sys('destroyDatabase') does: deleteAll() — every table, the AUTOINCREMENT counters with them — then resetMigrationState(). */
function destroy(t: TestDatabase): void {
  const tables = t.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  for (const { name } of tables) t.sqlite.exec(`DROP TABLE ${name}`);
  t.sqlite.exec('DELETE FROM sqlite_sequence');
  (t.database as unknown as { resetMigrationState(): void }).resetMigrationState();
}

const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

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

  describe('one call', () => {
    describe('envelopes', () => {
      it('name their database, instance and tenant, when it was recorded and its counted attempts', async () => {
        const t = outboxDatabase({ name: 'billing' });
        await t.database.record('acme', [{ job: 'invoice-sent' }]);
        await t.database.alarm();
        expect(t.handed).toEqual([
          [{ message: { job: 'invoice-sent' }, database: 'billing', instanceKey: 'acme', tenantId: 'acme', recordedAt: 1_000_000, attempts: 0 }],
        ]);
        expect(t.rows()).toEqual([]);
      });

      it('name a hand-written database by its class name when it sets no databaseName', async () => {
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

      it("answer a per-tenant database's tenant named 'global' as that tenant, a global database's key as none", async () => {
        const perTenant = outboxDatabase({ name: 'main', instance: 'per-tenant' });
        await perTenant.database.record('global', ['for the tenant called global']);
        await perTenant.database.alarm();
        expect(perTenant.handed[0]![0]).toMatchObject({ instanceKey: 'global', tenantId: 'global' });

        const global = outboxDatabase({ name: 'catalog', instance: 'global' });
        await global.database.record('global', ['for everyone']);
        await global.database.alarm();
        expect(global.handed[0]![0]).toMatchObject({ database: 'catalog', instanceKey: 'global', tenantId: null });
      });

      it('keep a tenant id containing "__dev_" whole in production, and strip exactly the epoch a dev build applied', async () => {
        const production = outboxDatabase({ name: 'main' });
        await production.database.record('team__dev_ops', ['x']);
        await production.database.alarm();
        expect(production.handed[0]![0]!.tenantId).toBe('team__dev_ops');

        const dev = outboxDatabase({ name: 'main', devEpochSuffix: '__dev_mw20' });
        await dev.database.record('team__dev_ops__dev_mw20', ['x']);
        await dev.database.alarm();
        expect(dev.handed[0]![0]).toMatchObject({ instanceKey: 'team__dev_ops__dev_mw20', tenantId: 'team__dev_ops' });
      });

      it('read the tenant of a key an earlier dev epoch made (an object `db reset` left behind) without that epoch', async () => {
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
    });

    it('hands the sink the oldest due, by id, at most 100 a call, and comes back at once for the rest', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(150));
      await t.alarm();
      expect(t.calls()).toEqual([range(100)]);
      expect(t.alarmAt()).toBe(now);
      await t.alarm();
      expect(t.calls(1)).toEqual([range(50, 100)]);
      expect(t.rows()).toEqual([]);
      expect(t.alarmAt()).toBeNull();
    });

    it('settles by the envelope objects: one not named is delivered and deleted, one in { dead } moved aside at once with its counted, one in { retry } not delivered', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', [1, 2, 3, 4, 5]);
      t.sqlite.exec(`UPDATE __outbox SET counted = 4 WHERE message = '5'`);
      const refused = new Error('the webhook answered 410 for 5, 503 for the odd ones');
      t.sink((envelopes) => ({
        retry: envelopes.filter((e) => e.message === 1 || e.message === 3),
        dead: envelopes.filter((e) => e.message === 5),
        error: refused,
      }));
      await t.alarm();
      // 2 and 4 delivered, 5 moved aside; 1 and 3 halved and tried again in the same alarm, each the one of its call not delivered.
      expect(t.calls()).toEqual([[1, 2, 3, 4, 5], [1], [3]]);
      expect(t.dead()).toEqual([
        { id: 5, instance_key: 'acme', message: '5', recorded_at: 1_000_000, attempts: 4, last_error: String(refused), dead_at: 1_000_000 },
      ]);
      // The sink delivered others earlier in this alarm: their failures alone count.
      expect(t.rows().map(({ message, tries, counted, last_error, next_attempt_at }) => ({ message, tries, counted, last_error, next_attempt_at }))).toEqual([
        { message: '1', tries: 1, counted: 1, last_error: String(refused), next_attempt_at: now + 5_000 },
        { message: '3', tries: 1, counted: 1, last_error: String(refused), next_attempt_at: now + 5_000 },
      ]);
      const logged = errors.mock.calls.map(([text]) => String(text));
      expect(logged).toContain(
        '[db] 1 outbox message(s) of main the sink answered in { dead } were moved to the table __outbox_dead of its Durable Object: they are not retried — deliver them from there, then delete them. The error:',
      );
      expect(logged).toContain(
        '[db] 2 outbox message(s) of main failed alone and wait for their retry (5 s, doubling, at most 5 minutes). The last error:',
      );
      // Their retry, in one call: the envelopes say how many failures counted.
      now += 5_000;
      t.sink(() => {});
      await t.alarm();
      expect(t.handed.at(-1)!.map(({ message, attempts }) => ({ message, attempts }))).toEqual([
        { message: 1, attempts: 1 },
        { message: 3, attempts: 1 },
      ]);
      expect(t.rows()).toEqual([]);
    });

    it('takes a throw and a { retry } of every envelope for the same: not delivered', async () => {
      const outcomes: unknown[] = [];
      for (const deliver of [down, (envelopes: readonly OutboxEnvelope[]) => ({ retry: envelopes, error: new Error('sink is down') })]) {
        const t = outboxDatabase({ name: 'main' });
        await t.database.record('acme', ['a', 'b', 'c']);
        t.sink(deliver);
        const alarm = await t.alarm();
        outcomes.push({ calls: alarm.calls, written: alarm.written, rows: t.rows(), sink: t.sinkState(), alarmAt: t.alarmAt() });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[0]).toMatchObject({ calls: [3, 2, 1] });
    });

    it('counts only a delivery as one: a { dead } is not, so the message of the same call it did not deliver fails alone uncounted', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['gone', 'refused']);
      t.sink((envelopes) => ({ dead: envelopes.filter((e) => e.message === 'gone'), retry: envelopes.filter((e) => e.message === 'refused') }));
      await t.alarm();
      expect(t.dead()).toMatchObject([{ message: '"gone"', attempts: 0 }]);
      expect(t.rows()).toMatchObject([{ message: '"refused"', tries: 1, counted: 0 }]);
      expect(t.sinkState()).toEqual({ down_until: now + 5_000, down_rounds: 1 });
    });
  });

  describe('I1 — nothing lost', () => {
    for (const kind of ['throws', 'answers malformed', 'mutates its list'] as const) {
      it(`keeps every message a sink that ${kind} did not take, and delivers them all once it works`, async () => {
        const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
        const sent = new Set<unknown>();
        const recorded = new Set<unknown>();
        let n = 0;
        const record = () => {
          const messages = range(3, n);
          n += 3;
          for (const m of messages) recorded.add(m);
          return messages;
        };
        await t.database.record('acme', range(250, 1_000).map((m) => (recorded.add(m), m)));
        let broken = true;
        t.sink((envelopes) => {
          if (!broken) {
            for (const e of envelopes) sent.add(e.message);
            return;
          }
          if (kind === 'throws') throw new Error('500');
          // Copies of the envelopes: not the objects the call was handed.
          if (kind === 'answers malformed') return { retry: envelopes.map((e) => ({ ...e })) };
          // Sends the first, then takes it off the list it was handed: a frozen list refuses.
          sent.add(envelopes[0]!.message);
          (envelopes as OutboxEnvelope[]).shift();
        });
        // Every message is delivered (the sink sent it), moved aside, or still waiting — after every alarm.
        const nothingLost = () => {
          const waiting = new Set([...t.rows(), ...t.dead()].map((row) => JSON.parse(row.message as string)));
          expect([...recorded].filter((m) => !sent.has(m) && !waiting.has(m))).toEqual([]);
        };
        await t.run(30 * 60_000, { ms: 60_000, record }, nothingLost);
        expect(t.dead()).toEqual([]);
        broken = false;
        await t.run(30 * 60_000, null, nothingLost);
        expect(t.rows()).toEqual([]);
        expect(t.dead()).toEqual([]);
        expect([...recorded].filter((m) => !sent.has(m))).toEqual([]);
      });
    }

    it('hands the sink a frozen list of its own; a sink that copies it chunks and sorts as it likes', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', [{ p: 2, m: 'a' }, { p: 1, m: 'b' }]);
      const sent: string[] = [];
      t.sink((envelopes) => {
        expect(Object.isFrozen(envelopes)).toBe(true);
        // By priority: 'b' goes out, 'a' cannot go now.
        const sorted = [...envelopes].sort((x: any, y: any) => x.message.p - y.message.p);
        sent.push((sorted[0]!.message as any).m);
        return { retry: [sorted[1]!] };
      });
      await t.alarm();
      expect(sent).toEqual(['b']);
      // 'a' failed alone, in a call that delivered 'b': counted.
      expect(t.rows().map((row) => ({ m: JSON.parse(row.message as string).m, tries: row.tries, counted: row.counted }))).toEqual([
        { m: 'a', tries: 1, counted: 1 },
      ]);
    });

    it('keeps a message whose sink throws a value String() cannot convert: its error is kept as text and its alarm set', async () => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const unprintable: Array<[unknown, string]> = [
        [Object.create(null), '[object Object]'],
        [
          {
            toString() {
              throw new Error('no text');
            },
          },
          '[object Object]',
        ],
        [revoked.proxy, '[an error that cannot be shown as text]'],
      ];
      for (const [error, text] of unprintable) {
        const t = outboxDatabase({ name: 'main' });
        await t.database.record('acme', ['a']);
        t.sink(() => {
          throw error;
        });
        await expect(t.alarm()).resolves.toBeDefined();
        // Failed alone with nothing delivered: kept, the sink taken for down, the alarm set for its next try.
        expect(t.rows()).toMatchObject([{ message: '"a"', tries: 1, last_error: text }]);
        expect(t.alarmAt()).toBe(now + 5_000);
      }
    });

    it('moves a { dead } answered with an error String() cannot convert aside, and settles the rest of the call', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['good', 'bad', 'later']);
      t.sink((envelopes) => ({ dead: envelopes.filter((e) => e.message === 'bad'), error: Object.create(null) }));
      await t.alarm();
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toMatchObject([{ message: '"bad"', last_error: '[object Object]' }]);
    });

    it('never counts as delivered an envelope its answer names, however the answer reads a second time', async () => {
      const answers: Array<[string, (envelopes: readonly OutboxEnvelope[]) => OutboxDelivery]> = [
        [
          'a { retry } list with an iterator of its own',
          (envelopes) => {
            const retry = [...envelopes];
            (retry as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {};
            return { retry };
          },
        ],
        [
          'a { retry } element that answers the envelope once, then a copy',
          (envelopes) => {
            const retry: OutboxEnvelope[] = [];
            let reads = 0;
            Object.defineProperty(retry, 0, { get: () => (reads++ === 0 ? envelopes[0] : { ...envelopes[0]! }), enumerable: true });
            return { retry };
          },
        ],
        [
          'an answer that says it has no retry, then gives one',
          (envelopes) => new Proxy({ retry: [...envelopes] }, { has: () => false }) as OutboxDelivery,
        ],
        ['a callable answer with a { retry }', (envelopes) => Object.assign(() => {}, { retry: [...envelopes], error: new Error('503') })],
        [
          'a callable Proxy answering a { retry }',
          (envelopes) => new Proxy(function answer() {}, { get: (target, key) => (key === 'retry' ? [...envelopes] : Reflect.get(target, key)) }) as OutboxDelivery,
        ],
      ];
      for (const [answer, deliver] of answers) {
        const t = outboxDatabase({ name: 'main' });
        await t.database.record('acme', ['not delivered']);
        t.sink(deliver);
        await t.alarm();
        expect({ answer, waiting: t.rows().map((row) => row.message), dead: t.dead() }).toEqual({ answer, waiting: ['"not delivered"'], dead: [] });
      }
      // A callable answer's { dead } gives the message up, as an object's would: moved aside, not delivered.
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['never']);
      t.sink((envelopes) => Object.assign(() => {}, { dead: [...envelopes] }));
      await t.alarm();
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toMatchObject([{ message: '"never"', attempts: 0 }]);
    });

    it('records into a new outbox after destroyDatabase wiped the storage', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['before']);
      destroy(t);
      await t.database.record('acme', ['after']);
      expect(t.rows().map((row) => row.message)).toEqual(['"after"']);
    });

    describe('destroyDatabase() while a call is in flight', () => {
      it('writes nothing by an old id on the new storage when the wipe comes right after the call settled', async () => {
        const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
        await t.database.record('acme', ['old-bad', 'old-good']);
        t.sink((envelopes) => ({ retry: envelopes.filter((e) => e.message === 'old-bad') }));
        // 'old-good' delivered, 'old-bad' failed alone after it: one counted failure, its next one buries it.
        await t.alarm();
        now = t.alarmAt()!;
        await t.database.record('acme', ['old-good 2']);
        const db = t.database as unknown as { runWithOutbox(ctx: unknown, run: () => Promise<void>): Promise<void> };
        let action: Promise<void> | null = null;
        t.sink(async (envelopes) => {
          // The sink's last turn schedules a wipe and an action on the new storage, which gets id 1 again.
          void Promise.resolve().then(() => {
            void Promise.resolve().then(() => destroy(t));
            const ctx: { instanceKey: string; outbox?: { push(message: unknown): void } } = { instanceKey: 'acme' };
            action = db.runWithOutbox(ctx, async () => {
              ctx.outbox!.push('new' as never);
            });
          });
          return { retry: envelopes.filter((e) => e.message === 'old-bad') };
        });
        await expect(t.alarm()).resolves.toBeDefined();
        await action;
        // The new storage holds the one message recorded on it, untouched.
        expect(t.rows()).toMatchObject([{ id: 1, message: '"new"', tries: 0, next_attempt_at: 0, last_error: null }]);
        expect(t.dead()).toEqual([]);
      });


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
        expect(t.rows()).toMatchObject([{ id: 1, message: '"new"', counted: 0, tries: 0 }]);
        expect(errors).not.toHaveBeenCalled();
        // A later alarm delivers it.
        await t.database.alarm();
        expect(t.calls()).toEqual([['old'], ['new']]);
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

  describe('I2 — buried only by the rule', () => {
    it('counts the one message of a call not delivered only when the sink delivered another in that alarm, in that call or earlier', async () => {
      // 'ok' first: delivered, then 'bad' fails alone — counted.
      const after = outboxDatabase({ name: 'main' });
      after.sink(failingOn((m) => m === 'bad'));
      await after.database.record('acme', ['ok', 'bad']);
      await after.alarm();
      expect(after.calls()).toEqual([['ok', 'bad'], ['ok'], ['bad']]);
      expect(after.rows()).toMatchObject([{ message: '"bad"', tries: 1, counted: 1, next_attempt_at: now + 5_000 }]);
      expect(after.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });

      // In the same call: the sink refuses 'bad' and takes 'ok'. 'bad' is the one of its call not delivered, and the
      // sink delivered another in that call — counted, though it was never in a call of it alone and nothing was
      // delivered before its call. Not counting it would take the sink for down after a call that delivered the rest.
      const same = outboxDatabase({ name: 'main', maxAttempts: 2 });
      same.sink((envelopes) => ({ retry: envelopes.filter((e) => e.message === 'bad'), error: new Error('400') }));
      await same.database.record('acme', ['bad', 'ok']);
      await same.alarm();
      expect(same.calls()).toEqual([['bad', 'ok']]);
      expect(same.rows()).toMatchObject([{ message: '"bad"', tries: 1, counted: 1 }]);
      expect(same.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });
      // Again beside a message the sink takes: counted again, and at maxAttempts buried.
      now = same.alarmAt()!;
      await same.database.record('acme', ['ok 2']);
      await same.alarm();
      expect(same.calls(1)).toEqual([['bad', 'ok 2']]);
      expect(same.dead()).toMatchObject([{ message: '"bad"', attempts: 2, last_error: 'Error: 400' }]);

      // 'bad' first: it fails alone before anything was delivered — not counted, and the sink is taken for down.
      const before = outboxDatabase({ name: 'main' });
      before.sink(failingOn((m) => m === 'bad'));
      await before.database.record('acme', ['bad', 'ok']);
      await before.alarm();
      expect(before.calls()).toEqual([['bad', 'ok'], ['bad']]);
      expect(before.rows()).toMatchObject([
        { message: '"bad"', tries: 1, counted: 0 },
        { message: '"ok"', tries: 0, counted: 0 },
      ]);
      expect(before.sinkState()).toEqual({ down_until: now + 5_000, down_rounds: 1 });
    });

    it('of 100 messages, one bad: the other 99 are delivered in that alarm, and the bad one is counted alone — unless it is the oldest of the read', async () => {
      const t = outboxDatabase({ name: 'main' });
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => m === 63, delivered));
      await t.database.record('acme', range(100));
      const alarm = await t.alarm();
      expect(delivered.sort((a, b) => (a as number) - (b as number))).toEqual(range(100).filter((m) => m !== 63));
      // Halved until it is alone, each half tried next: 15 calls.
      expect(alarm.calls).toHaveLength(15);
      expect(t.rows()).toMatchObject([{ message: '63', tries: 1, counted: 1, next_attempt_at: now + 5_000 }]);
      expect(t.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });
      expect(t.alarmAt()).toBe(now + 5_000);

      // Anywhere but first, the same: halving delivers a message before it is alone.
      for (const at of [1, 99]) {
        const other = outboxDatabase({ name: 'main' });
        const sent: unknown[] = [];
        other.sink(failingOn((m) => m === at, sent));
        await other.database.record('acme', range(100));
        await other.alarm();
        expect({ at, sent: sent.length, sink: other.sinkState() }).toEqual({ at, sent: 99, sink: { down_until: 0, down_rounds: 0 } });
      }

      // The oldest of the read, with a sink that fails every call holding it: halving reaches it first, alone, before
      // anything was delivered — it takes the sink for down, and the 99 go at the next try, 5 s later (limit 2).
      const first = outboxDatabase({ name: 'main' });
      const sentAt = new Map<unknown, number>();
      first.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 0)) throw new Error('400 bad payload');
        for (const e of envelopes) sentAt.set(e.message, now);
      });
      await first.database.record('acme', range(100));
      const head = await first.alarm();
      expect(head.calls).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      expect(sentAt.size).toBe(0);
      expect(first.sinkState()).toEqual({ down_until: now + 5_000, down_rounds: 1 });
      await first.run(5_000);
      expect(sentAt.size).toBe(99);
      expect(new Set(sentAt.values())).toEqual(new Set([1_000_000 + 5_000]));
    });

    it('buries a message when its counted reaches maxAttempts, each counted failure in an alarm that delivered another', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      // The sink takes everything but 'bad', which it answers in { retry }.
      t.sink((envelopes) => ({ retry: envelopes.filter((e) => e.message === 'bad'), error: new Error('400 bad payload') }));
      await t.database.record('acme', ['bad']);
      await t.alarm();
      expect(t.rows()).toMatchObject([{ tries: 1, counted: 0 }]);
      // Recorded while the sink is taken for down: handed first at its next try and delivered; then 'bad', due, counts.
      await t.database.record('acme', ['ok 1']);
      now = t.alarmAt()!;
      await t.alarm();
      expect(t.calls(1)).toEqual([['ok 1'], ['bad']]);
      expect(t.rows()).toMatchObject([{ tries: 2, counted: 1 }]);
      // Due again beside a message the sink takes, in one call: counted again; at 3 it is buried.
      for (const ok of ['ok 2', 'ok 3']) {
        now = t.alarmAt()!;
        await t.database.record('acme', [ok]);
        await t.alarm();
      }
      expect(t.calls(3)).toEqual([
        ['bad', 'ok 2'],
        ['bad', 'ok 3'],
      ]);
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toMatchObject([{ message: '"bad"', attempts: 3, last_error: 'Error: 400 bad payload' }]);
      expect(errors.mock.calls.map(([text]) => String(text)).at(-1)).toContain('1 outbox message(s) of main reached 3 counted failures');
      expect(t.alarmAt()).toBeNull();
    });

    it('an alarm in which the sink delivers nothing counts nothing: 300 waiting, 10 h of outage, a message every 7 minutes', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
      await t.database.record('acme', range(300));
      t.sink(down);
      let pushed = 0;
      await t.run(10 * 3_600_000, { ms: 7 * 60_000, record: () => [`during ${pushed++}`] });
      expect(t.dead()).toEqual([]);
      expect(t.rows()).toHaveLength(300 + pushed);
      expect(t.rows().every((row) => row.counted === 0)).toBe(true);
      expect(t.handed.flat().every((e) => e.attempts === 0)).toBe(true);
    });

    it('an outage counts at most one failure a message, in the alarm it began in after a delivery, and buries only one that had maxAttempts − 1', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      await t.database.record('acme', range(300));
      // Every other message had two counted failures already.
      t.sqlite.exec('UPDATE __outbox SET counted = 2 WHERE id % 2 = 0');
      const had = new Map(t.rows().map((row) => [row.id as number, row.counted as number]));
      // The sink takes 40 messages, then nothing: the outage begins part-way through the first call.
      const delivered: unknown[] = [];
      t.sink(quota(40, delivered));
      await t.alarm();
      expect(delivered).toEqual(range(40));
      // Six failed alone in that alarm, after the sink delivered: each counted once, the three with two before buried at three.
      const buried = t.dead();
      expect(buried).toHaveLength(3);
      for (const row of buried) expect({ attempts: row.attempts, had: had.get(row.id as number) }).toEqual({ attempts: 3, had: 2 });
      const counted = new Map(t.rows().map((row) => [row.id as number, row.counted as number]));
      expect([...counted].filter(([id, c]) => c === had.get(id)! + 1)).toHaveLength(3);
      // Ten more hours of it, a message every 7 minutes: nothing counts again, nothing more is buried.
      await t.run(10 * 3_600_000, { ms: 7 * 60_000, record: (at) => [`during ${at}`] });
      expect(t.dead()).toEqual(buried);
      for (const row of t.rows()) expect(row.counted).toBe(counted.get(row.id as number) ?? 0);
    });

    it('a Queue outage that a too-large message is recorded in every 10 minutes counts nothing: a { dead } delivers nothing', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
      const sink = queueOutboxSink('JOBS');
      const env = { JOBS: { sendBatch: async () => Promise.reject(new Error('503 queue unavailable')) } };
      t.sink((envelopes) => sink.deliver(envelopes, { env }));
      await t.database.record('acme', range(300));
      const big = 'x'.repeat(130_000);
      let pushed = 0;
      await t.run(10 * 3_600_000, { ms: 10 * 60_000, record: () => [{ big, n: pushed++ }] });
      // Only what the sink answered in { dead } was moved aside — each at the try after it was recorded, as the newest.
      expect(t.dead()).toHaveLength(pushed - 1);
      expect(t.dead().every((row) => String(row.message).includes(big))).toBe(true);
      expect(t.rows()).toHaveLength(300 + 1);
      expect(t.handed.flat().every((e) => e.attempts === 0)).toBe(true);
    });
  });

  describe('I3 — cost', () => {
    it('makes at most 16 sink calls an alarm; what it did not reach stays due and the alarm comes back at once', async () => {
      const t = outboxDatabase({ name: 'main' });
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => (m as number) % 10 === 9, delivered));
      await t.database.record('acme', range(100));
      const first = await t.alarm();
      expect(first.calls).toHaveLength(16);
      expect(t.alarmAt()).toBe(now);
      await t.run(10 * 60_000);
      expect(Math.max(...t.stats.map((alarm) => alarm.calls.length))).toBe(16);
      expect(delivered.sort((a, b) => (a as number) - (b as number))).toEqual(range(100).filter((m) => m % 10 !== 9));
      expect(t.dead()).toEqual([]);
    });

    it('an outage that begins part-way through an alarm costs the rest of it (16 calls in all) and the next alarm 8; then a try costs two', async () => {
      const t = outboxDatabase({ name: 'main' });
      // A Queue that takes one sendBatch, then is down. Messages of 3 KB: 82 to a sendBatch.
      const sink = queueOutboxSink('JOBS');
      let sent = 0;
      const env = {
        JOBS: {
          sendBatch: async () => {
            if (sent++ > 0) throw new Error('503 queue unavailable');
          },
        },
      };
      t.sink((envelopes) => sink.deliver(envelopes, { env }));
      await t.database.record('acme', range(300).map((n) => ({ n, pad: 'x'.repeat(3_000) })));
      const alarms = await t.run(3_600_000);
      expect(alarms[0]!.calls).toEqual([100, 9, 5, 3, 2, 1, 1, 1, 2, 1, 1, 4, 2, 1, 1, 2]);
      expect(alarms[1]).toMatchObject({ at: alarms[0]!.at, calls: [100, 50, 25, 13, 7, 4, 2, 1] });
      for (const alarm of alarms.slice(2)) expect(alarm.calls).toEqual([1, 1]);
      expect(t.rows()).toHaveLength(300 - 82);
      expect(t.sinkState().down_until).toBeGreaterThan(now - 300_000);
    });

    it('while down a try makes at most two calls and writes two __outbox rows and the sink row; what is recorded meanwhile adds no alarm', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(300));
      t.sink(down);
      let pushed = 0;
      const alarms = await t.run(10 * 3_600_000, { ms: 7 * 60_000, record: () => [`during ${pushed++}`] });
      // The alarm that notices it: the message that failed alone and the sink's row.
      expect(alarms[0]).toMatchObject({ calls: [100, 50, 25, 13, 7, 4, 2, 1], written: 2 });
      // Every other alarm is a try: the newest alone, then the one tried or recorded longest ago alone; each gets
      // its tried_at and last error, and the sink's row its next try.
      for (const alarm of alarms.slice(1)) expect(alarm).toMatchObject({ calls: [1, 1], written: 3 });
      // The tries back off 5 s, 10 s, … and stay at five minutes: 12 an hour, whatever was recorded (85 messages).
      const gaps = alarms.slice(1).map((alarm, i) => alarm.at - alarms[i]!.at);
      expect(gaps.slice(0, 8)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
      expect(alarms.filter((alarm) => alarm.at >= 1_000_000 + 9 * 3_600_000)).toHaveLength(12);
      expect(alarms).toHaveLength(125);
      expect(pushed).toBe(85);
      // A message recorded while down leaves the alarm at the sink's next try.
      const next = t.alarmAt()!;
      expect(next).toBeGreaterThan(now);
      await t.database.record('acme', ['one more']);
      expect(t.alarmAt()).toBe(next);
    });

    it('reads __outbox twice in an alarm that delivers, not at all in an alarm while down, and twice at a try that finds it down', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(100));
      let reads = t.counted.outboxReads;
      // The messages due, then the earliest waiting.
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(2);

      t.sink(down);
      await t.database.record('acme', ['x', 'y']);
      await t.alarm();
      expect(t.sinkState().down_until).toBeGreaterThan(now);
      // Before the sink's next try: the sink's row, nothing of __outbox, no call.
      reads = t.counted.outboxReads;
      const calls = t.handed.length;
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(0);
      expect(t.handed).toHaveLength(calls);
      // Its next try: one message read for each of its two calls.
      now = t.sinkState().down_until;
      reads = t.counted.outboxReads;
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(2);
      expect(t.calls(calls)).toEqual([['y'], ['x']]);
    });

    it('with one message waiting a try makes one call; a message recorded meanwhile adds no alarm, but makes each later try two calls', async () => {
      const outage = async (recordOne: boolean) => {
        now = 1_000_000;
        const t = outboxDatabase({ name: 'main' });
        t.sink(down);
        await t.database.record('acme', ['waiting']);
        await t.alarm();
        now += 1_000;
        if (recordOne) await t.database.record('acme', ['recorded meanwhile']);
        const alarms = await t.run(3_600_000);
        expect(Math.max(...alarms.map((alarm) => alarm.calls.length))).toBe(recordOne ? 2 : 1);
        return { alarms: alarms.length, calls: alarms.flatMap((alarm) => alarm.calls).length, written: alarms.reduce((sum, alarm) => sum + alarm.written, 0) };
      };
      // The second order finds no other row: one call a try, the message's tried_at and the sink's row.
      expect(await outage(false)).toEqual({ alarms: 16, calls: 16, written: 32 });
      // The same alarms; every try now hands the newest and then the other, still at most two calls and two rows.
      expect(await outage(true)).toEqual({ alarms: 16, calls: 32, written: 48 });
    });

    it('2 000 waiting, an hour of outage: 17 alarms, 40 sink calls, 50 rows written', async () => {
      const t = outboxDatabase({ name: 'main' });
      for (let i = 0; i < 2_000; i += 100) await t.database.record('acme', range(100, i));
      t.sink(down);
      const alarms = await t.run(3_600_000);
      expect([alarms.length, alarms.flatMap((alarm) => alarm.calls).length, alarms.reduce((sum, alarm) => sum + alarm.written, 0)]).toEqual([17, 40, 50]);
    });

    it('a message every 10 s for an hour of outage: 17 alarms, 32 sink calls, 49 rows written', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sink(down);
      const alarms = await t.run(3_600_000, { ms: 10_000, record: (at) => [at] });
      // Besides the 360 messages recorded.
      expect([alarms.length, alarms.flatMap((alarm) => alarm.calls).length, alarms.reduce((sum, alarm) => sum + alarm.written, 0)]).toEqual([17, 32, 49]);
      expect(Math.max(...alarms.map((alarm) => alarm.calls.length))).toBe(2);
    });
  });

  describe('I4 — liveness', () => {
    it('in normal running reads the oldest due 100, by id; a message that fails alone leaves the read until its own backoff is over', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sink(failingOn((m) => m === 50));
      await t.database.record('acme', range(100));
      await t.alarm();
      expect(t.rows()).toMatchObject([{ message: '50', tries: 1, next_attempt_at: now + 5_000 }]);
      // Recorded before its retry: the read leaves it out.
      now += 4_000;
      await t.database.record('acme', range(150, 100));
      const from = t.handed.length;
      await t.alarm();
      await t.alarm();
      expect(t.calls(from)).toEqual([range(100, 100), range(50, 200)]);
      // Its backoff over, it is read again; alone, it goes on failing, handed at most 5 minutes apart.
      const alarms = await t.run(2 * 3_600_000);
      expect(alarms[0]!.at).toBe(1_000_000 + 5_000);
      expect(new Set(t.calls(from + 2).flat())).toEqual(new Set([50]));
      const gaps = alarms.slice(1).map((alarm, i) => alarm.at - alarms[i]!.at);
      expect(Math.max(...gaps)).toBe(300_000);
    });

    it('while down, a try hands the newest alone and, if the sink does not take it, the one tried or recorded longest ago alone', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['a', 'b', 'c', 'd']);
      t.sink(down);
      await t.alarm();
      expect(t.calls()).toEqual([['a', 'b', 'c', 'd'], ['a', 'b'], ['a']]);
      const tries = async (n: number) => {
        const from = t.handed.length;
        for (let i = 0; i < n; i++) {
          now = t.sinkState().down_until;
          await t.alarm();
        }
        return t.calls(from);
      };
      // A failed try moves the message it handed behind every message recorded or tried before it.
      expect(await tries(4)).toEqual([['d'], ['a'], ['d'], ['b'], ['d'], ['c'], ['d'], ['a']]);
      // A message recorded meanwhile is the newest: handed first. 'd', handed at every try, is behind 'b' and 'c'.
      now += 1_000;
      await t.database.record('acme', ['e']);
      expect(await tries(3)).toEqual([['e'], ['b'], ['e'], ['c'], ['e'], ['a']]);
      // Their own clocks did not move: a try writes only tried_at and the last error.
      expect(t.rows().map(({ message, tries, counted, next_attempt_at }) => ({ message, tries, counted, next_attempt_at }))).toEqual([
        { message: '"a"', tries: 1, counted: 0, next_attempt_at: 1_000_000 + 5_000 },
        { message: '"b"', tries: 0, counted: 0, next_attempt_at: 0 },
        { message: '"c"', tries: 0, counted: 0, next_attempt_at: 0 },
        { message: '"d"', tries: 0, counted: 0, next_attempt_at: 0 },
        { message: '"e"', tries: 0, counted: 0, next_attempt_at: 0 },
      ]);
    });

    it('over tries that take nothing, hands every waiting message alone by the try after as many tries as there are messages ahead of it', async () => {
      // Nothing recorded meanwhile: m<j> (j ahead of it: m0 … m<j − 1>) is handed alone at try j + 1, not within j;
      // m9, the newest, at every try.
      const quiet = outboxDatabase({ name: 'main' });
      quiet.sink(down);
      await quiet.database.record('acme', range(10).map((n) => `m${n}`));
      await quiet.alarm();
      const handedAt = new Map<unknown, number>();
      for (let k = 1; k <= 10; k++) {
        now = quiet.sinkState().down_until;
        const from = quiet.handed.length;
        await quiet.alarm();
        for (const [message] of quiet.calls(from)) if (!handedAt.has(message)) handedAt.set(message, k);
      }
      expect([...handedAt].sort(([, x], [, y]) => x - y)).toEqual([
        ['m9', 1],
        ...range(9).map((j) => [`m${j}`, j + 1]),
      ]);

      // A message recorded before every try is the newest there, handed first, and goes behind the rest.
      now = 1_000_000;
      const t = outboxDatabase({ name: 'main' });
      t.sink(down);
      await t.database.record('acme', range(10).map((n) => `m${n}`));
      await t.alarm();
      const first = new Map<unknown, number>();
      for (let k = 1; k <= 10; k++) {
        // A message recorded before every try: it is the newest there.
        now = t.sinkState().down_until - 1;
        await t.database.record('acme', [`new ${k}`]);
        now += 1;
        const from = t.handed.length;
        await t.alarm();
        const [newest, longest] = t.calls(from);
        expect(newest).toEqual([`new ${k}`]);
        if (!first.has(longest![0])) first.set(longest![0], k);
      }
      // m<j> has j messages ahead of it (m0 … m<j − 1>): it is handed at try j + 1. What is recorded meanwhile goes behind.
      expect([...first]).toEqual(range(10).map((j) => [`m${j}`, j + 1]));
    });

    it('the first try at which the sink takes a message ends the down state: a backlog of 2 000 drains at 100 a call', async () => {
      const t = outboxDatabase({ name: 'main' });
      for (let i = 0; i < 2_000; i += 100) await t.database.record('acme', range(100, i));
      t.sink(down);
      await t.run(3_600_000);
      const delivered = new Set<unknown>();
      t.sink((envelopes) => {
        for (const e of envelopes) delivered.add(e.message);
      });
      const recovery = await t.run(5 * 60_000);
      expect(delivered.size).toBe(2_000);
      expect(t.rows()).toEqual([]);
      expect(t.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });
      // The try's newest message, then 100 a call, one call an alarm.
      expect(recovery.map((alarm) => alarm.calls)).toEqual([[1, 100], ...Array.from({ length: 18 }, () => [100]), [99]]);
    });
  });

  describe('the documented limits', () => {
    /** A sink that throws for a call that holds a message starting with 'bad' and delivers every other one, noting when. */
    function badOnes(t: TestDatabase): Map<string, number> {
      const deliveredAt = new Map<string, number>();
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('bad'))) throw new Error('400 bad payload');
        for (const e of envelopes) deliveredAt.set(String(e.message), now);
      });
      return deliveredAt;
    }

    it('1. a message the sink never takes while it takes nothing else is never counted: the sink stays down, tried at its rounds to 5 minutes; each message recorded meanwhile waits for the next try and its delivery can count it once', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      const deliveredAt = badOnes(t);
      await t.database.record('acme', ['bad']);
      const alarms = await t.run(2 * 3_600_000);
      expect(t.rows()).toMatchObject([{ message: '"bad"', tries: 1, counted: 0 }]);
      expect(t.sinkState().down_until).toBeGreaterThan(now);
      for (const alarm of alarms) expect(alarm.calls).toEqual([1]);
      const gaps = alarms.slice(1).map((alarm, i) => alarm.at - alarms[i]!.at);
      expect(gaps.slice(0, 8)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
      expect(Math.max(...gaps)).toBe(300_000);
      for (const [i, good] of ['good 1', 'good 2', 'good 3'].entries()) {
        const recorded = now;
        const next = t.sinkState().down_until;
        await t.database.record('acme', [good]);
        expect(t.alarmAt()).toBe(next);
        const from = t.handed.length;
        await t.run(next - now);
        // It waited for the next try, at most 5 minutes, and was handed first, as the newest.
        expect(t.calls(from)[0]).toEqual([good]);
        expect(deliveredAt.get(good)! - recorded).toBeLessThanOrEqual(300_000);
        // That delivery counted 'bad' once; at 3 it is buried.
        if (i < 2) expect(t.rows()).toMatchObject([{ message: '"bad"', counted: i + 1 }]);
        await t.run(30 * 60_000);
      }
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toMatchObject([{ message: '"bad"', attempts: 3 }]);
    });

    it('2. a message that fails alone before anything was delivered takes the sink for down: the rest wait 5 s, and a round more, doubled, for each try that refuses both messages', async () => {
      // A refused message at the head of the read.
      const one = outboxDatabase({ name: 'main' });
      const deliveredAt = badOnes(one);
      await one.database.record('acme', ['bad', ...range(99).map((n) => `good ${n}`)]);
      const first = await one.alarm();
      expect(first.calls).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      expect(one.rows()).toHaveLength(100);
      expect(one.rows()[0]).toMatchObject({ message: '"bad"', tries: 1, counted: 0 });
      // The next try delivers the newest, and the rest go in that alarm: 5 s.
      const [next] = await one.run(5_000);
      expect(next!.calls).toHaveLength(16);
      expect(new Set(deliveredAt.values())).toEqual(new Set([1_000_000 + 5_000]));
      expect(deliveredAt.size).toBe(99);
      expect(one.rows()).toMatchObject([{ message: '"bad"', counted: 1 }]);

      // And a refused message as the newest: the first try refuses both it and the one at the head — one round more, 10 s.
      const two = outboxDatabase({ name: 'main' });
      const deliveredAt2 = badOnes(two);
      const start = now;
      await two.database.record('acme', ['bad 1', ...range(98).map((n) => `good ${n}`), 'bad 2']);
      await two.alarm();
      const tries = await two.run(15_000);
      // The second try's second message is taken; the alarm goes on, and once more at once for what its 16 calls left.
      expect(tries.map(({ at, calls }) => ({ at: at - start, calls: calls.length }))).toEqual([
        { at: 5_000, calls: 2 },
        { at: 15_000, calls: 16 },
        { at: 15_000, calls: 11 },
      ]);
      expect(two.calls(8).slice(0, 4)).toEqual([['bad 2'], ['bad 1'], ['bad 2'], ['good 0']]);
      expect(deliveredAt2.size).toBe(98);
      expect(new Set(deliveredAt2.values())).toEqual(new Set([start + 15_000]));
    });

    it('2. while refused messages fill the head of the read past what one alarm’s halving isolates, each try delivers only its newest message: the rest wait until those leave the read', async () => {
      /**
       * A sink relaying to two destinations, as the webhook sink of the README does: A is down (its messages
       * answered in { retry }), B takes everything. `refused` messages for A wait; one for B is recorded every 2 s.
       */
      const relay = async (refused: number, ms: number) => {
        now = 1_000_000;
        const t = outboxDatabase({ name: 'main' });
        const deliveredAt = new Map<string, number>();
        t.sink((envelopes) => {
          const retry = envelopes.filter((e) => String(e.message).startsWith('a'));
          for (const e of envelopes) if (!retry.includes(e)) deliveredAt.set(String(e.message), now);
          if (retry.length > 0) return { retry, error: new Error('503 destination A unavailable') };
        });
        for (let i = 0; i < refused; i += 100) await t.database.record('acme', range(Math.min(100, refused - i), i).map((n) => `a ${n}`));
        const recordedAt = new Map<string, number>();
        let n = 0;
        await t.run(ms, {
          ms: 2_000,
          record: (at) => {
            recordedAt.set(`b ${n}`, at);
            return [`b ${n++}`];
          },
        });
        const waits = [...recordedAt].map(([m, at]) => (deliveredAt.get(m) ?? now) - at);
        return {
          t,
          waiting: [...recordedAt.keys()].filter((m) => !deliveredAt.has(m)).length,
          longest: Math.max(...waits),
          // Every call that held a B message: the try's newest, alone, or a read with room for it.
          handedB: t.handed.filter((call) => call.some((e) => String(e.message).startsWith('b'))),
        };
      };

      // 300 refused at the head: each take-down's try delivers its newest message and the alarm after it is taken
      // down again by the head, until enough of them wait on their own backoff for the read to reach the rest.
      const some = await relay(300, 3_600_000);
      expect(some.waiting).toBe(0);
      expect(some.longest).toBeGreaterThan(20 * 60_000);
      expect(some.longest).toBeLessThan(25 * 60_000);
      expect(Math.max(...some.t.stats.map((alarm) => alarm.calls.length))).toBe(16);

      // 1 000: their backoff (at most 5 minutes) never takes enough of them out of the read. Two hours on, every B
      // message delivered was a try's newest, alone, and most still wait — the longest the whole run.
      const many = await relay(1_000, 2 * 3_600_000);
      expect(many.handedB.every((call) => call.length === 1)).toBe(true);
      expect(many.waiting).toBeGreaterThan(2_000);
      expect(many.longest).toBeGreaterThan(115 * 60_000);
      expect(many.t.dead()).toEqual([]);
    });

    it('3. a sink that stops part-way through each alarm (a quota) has that alarm’s failures alone counted: at most one a message an alarm', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 1_000 });
      await t.database.record('acme', range(300));
      let left = 10;
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        const sent = envelopes.slice(0, left);
        left -= sent.length;
        delivered.push(...sent.map((e) => e.message));
        if (sent.length < envelopes.length) return { retry: envelopes.slice(sent.length), error: new Error('429 quota spent') };
      });
      const countedNow = () => new Map(t.rows().map((row) => [row.id as number, row.counted as number]));
      let before = countedNow();
      let most = 0;
      await t.run(3 * 3_600_000, null, () => {
        const after = countedNow();
        for (const [id, counted] of after) most = Math.max(most, counted - (before.get(id) ?? 0));
        before = after;
        left = 10;
      });
      expect(most).toBe(1);
      expect(Math.max(...t.stats.map((alarm) => alarm.calls.length))).toBe(16);
      expect(new Set(delivered)).toEqual(new Set(range(300)));
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toEqual([]);
    });

    it('4. a sink that throws on messages it can never take: halving finds a few an alarm within its 16 calls; an alarm that finds only them takes the sink for down for a round', async () => {
      const t = outboxDatabase({ name: 'main' });
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => String(m).startsWith('bad'), delivered));
      await t.database.record('acme', range(100).map((n) => (n % 10 === 9 ? `bad ${n}` : n)));
      const first = await t.alarm();
      expect(first.calls).toHaveLength(16);
      expect(t.rows().filter((row) => row.tries === 1).map((row) => JSON.parse(row.message as string))).toEqual(['bad 9', 'bad 19']);

      // Only them waiting: halved to the first of them, which fails alone before anything was delivered.
      const only = outboxDatabase({ name: 'main' });
      const deliveredAt = badOnes(only);
      await only.database.record('acme', range(10).map((n) => `bad ${n}`));
      const alarm = await only.alarm();
      expect(alarm.calls).toEqual([10, 5, 3, 2, 1]);
      expect(only.sinkState()).toEqual({ down_until: now + 5_000, down_rounds: 1 });
      expect(only.rows().every((row) => row.counted === 0)).toBe(true);
      // A message recorded meanwhile goes at that try, the newest.
      await only.database.record('acme', ['good']);
      await only.run(5_000);
      expect(deliveredAt.get('good')).toBe(1_000_000 + 5_000);
    });

    it('5. a sink that answers success for what it did not deliver is the sink’s bug: the outbox takes its word', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['dropped']);
      t.sink(() => {});
      await t.alarm();
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toEqual([]);
    });
  });

  describe('the upgrade from 0.13', () => {
    it('adds the columns a 0.13 outbox lacks, once, and resets nothing: what 0.13 counted counts nothing', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sqlite.exec(OUTBOX_0_13);
      // 0.13 retried the 100 oldest together forever, counting each failure on all of them.
      for (let i = 0; i < 100; i++) {
        t.sqlite
          .prepare(`INSERT INTO __outbox (instance_key, message, recorded_at, attempts, last_error) VALUES ('acme', ?, 5, 120, 'Error: sink is down')`)
          .run(JSON.stringify(i === 0 ? 'poison' : `m${i}`));
      }
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => m === 'poison', delivered));
      await t.alarm();
      const columns = () => (t.sqlite.prepare('PRAGMA table_info(__outbox)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns()).toEqual(['id', 'instance_key', 'message', 'recorded_at', 'attempts', 'last_error', 'tries', 'counted', 'next_attempt_at', 'tried_at']);
      expect(t.handed[0]!.every((e) => e.attempts === 0)).toBe(true);
      // The poison heads every first half: it fails alone before anything was delivered, uncounted, and the sink is taken for down.
      expect(t.handed.map((envelopes) => envelopes.length)).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      expect(delivered).toEqual([]);
      // What 0.13 wrote is as it left it, but for the poison's last error.
      expect(t.rows().slice(1).every((row) => row.attempts === 120 && row.last_error === 'Error: sink is down' && row.counted === 0)).toBe(true);
      // Its next try delivers the newest, and the rest go in that alarm; then the poison's failure alone counts.
      const [next] = await t.run(5_000);
      expect(next!.calls).toEqual([1, 99, 50, 25, 13, 7, 4, 2, 1, 1, 2, 3, 6, 12, 25, 49]);
      expect(delivered).toHaveLength(99);
      expect(t.rows()).toMatchObject([{ message: '"poison"', attempts: 120, tries: 2, counted: 1 }]);
      // Another instance on the upgraded table adds nothing, and records and delivers on it.
      (t.database as unknown as { outboxReady: boolean }).outboxReady = false;
      t.sink(() => {});
      await t.database.record('acme', ['new']);
      await t.alarm();
      expect(columns()).toHaveLength(10);
      expect(t.handed.at(-1)!.map((e) => e.message)).toEqual(['new']);
    });

    it('runs on tables an earlier build of this release left, with columns it no longer has', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sqlite.exec(`CREATE TABLE __outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, instance_key TEXT NOT NULL, message TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, tries INTEGER NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, tried_at INTEGER NOT NULL DEFAULT 0, failed_after INTEGER
      )`);
      t.sqlite.exec(`CREATE TABLE __outbox_sink (
        id INTEGER PRIMARY KEY CHECK (id = 1), settled INTEGER NOT NULL DEFAULT 0, down_until INTEGER NOT NULL DEFAULT 0,
        down_rounds INTEGER NOT NULL DEFAULT 0, early_tries INTEGER NOT NULL DEFAULT 0
      )`);
      t.sink(down);
      await t.database.record('acme', ['x', 'y']);
      await t.alarm();
      expect(t.sinkState()).toEqual({ down_until: now + 5_000, down_rounds: 1 });
      t.sink(() => {});
      now += 5_000;
      await t.alarm();
      expect(t.rows()).toEqual([]);
      expect(t.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });
    });
  });

  describe('the rollback to 0.13', () => {
    it('0.13 runs on the table — its insert, its failed and its successful delivery — and forward again, nothing it counted counts', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      // This release: 'ok' delivered, then 'bad' fails alone: one counted failure.
      t.sink(failingOn((m) => m === 'bad'));
      await t.database.record('acme', ['ok', 'bad']);
      await t.alarm();
      expect(t.rows()).toMatchObject([{ message: '"bad"', counted: 1 }]);

      // Rolled back (a wrangler rollback, a gradual deployment): 0.13's statements, as it runs them, on this table.
      const v013 = {
        table: () => t.sqlite.exec(OUTBOX_0_13.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')),
        record: (message: unknown) =>
          t.sqlite.prepare('INSERT INTO __outbox (instance_key, message, recorded_at) VALUES (?, ?, ?)').run('acme', JSON.stringify(message), now),
        read: () => t.sqlite.prepare('SELECT id, instance_key, message, recorded_at, attempts FROM __outbox ORDER BY id LIMIT ?').all(100) as Array<{ id: number }>,
        failed: (lastId: number) => t.sqlite.prepare('UPDATE __outbox SET attempts = attempts + 1, last_error = ? WHERE id <= ?').run('Error: sink is down', lastId),
        delivered: (lastId: number) => t.sqlite.prepare('DELETE FROM __outbox WHERE id <= ?').run(lastId),
      };
      v013.table();
      v013.record('later');
      // Its alarm fails for ten hours, each failure counted on every one of the 100 oldest.
      for (let round = 0; round < 120; round++) v013.failed(v013.read().at(-1)!.id);
      expect(t.rows().map(({ message, attempts }) => ({ message, attempts }))).toEqual([
        { message: '"bad"', attempts: 120 },
        { message: '"later"', attempts: 120 },
      ]);

      // Forward again, on a new instance; the outage goes on for an hour.
      (t.database as unknown as { outboxReady: boolean }).outboxReady = false;
      t.sink(down);
      const from = t.handed.length;
      await t.run(3_600_000);
      expect(t.dead()).toEqual([]);
      // Nothing was delivered: 'later' counts nothing, 'bad' has its one; 0.13's attempts are never read.
      const attempts = (message: string) => new Set(t.handed.slice(from).flat().filter((e) => e.message === message).map((e) => e.attempts));
      expect(attempts('later')).toEqual(new Set([0]));
      expect(attempts('bad')).toEqual(new Set([1]));
      expect(t.sinkState().down_until).toBeGreaterThan(now);

      // Rolled back again: 0.13 delivers what waits and deletes it. Forward: the next try finds nothing, and the sink is not down.
      v013.delivered(v013.read().at(-1)!.id);
      (t.database as unknown as { outboxReady: boolean }).outboxReady = false;
      const calls = t.handed.length;
      now = t.sinkState().down_until;
      await t.alarm();
      expect(t.handed).toHaveLength(calls);
      expect(t.sinkState()).toEqual({ down_until: 0, down_rounds: 0 });
      expect(t.alarmAt()).toBeNull();
      t.sink(() => {});
      await t.database.record('acme', ['new']);
      await t.alarm();
      expect(t.handed.at(-1)!.map(({ message, attempts }) => ({ message, attempts }))).toEqual([{ message: 'new', attempts: 0 }]);
    });
  });
});
