import { SqliteDurableObject, type Migrations } from '../../src/db/SqliteDurableObject';
import type { OutboxEnvelope } from '../../src/db/outbox';
import { type, batchedRpc, callAction, getAction, getDoContext, registerAction, runWithDoContext, type RpcOptions } from '../../src/registry';
import { integer, table, text } from '../../src/schema';

// Actions as one transaction, against a real workerd. `rpc()` below is what
// the Vite plugin generates for a database (src/vite/modules/generator.ts,
// buildRpcMethod), statement for statement: migrations, the action and its
// validator, the context, runWithDoContext with the objects waiting on the
// call, runAction around the handler. A call into another database is what
// the transform makes of it (`batchedRpc(env.BINDING, key, action, args,
// database)`), and a call into the same one what its short path makes
// (`callAction(__do.db, database, action, args, __do.ctx)`).

const vouchers = table('vouchers', {
  id: integer().primaryKey({ autoIncrement: true }),
  series: text().notNull(),
  number: integer().notNull(),
});
const lines = table('lines', {
  id: integer().primaryKey({ autoIncrement: true }),
  note: text().notNull(),
});
const balances = table('balances', {
  id: integer().primaryKey(),
  amount: integer().notNull(),
});

const MIGRATIONS: Migrations = {
  '20240101_ledger': {
    chunks: [
      [
        'CREATE TABLE vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, series TEXT NOT NULL, number INTEGER NOT NULL)',
        'CREATE UNIQUE INDEX vouchers_series_number ON vouchers (series, number)',
        'CREATE TABLE lines (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)',
        'CREATE TABLE balances (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)',
      ],
    ],
  },
};

