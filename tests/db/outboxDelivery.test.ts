import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSqlite } from '../../src/testing';
import { type OutboxDelivery, type OutboxEnvelope, type OutboxSink } from '../../src/db/outbox';

// The outbox's delivery (SqliteDurableObject's alarm) over a real in-memory
// SQLite and a controlled clock: what the sink is handed, what is kept,
// retried and moved aside, and what it costs. The scenario tests are named
// after the promises of the delivery: I1 nothing lost, I2 buried only by the
// rule, I3 cost, I4 liveness.

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
      (sqlite.prepare('SELECT settled, down_until, down_rounds FROM __outbox_sink WHERE id = 1').get() as Record<string, number> | undefined) ?? {
        settled: 0,
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

  describe('one sink call', () => {
    it('delivers due messages oldest first, at most 100 a call, and comes back at once for the rest', async () => {
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

    it('settles by the envelope objects: { dead } moved aside at once, { retry } not delivered and halved, every other one delivered', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', [1, 2, 3, 4, 5]);
      const refused = new Error('the webhook answered 410 for 5, 503 for the odd ones');
      t.sink((envelopes) => ({
        retry: envelopes.filter((e) => e.message === 1 || e.message === 3),
        dead: envelopes.filter((e) => e.message === 5),
        error: refused,
      }));
      await t.alarm();
      // 2 and 4 delivered, 5 moved aside; 1 and 3 halved and tried again in the same alarm, each failing alone.
      expect(t.calls()).toEqual([[1, 2, 3, 4, 5], [1], [3]]);
      expect(t.dead()).toEqual([
        { id: 5, instance_key: 'acme', message: '5', recorded_at: 1_000_000, attempts: 0, last_error: String(refused), dead_at: 1_000_000 },
      ]);
      // The sink settled others in this alarm: their failures alone count.
      expect(t.rows().map(({ message, tries, attempts, last_error, next_attempt_at }) => ({ message, tries, attempts, last_error, next_attempt_at }))).toEqual([
        { message: '1', tries: 1, attempts: 1, last_error: String(refused), next_attempt_at: now + 5_000 },
        { message: '3', tries: 1, attempts: 1, last_error: String(refused), next_attempt_at: now + 5_000 },
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

    it('records into a new outbox after destroyDatabase wiped the storage', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', ['before']);
      destroy(t);
      await t.database.record('acme', ['after']);
      expect(t.rows().map((row) => row.message)).toEqual(['"after"']);
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
      // 'a' failed alone, in a call that settled 'b': counted.
      expect(t.rows().map((row) => ({ m: JSON.parse(row.message as string).m, tries: row.tries, attempts: row.attempts }))).toEqual([
        { m: 'a', tries: 1, attempts: 1 },
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
        // Failed alone with nothing settled: kept, the sink taken for down, the alarm set for its next try.
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

    describe('destroyDatabase() while a call is in flight', () => {
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
        expect(t.rows()).toMatchObject([{ id: 1, message: '"new"', attempts: 0, tries: 0 }]);
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
    it('of 100 messages, one bad: the other 99 are delivered in that alarm, and the bad one is counted alone', async () => {
      const t = outboxDatabase({ name: 'main' });
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => m === 63, delivered));
      await t.database.record('acme', range(100));
      const alarm = await t.alarm();
      expect(delivered.sort((a, b) => (a as number) - (b as number))).toEqual(range(100).filter((m) => m !== 63));
      // Halved until it is alone, each half tried next: 15 calls.
      expect(alarm.calls).toHaveLength(15);
      expect(t.rows()).toMatchObject([{ message: '63', tries: 1, attempts: 1, next_attempt_at: now + 5_000 }]);
      expect(t.sinkState()).toMatchObject({ down_until: 0 });
      expect(t.alarmAt()).toBe(now + 5_000);
    });

    it('buries a bad message after maxAttempts counted failures, each alone and after the sink settled something else', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => m === 'bad', delivered));
      await t.database.record('acme', ['bad']);
      // Alone, with nothing settled since it was recorded: not counted — and the sink is taken for down.
      await t.alarm();
      expect(t.rows()).toMatchObject([{ tries: 1, attempts: 0 }]);
      expect(t.sinkState().down_until).toBe(now + 5_000);
      // Its next try: a fresh message goes first and is delivered, then 'bad' fails alone — counted.
      now = t.alarmAt()!;
      await t.database.record('acme', ['fine 1']);
      await t.alarm();
      expect(t.rows()).toMatchObject([{ tries: 2, attempts: 1 }]);
      // Half an hour with nothing else: it fails alone again and again, never counted.
      await t.run(30 * 60_000);
      const [waiting] = t.rows();
      expect(waiting!.attempts).toBe(1);
      expect(waiting!.tries as number).toBeGreaterThan(5);
      // Something else is delivered before each of its next two failures: the second and the third, and it is buried.
      for (const fine of ['fine 2', 'fine 3']) {
        now = t.alarmAt()!;
        await t.database.record('acme', [fine]);
        await t.alarm();
      }
      expect(delivered).toEqual(['fine 1', 'fine 2', 'fine 3']);
      expect(t.rows()).toEqual([]);
      expect(t.dead()).toMatchObject([{ message: '"bad"', attempts: 3, last_error: 'Error: 400 bad payload' }]);
      expect(errors.mock.calls.map(([text]) => String(text)).at(-1)).toContain('1 outbox message(s) of main reached 3 counted failures');
      expect(t.alarmAt()).toBeNull();
    });

    it("stamps a message recorded while the alarm awaits a later call with the alarm's count, not the one it has not written yet", async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
      await t.database.record('acme', ['a', 'b', 'c']);
      // The first call delivers 'a'. While the call that hands 'c' alone is awaited, an action records 'x'.
      t.sink(async (envelopes) => {
        if (envelopes.length === 3) return { retry: envelopes.filter((e) => e.message !== 'a') };
        if (envelopes[0]!.message === 'c') await t.database.record('acme', ['x']);
        throw new Error('400 bad payload');
      });
      await t.alarm();
      // 'b' and 'c' failed alone after 'a' was delivered: counted. 'x' was recorded after that, with the count the alarm had.
      expect(t.rows().map(({ message, attempts, failed_after }) => ({ message, attempts, failed_after }))).toEqual([
        { message: '"b"', attempts: 1, failed_after: 1 },
        { message: '"c"', attempts: 1, failed_after: 1 },
        { message: '"x"', attempts: 0, failed_after: 1 },
      ]);
      // An outage: nothing was delivered since 'x' was recorded, so its first failure counts nothing.
      t.sink(down);
      await t.alarm();
      expect(t.rows().find((row) => row.message === '"x"')).toMatchObject({ tries: 1, attempts: 0 });
      // The sink is back for others: 'y' goes at the next try, then 'x' fails alone — its first counted failure, not its second.
      now = t.sinkState().down_until;
      await t.database.record('acme', ['y']);
      t.sink(failingOn((m) => m === 'x'));
      await t.alarm();
      expect(t.dead()).toEqual([]);
      expect(t.rows().find((row) => row.message === '"x"')).toMatchObject({ attempts: 1 });
    });

    it('an outage counts at most one failure a message, so it buries only one that already had maxAttempts - 1 counted', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
      await t.database.record('acme', ['a', 'b']);
      // The sink delivered something since both were recorded, and 'a' had one counted failure before.
      t.sqlite.exec('INSERT INTO __outbox_sink (id, settled) VALUES (1, 1)');
      t.sqlite.exec(`UPDATE __outbox SET attempts = 1, tries = 1 WHERE message = '"a"'`);
      t.sink(down);
      await t.run(3_600_000);
      // Each one's first failure in the outage counted, and no other: 'a' reached 2, 'b' has 1.
      expect(t.dead()).toMatchObject([{ message: '"a"', attempts: 2 }]);
      expect(t.rows()).toMatchObject([{ message: '"b"', attempts: 1 }]);
      expect(t.rows()[0]!.tries as number).toBeGreaterThan(5);
    });

    it('a group failure counts nothing and moves no clock: only the message that fails alone is written', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(200));
      // The sink takes the first call, then is down.
      let calls = 0;
      t.sink(() => {
        if (calls++ > 0) down();
      });
      await t.alarm();
      expect(t.sinkState().settled).toBe(1);
      const alarm = await t.alarm();
      expect(alarm.calls).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      // Something settled since it was recorded: the one that failed alone is counted. No other row was written.
      const touched = t.rows().filter((row) => row.tries !== 0 || row.attempts !== 0 || row.next_attempt_at !== 0 || row.last_error !== null);
      expect(touched).toMatchObject([{ message: '100', tries: 1, attempts: 1 }]);
      expect(t.rows()).toHaveLength(100);
      // The row that failed alone and the sink's row.
      expect(alarm.written).toBe(2);
    });

    it('an outage of 10 h with 300 waiting and a push every 7 minutes buries nothing and counts no message past one failure', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 3 });
      await t.database.record('acme', range(400));
      let calls = 0;
      t.sink(() => {
        if (calls++ > 0) down();
      });
      // The first 100 are delivered; then ten hours down.
      let pushed = 0;
      await t.run(10 * 3_600_000, { ms: 7 * 60_000, record: () => [`during ${pushed++}`] });
      expect(t.dead()).toEqual([]);
      expect(t.rows()).toHaveLength(300 + pushed);
      // Each of the 300 counted once at most: its first failure alone came after the sink settled the first 100.
      expect(Math.max(...t.rows().map((row) => row.attempts as number))).toBe(1);
      // Nothing settled since a message recorded during the outage was recorded: none of those counted.
      for (const row of t.rows().filter((row) => String(row.message).startsWith('"during'))) expect(row.attempts).toBe(0);
    });
  });

  describe('I3 — cost', () => {
    it('an outage costs 8 sink calls in the alarm that notices it, then one a round; pushes add no alarm and no call', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(300));
      t.sink(down);
      let pushed = 0;
      const alarms = await t.run(10 * 3_600_000, { ms: 7 * 60_000, record: () => [`during ${pushed++}`] });
      expect(alarms[0]!.calls).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      // Every other alarm is a round: one message, two rows written (it and the sink's row).
      for (const alarm of alarms.slice(1)) expect(alarm).toMatchObject({ calls: [1], written: 2 });
      // The rounds back off 5 s, 10 s, … and stay at five minutes: 12 an hour, whatever was pushed (85 messages).
      const gaps = alarms.slice(1).map((alarm, i) => alarm.at - alarms[i]!.at);
      expect(gaps.slice(0, 8)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
      expect(alarms.filter((alarm) => alarm.at >= 1_000_000 + 9 * 3_600_000)).toHaveLength(12);
      expect(pushed).toBe(85);
      // A push during the outage leaves the alarm at the sink's next try.
      const next = t.alarmAt()!;
      expect(next).toBeGreaterThan(now);
      await t.database.record('acme', ['one more']);
      expect(t.alarmAt()).toBe(next);
    });

    it('an outage over messages that all failed alone before: a message recorded meanwhile brings the next try forward, once a round at most, and is what it hands the sink', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(100));
      t.sqlite.exec('UPDATE __outbox SET tries = 3');
      t.sink(down);
      let pushed = 0;
      const alarms = await t.run(3_600_000, { ms: 7 * 60_000, record: () => [`during ${pushed++}`] });
      expect(alarms[0]!.calls).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
      for (const alarm of alarms.slice(1)) expect(alarm).toMatchObject({ calls: [1], written: 2 });
      // Each try handed the sink a message that had failed alone before; each message recorded brought the next one
      // forward, to the time it was recorded, and was the one it handed the sink.
      expect(pushed).toBe(8);
      for (let k = 0; k < pushed; k++) {
        const at = 1_000_000 + (k + 1) * 7 * 60_000;
        const alarm = alarms.findIndex((a) => a.at === at);
        expect(alarm).toBeGreaterThan(0);
        expect(t.calls()[alarm + 7]).toEqual([`during ${k}`]);
      }
      // That try moves the next one on: at most one more alarm and one more call a message, never more than one a round.
      expect(alarms).toHaveLength(22);
      expect(alarms.length).toBeLessThanOrEqual(17 + pushed);
    });

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

    it('2 000 waiting, an hour of outage: 17 alarms, 24 sink calls, two rows written a round', async () => {
      const t = outboxDatabase({ name: 'main' });
      for (let i = 0; i < 2_000; i += 100) await t.database.record('acme', range(100, i));
      t.sink(down);
      const alarms = await t.run(3_600_000);
      expect(alarms).toHaveLength(17);
      expect(alarms.flatMap((alarm) => alarm.calls)).toHaveLength(24);
      expect(alarms.map((alarm) => alarm.written)).toEqual(Array.from({ length: 17 }, () => 2));
    });

    it('a message every 10 s for an hour of outage: 17 alarms, 17 sink calls, two rows written a round', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sink(down);
      const written = t.counted.written;
      const alarms = await t.run(3_600_000, { ms: 10_000, record: (at) => [at] });
      expect(alarms).toHaveLength(17);
      expect(alarms.flatMap((alarm) => alarm.calls)).toEqual(Array.from({ length: 17 }, () => 1));
      expect(alarms.map((alarm) => alarm.written)).toEqual(Array.from({ length: 17 }, () => 2));
      // Besides the 360 messages recorded, those rows are all that was written.
      expect(t.counted.written - written).toBe(360 + 34);
    });

    it('reads __outbox twice in an alarm that delivers, once at a next try that finds the sink down, and not before it', async () => {
      const t = outboxDatabase({ name: 'main' });
      await t.database.record('acme', range(100));
      let reads = t.counted.outboxReads;
      // The messages due, then the earliest waiting.
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(2);

      t.sink(down);
      await t.database.record('acme', ['x']);
      await t.alarm();
      expect(t.sinkState().down_until).toBeGreaterThan(now);
      // Before the sink's next try: one row of __outbox_sink, nothing of __outbox, no call.
      reads = t.counted.outboxReads;
      const calls = t.handed.length;
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(0);
      expect(t.handed).toHaveLength(calls);
      // Its next try: the one message, read once.
      now = t.sinkState().down_until;
      reads = t.counted.outboxReads;
      await t.alarm();
      expect(t.counted.outboxReads - reads).toBe(1);
    });
  });

  describe('I4 — liveness', () => {
    it('100 bad messages at the lowest ids and a good one after them: the good one is read first and delivered in that alarm', async () => {
      const t = outboxDatabase({ name: 'main' });
      const delivered: Array<{ message: unknown; at: number }> = [];
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('bad'))) throw new Error('400 bad payload');
        delivered.push(...envelopes.map((e) => ({ message: e.message, at: now })));
      });
      // A hundred bad ones, each failed alone before, all due — the hundred oldest — and a good one behind them.
      await t.database.record('acme', range(100).map((i) => `bad ${i}`));
      t.sqlite.exec('UPDATE __outbox SET tries = 3');
      await t.database.record('acme', ['good']);
      await t.run(60_000);
      // It never failed alone: it heads the read, ahead of the hundred.
      expect(delivered).toEqual([{ message: 'good', at: 1_000_000 }]);
      expect(t.dead()).toEqual([]);
    });

    it('its tries take the newest and the oldest of the least tried by turns: [good, bad] recorded each minute after an outage holds no good one back', async () => {
      const t = outboxDatabase({ name: 'main' });
      let outage = true;
      const deliveredAt = new Map<string, number>();
      t.sink((envelopes) => {
        if (outage) throw new Error('503');
        if (envelopes.some((e) => String(e.message).startsWith('bad'))) throw new Error('400 bad payload');
        for (const e of envelopes) deliveredAt.set(String(e.message), now);
      });
      const recordedAt = new Map<string, number>();
      let i = 0;
      const record = (at: number) => {
        recordedAt.set(`good ${i}`, at);
        return [`good ${i}`, `bad ${i++}`];
      };
      await t.run(10 * 60_000, { ms: 60_000, record });
      outage = false;
      await t.run(3 * 3_600_000, { ms: 60_000, record });
      // From the end of the outage, or from its recording, each good one waits two tries at most (five minutes each).
      const end = now;
      const waits = [...recordedAt]
        .filter(([, at]) => at <= end - 10 * 60_000)
        .map(([m, at]) => (deliveredAt.get(m) ?? Infinity) - Math.max(at, 1_000_000 + 10 * 60_000));
      expect(waits).toHaveLength(180);
      expect(Math.max(...waits)).toBeLessThanOrEqual(10 * 60_000);
    });

    it('[good, bad] recorded every 4 minutes, no outage: each good one is delivered', async () => {
      const t = outboxDatabase({ name: 'main' });
      const deliveredAt = new Map<string, number>();
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('bad'))) throw new Error('400 bad payload');
        for (const e of envelopes) deliveredAt.set(String(e.message), now);
      });
      const recordedAt = new Map<string, number>();
      let i = 0;
      await t.run(3 * 3_600_000, {
        ms: 4 * 60_000,
        record: (at) => {
          recordedAt.set(`good ${i}`, at);
          return [`good ${i}`, `bad ${i++}`];
        },
      });
      // The bad one of each pair fails alone and holds the sink down on its retry. The next pair brings that try
      // forward; when it hands the sink the new bad one, the try after it hands it the good one.
      const waits = [...recordedAt].map(([m, at]) => (deliveredAt.get(m) ?? Infinity) - at);
      expect(waits).toHaveLength(45);
      expect(Math.max(...waits)).toBeLessThanOrEqual(5 * 60_000);
    });

    it('1 000 bad messages at the head never keep a good one recorded after them out of the read', async () => {
      const t = outboxDatabase({ name: 'main' });
      const deliveredAt = new Map<string, number>();
      t.sink((envelopes) => {
        if (envelopes.some((e) => String(e.message).startsWith('bad'))) throw new Error('400 bad payload');
        for (const e of envelopes) deliveredAt.set(String(e.message), now);
      });
      for (let k = 0; k < 1_000; k += 50) await t.database.record('acme', range(50, k).map((n) => `bad ${n}`));
      const recordedAt = new Map<string, number>();
      let i = 0;
      const record = (at: number) => {
        recordedAt.set(`good ${i}`, at);
        return [`good ${i++}`];
      };
      await t.run(2 * 3_600_000, { ms: 3_000, record });
      const waits = [...recordedAt].map(([m, at]) => ({ at, wait: (deliveredAt.get(m) ?? Infinity) - at }));
      // While bad ones that never failed alone are at the head, the newest good one goes at each try; once each bad
      // one has failed alone, every good one is read first and goes at once.
      expect(waits).toHaveLength(2_400);
      expect(Math.max(...waits.map(({ wait }) => wait))).toBeLessThan(15 * 60_000);
      expect(waits.filter(({ at, wait }) => at >= 1_000_000 + 15 * 60_000 && wait > 0)).toEqual([]);
      expect(t.dead()).toEqual([]);
    });

    it('a message that failed alone before and fails again, alone, holds no message recorded after it', async () => {
      const t = outboxDatabase({ name: 'main' });
      const deliveredAt = new Map<string, number>();
      t.sink((envelopes) => {
        if (envelopes.some((e) => e.message === 'bad')) throw new Error('400 bad payload');
        for (const e of envelopes) deliveredAt.set(String(e.message), now);
      });
      await t.database.record('acme', ['bad']);
      const recordedAt = new Map<string, number>();
      let i = 0;
      await t.run(6 * 3_600_000, {
        ms: 20 * 60_000,
        record: (at) => {
          recordedAt.set(`good ${i}`, at);
          return [`good ${i++}`];
        },
      });
      // Each good one comes while 'bad' holds the sink down on its own retry: it brings the try forward and goes.
      const waits = [...recordedAt].map(([m, at]) => (deliveredAt.get(m) ?? Infinity) - at);
      expect(waits).toEqual(Array.from({ length: 18 }, () => 0));
      // 'bad' is counted at its failure after each of them.
      expect(t.rows()).toMatchObject([{ message: '"bad"', attempts: 17 }]);
    });

    it('a sink that stops at a bad message and names everything after it in { retry } buries no good message', async () => {
      const t = outboxDatabase({ name: 'main', maxAttempts: 2 });
      const delivered: unknown[] = [];
      t.sink((envelopes) => {
        const bad = envelopes.findIndex((e) => String(e.message).startsWith('bad'));
        const sent = bad === -1 ? envelopes : envelopes.slice(0, bad);
        delivered.push(...sent.map((e) => e.message));
        if (bad !== -1) return { retry: envelopes.slice(bad), error: new Error('stopped at a bad one') };
      });
      await t.database.record('acme', ['g0', 'g1', 'bad 1', 'g2', 'g3', 'g4', 'bad 2', 'g5', 'bad 3', 'g6']);
      let good = 7;
      await t.run(60 * 60_000, { ms: 20_000, record: () => [`g${good++}`] });
      expect(t.dead().map((row) => JSON.parse(row.message as string)).sort()).toEqual(['bad 1', 'bad 2', 'bad 3']);
      expect(t.rows()).toEqual([]);
      expect(new Set(delivered)).toEqual(new Set(range(good).map((i) => `g${i}`)));
    });

    it('after an outage, drains a backlog of 2 000 at 100 a call', async () => {
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
      // The next try's one message, then 100 a call, one call an alarm.
      expect(recovery.map((alarm) => alarm.calls)).toEqual([[1, 100], ...Array.from({ length: 18 }, () => [100]), [99]]);
    });
  });

  describe('the upgrade', () => {
    it('adds the columns a 0.13 outbox lacks and sets its attempts to 0: the poison counted from 0, the other 99 delivered', async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sqlite.exec(OUTBOX_0_13);
      // 0.13 retried the 100 oldest together forever, counting each failure on all of them.
      for (let i = 0; i < 100; i++) {
        t.sqlite.exec(`INSERT INTO __outbox (instance_key, message, recorded_at, attempts) VALUES ('acme', '${JSON.stringify(i === 0 ? 'poison' : `m${i}`)}', 5, 120)`);
      }
      const delivered: unknown[] = [];
      t.sink(failingOn((m) => m === 'poison', delivered));
      await t.alarm();
      const columns = (t.sqlite.prepare('PRAGMA table_info(__outbox)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['tries', 'next_attempt_at', 'failed_after']));
      expect(t.handed[0]!.every((e) => e.attempts === 0)).toBe(true);
      // The poison heads every first half: it fails alone before anything settled, and the sink is taken for down once.
      expect(delivered).toEqual([]);
      expect(t.rows().map((row) => row.attempts)).toEqual(Array.from({ length: 100 }, () => 0));
      // Its next try, 5 s later, delivers a message, and the rest go in that alarm: the poison's failure alone after them counts.
      await t.run(5_000);
      expect(delivered).toHaveLength(99);
      expect(t.rows()).toMatchObject([{ message: '"poison"', attempts: 1, tries: 2 }]);
      expect(t.dead()).toEqual([]);
      // A new message is recorded and delivered on the upgraded table.
      t.sink(() => {});
      await t.database.record('acme', ['new']);
      await t.alarm();
      expect(t.handed.at(-1)!.map((e) => e.message)).toEqual(['new']);
    });

    it("adds __outbox_sink's settled to a sink table an earlier build of this release created", async () => {
      const t = outboxDatabase({ name: 'main' });
      t.sqlite.exec(
        'CREATE TABLE __outbox_sink (id INTEGER PRIMARY KEY CHECK (id = 1), delivered_at INTEGER NOT NULL DEFAULT 0, failing INTEGER NOT NULL DEFAULT 0, down_until INTEGER NOT NULL DEFAULT 0, down_rounds INTEGER NOT NULL DEFAULT 0)',
      );
      await t.database.record('acme', ['x', 'y']);
      t.sink((envelopes) => ({ retry: envelopes.filter((e) => e.message === 'y') }));
      await t.alarm();
      expect(t.sinkState()).toEqual({ settled: 1, down_until: 0, down_rounds: 0 });
    });
  });
});