type Db = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ctx = {
  env: Record<string, unknown>;
  instanceKey: string;
  outbox: { push(message: unknown): void };
  transaction<T>(fn: () => Promise<T>): Promise<T>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (db: Db, text: string) => db.insertInto('lines').values({ note: text }).execute();

function ledgerAction(name: string, handler: (db: Db, args: any, ctx: Ctx) => Promise<unknown>): void {
  registerAction('ledger', name, { validator: type({ '[string]': 'unknown' }), handler: handler as never });
}

/** A voucher and two lines, then the voucher again: the UNIQUE index refuses the fourth statement. */
ledgerAction('post', async (db, { number, again }) => {
  await db.insertInto('vouchers').values({ series: 'A', number }).execute();
  await note(db, `debit ${number}`);
  await note(db, `credit ${number}`);
  if (again) await db.insertInto('vouchers').values({ series: 'A', number }).execute();
  return number;
});

ledgerAction('pushThenThrow', async (db, _args, ctx) => {
  await note(db, 'pushed');
  ctx.outbox.push({ job: 'never' });
  throw new Error('after the push');
});

ledgerAction('pushAndWrite', async (db, _args, ctx) => {
  await note(db, 'pushed');
  ctx.outbox.push({ job: 'kept' });
  return 'ok';
});

/** Read, wait on real I/O (a timer), write: two calls interleaving here lose an update. */
ledgerAction('addToBalance', async (db, { amount, wait }) => {
  const row = await db.selectFrom('balances').select('amount').where('id', '=', 1).executeTakeFirst();
  if (wait) await sleep(wait);
  const next = (row?.amount ?? 0) + amount;
  await db.insertInto('balances').values({ id: 1, amount: next }).onConflict((oc: Db) => oc.column('id').doUpdateSet({ amount: next })).execute();
  return next;
});

/** A part that may fail on its own: its line and its message go, the action's stay. */
ledgerAction('withPart', async (db, { fail }, ctx) => {
  await note(db, 'before');
  ctx.outbox.push('outer');
  let caught: string | null = null;
  try {
    await ctx.transaction(async () => {
      await note(db, 'part');
      ctx.outbox.push('part');
      if (fail) throw new Error('the part failed');
    });
  } catch (error) {
    caught = (error as Error).message;
  }
  await note(db, 'after');
  return caught;
});

/** Two parts started at once: they run one after the other, and the first one's failure takes only its own line. */
ledgerAction('siblingParts', async (db, _args, ctx) => {
  const log: string[] = [];
  const first = ctx.transaction(async () => {
    log.push('first starts');
    await note(db, 'first');
    await sleep(20);
    log.push('first throws');
    throw new Error('first');
  }).catch(() => log.push('first rolled back'));
  const second = ctx.transaction(async () => {
    log.push('second starts');
    await sleep(1);
    await note(db, 'second');
    log.push('second ends');
  });
  await Promise.all([first, second]);
  return log;
});

ledgerAction('writeThenThrow', async (db) => {
  await note(db, 'callee');
  throw new Error('the callee failed');
});

/** An action of the same database called from this one (its short path) that fails: its line goes, the caller's stay. */
ledgerAction('callsFailing', async (db) => {
  await note(db, 'caller before');
  const caller = getDoContext()!;
  let caught: string | null = null;
  try {
    await callAction(caller.db, 'ledger', 'writeThenThrow', {}, caller.ctx);
  } catch (error) {
    caught = (error as Error).message;
  }
  await note(db, 'caller after');
  return caught;
});

ledgerAction('kyselyTransaction', async (db) => {
  try {
    await db.transaction().execute(async (trx: Db) => note(trx, 'in a Kysely transaction'));
    return 'ran';
  } catch (error) {
    return (error as Error).message;
  }
});

/** A call into the other database, which calls back into this one. */
ledgerAction('callOther', async (_db, _args, ctx) => {
  const started = Date.now();
  const answer = (await batchedRpc(ctx.env.TEST_ATOMIC_OTHER_DO as never, ctx.instanceKey, 'callBack', {}, 'other')) as { refused?: string };
  return { error: answer.refused ?? null, ms: Date.now() - started };
});

ledgerAction('noop', async () => 'noop');

/** The call back, its refusal answered as a value (a rejection across RPC is reported as unhandled by the test pool). */
registerAction('other', 'callBack', {
  validator: type({ '[string]': 'unknown' }),
  handler: (async (_db: Db, _args: unknown, ctx: Ctx) => {
    try {
      return { answered: await batchedRpc(ctx.env.TEST_ATOMIC_DO as never, ctx.instanceKey, 'noop', {}, 'ledger') };
    } catch (error) {
      return { refused: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }) as never,
});

registerAction('other', 'echo', {
  validator: type({ '[string]': 'unknown' }),
  handler: (async () => 'echo') as never,
});

ledgerAction('callOtherPlainly', async (_db, _args, ctx) => batchedRpc(ctx.env.TEST_ATOMIC_OTHER_DO as never, ctx.instanceKey, 'echo', {}, 'other'));

abstract class GeneratedLike extends SqliteDurableObject<Record<string, unknown>> {
  protected abstract database: string;

  /** What the plugin generates: see the top of this file. */
  async rpc(method: string, args: unknown, rpcContext?: RpcOptions): Promise<unknown> {
    await this.ensureMigrations();
    const entry = getAction(this.database, method);
    if (!entry) throw new Error(`[db] Unknown action "${method}" for db "${this.database}" (was it imported?)`);
    const validated = entry.validator(args);
    if (validated instanceof type.errors) throw new Error(`[db] Invalid args for "${method}": ${validated.summary}`);
    const ctx = {
      env: this.env,
      dbName: this.database,
      dbBindingNames: { ledger: 'TEST_ATOMIC_DO', other: 'TEST_ATOMIC_OTHER_DO' },
      dbTransports: {},
      instanceKey: rpcContext?.instanceKey ?? 'global',
    };
    return runWithDoContext(
      { db: this.db, ctx, dbName: this.database, instanceKey: ctx.instanceKey, tenantId: this.tenantOf(ctx.instanceKey), via: rpcContext?.via },
      async () => this.runAction(ctx, async () => entry.handler(this.db, validated, ctx)),
    );
  }

  /** `rpc()`, its error as a string (a rejection across RPC is reported as unhandled by the test pool). */
  async call(method: string, args: unknown, instanceKey = 'acme'): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await this.rpc(method, args, { instanceKey }) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}

export class TestAtomicDO extends GeneratedLike {
  migrations = MIGRATIONS;
  schema = { vouchers, lines, balances };
  protected database = 'ledger';
  protected databaseName = 'ledger';
  private starting: Promise<unknown> | null = null;

  /**
   * An object's first migration run, made to wait on I/O as a long one does
   * (a deploy's new migration): the calls that arrive meanwhile wait on the
   * same run, and go on together once it is done.
   */
  protected async ensureMigrations(): Promise<void> {
    await (this.starting ??= sleep(20));
    return super.ensureMigrations();
  }
  private delivered: unknown[] = [];
  protected outboxSink = {
    deliver: async (envelopes: readonly OutboxEnvelope[]) => {
      this.delivered.push(...envelopes.map((envelope) => envelope.message));
    },
  };

  /** What the object holds: its rows, and every message recorded (still in the outbox or delivered). */
  async state(): Promise<{ vouchers: unknown[]; lines: string[]; balance: number | null; messages: unknown[] }> {
    await this.ensureMigrations();
    const outbox = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__outbox'`).toArray().length > 0;
    const waiting = outbox ? this.sql.exec('SELECT message FROM __outbox ORDER BY id').toArray().map((row) => JSON.parse(row.message as string)) : [];
    return {
      vouchers: this.sql.exec('SELECT series, number FROM vouchers ORDER BY id').toArray(),
      lines: this.sql.exec('SELECT note FROM lines ORDER BY id').toArray().map((row) => row.note as string),
      balance: (this.sql.exec('SELECT amount FROM balances WHERE id = 1').toArray()[0]?.amount as number | undefined) ?? null,
      messages: [...this.delivered, ...waiting],
    };
  }
}

export class TestAtomicOtherDO extends GeneratedLike {
  migrations: Migrations = {};
  protected database = 'other';
  protected databaseName = 'other';
}
