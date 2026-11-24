import { describe, it, expect, afterEach } from 'vitest';
import { table, text, integer } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createTestDatabase } from '../../src/testing';

// A schema shaped like a real app's: a per-tenant settings singleton plus a
// shipments table with a timestamp, a boolean, and an upsert-by-business-key.
const settings = table('settings', {
  id: text().primaryKey(),
  autoBook: integer({ mode: 'boolean' }).notNull().default(false),
  updatedAt: integer({ mode: 'timestamp' }).notNull(),
});

const shipments = table('shipments', {
  id: text().primaryKey(),
  orderId: text().notNull(),
  status: text().notNull().default('pending'),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
  bookedAt: integer({ mode: 'timestamp' }),
});

const schema = { settings, shipments };
const { action, destroyDatabase } = defineDatabase({ schema });

const upsertSettings = action({
  args: { autoBook: 'boolean' },
  handler: async (db, args) =>
    db
      .insertInto('settings')
      .values({ id: 'settings', autoBook: args.autoBook, updatedAt: new Date() })
      .onConflict((oc) => oc.column('id').doUpdateSet({ autoBook: args.autoBook, updatedAt: new Date() }))
      .returningAll()
      .executeTakeFirstOrThrow(),
});

const getSettings = action({
  args: {},
  handler: async (db) =>
    db.selectFrom('settings').selectAll().where('id', '=', 'settings').executeTakeFirst().then((r) => r ?? null),
});

const upsertShipment = action({
  args: { orderId: 'string', status: 'string' },
  handler: async (db, args) => {
    const now = new Date();
    const existing = await db
      .selectFrom('shipments')
      .select(['id'])
      .where('orderId', '=', args.orderId)
      .executeTakeFirst();
    const booked = args.status === 'booked';
    const row = { orderId: args.orderId, status: args.status, bookedAt: booked ? now : null };
    if (existing) {
      return db.updateTable('shipments').set(row).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
    }
    return db
      .insertInto('shipments')
      .values({ id: crypto.randomUUID(), createdAt: now, ...row })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
});

const listShipments = action({
  args: {},
  handler: async (db) => db.selectFrom('shipments').selectAll().orderBy('createdAt', 'desc').execute(),
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('createTestDatabase', () => {
  it('creates tables from the schema and runs an insert action', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;

    // Booleans bind as 0/1 on disk but the plugin chain reads them back as
    // real booleans — exactly like production.
    const saved = await t.run(upsertSettings, { autoBook: true });
    expect(saved.autoBook).toBe(true);

    const read = await t.run(getSettings, {});
    expect(read?.autoBook).toBe(true);
  });

  it('upserts on the conflict key rather than duplicating', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;

    await t.run(upsertSettings, { autoBook: false });
    await t.run(upsertSettings, { autoBook: true });

    const rows = await t.db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].autoBook).toBe(true);
  });

  it('handles update-vs-insert by business key and stamps a Date column', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;

    const pending = await t.run(upsertShipment, { orderId: 'gid://shopify/Order/1', status: 'pending' });
    expect(pending.bookedAt).toBeNull();

    const booked = await t.run(upsertShipment, { orderId: 'gid://shopify/Order/1', status: 'booked' });
    expect(booked.bookedAt).toBeInstanceOf(Date); // timestamp column round-trips to a Date
    expect(booked.id).toBe(pending.id); // updated the same row, did not insert a second

    const all = await t.run(listShipments, {});
    expect(all).toHaveLength(1);
  });

  it('validates args with the action arktype schema', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;
    // @ts-expect-error — wrong type on purpose
    await expect(t.run(upsertSettings, { autoBook: 'nope' })).rejects.toThrow(/Invalid args/);
  });

  it('rejects a non-action function', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;
    await expect(t.run((async () => 1) as any, {})).rejects.toThrow(/not a durable-db action/);
  });

  it('isolates state between databases', async () => {
    const a = await createTestDatabase({ schema });
    await a.run(upsertShipment, { orderId: 'x', status: 'pending' });
    const b = await createTestDatabase({ schema });
    expect(await b.run(listShipments, {})).toHaveLength(0);
    a.destroy();
    b.destroy();
  });
});

// Code under test (a page, a procedure, a job) calls actions directly; there
// is no build transform in Node, so the action must run against the test
// database the test created for its tables.
const notes = table('notes', { id: text().primaryKey(), body: text().notNull() });
const notesDb = defineDatabase({ schema: { notes } });

const addNote = notesDb.action({
  args: { id: 'string', body: 'string', 'tag?': 'string' },
  handler: async (db, args) =>
    db.insertInto('notes').values({ id: args.id, body: args.tag ? `${args.tag}: ${args.body}` : args.body })
      .returningAll().executeTakeFirstOrThrow(),
});

const countNotes = notesDb.action({
  args: {},
  handler: async (db) => (await db.selectFrom('notes').select('id').execute()).length,
});

// An action calling another action of its database, as handlers do.
const addTwoNotes = notesDb.action({
  args: { prefix: 'string' },
  handler: async (_db, args) => {
    await addNote({ id: `${args.prefix}-1`, body: 'one' });
    await addNote({ id: `${args.prefix}-2`, body: 'two' });
    return countNotes({});
  },
});

/** Stand-in for app code (a loader, an RPC procedure) that calls actions. */
async function createNoteFromForm(form: { id: string; body: string; tag?: string }) {
  const note = await addNote({ id: form.id, body: form.body, tag: form.tag });
  return { note, total: await countNotes({}) };
}

describe('direct action calls under test', () => {
  it('runs an action called by code under test against the test database for its tables', async () => {
    const t = await createTestDatabase({ schema: { notes } });
    cleanup = t.destroy;

    // The optional `tag` is passed as undefined, as app code naturally does.
    const result = await createNoteFromForm({ id: 'n1', body: 'hello', tag: undefined });
    expect(result.note).toEqual({ id: 'n1', body: 'hello' });
    expect(result.total).toBe(1);
    expect(await t.db.selectFrom('notes').selectAll().execute()).toEqual([{ id: 'n1', body: 'hello' }]);
  });

  it('validates args like production on a direct call', async () => {
    const t = await createTestDatabase({ schema: { notes } });
    cleanup = t.destroy;
    await expect(addNote({ id: 'n1', body: 3 as never })).rejects.toThrow(/Invalid args/);
  });

  it('runs actions that call other actions of the same database', async () => {
    const t = await createTestDatabase({ schema: { notes } });
    cleanup = t.destroy;
    expect(await addTwoNotes({ prefix: 'x' })).toBe(2);
  });

  it('matches by tables: a test database with more tables also serves the action', async () => {
    const t = await createTestDatabase({ schema: { ...schema, notes } });
    cleanup = t.destroy;
    await addNote({ id: 'n1', body: 'a' });
    expect(await t.run(countNotes, {})).toBe(1);
  });

  it('uses the newest live test database and stops routing to a destroyed one', async () => {
    const older = await createTestDatabase({ schema: { notes } });
    const newer = await createTestDatabase({ schema: { notes } });
    await addNote({ id: 'n1', body: 'a' });
    expect(await newer.run(countNotes, {})).toBe(1);
    expect(await older.run(countNotes, {})).toBe(0);

    newer.destroy();
    await addNote({ id: 'n2', body: 'b' });
    expect(await older.run(countNotes, {})).toBe(1);

    older.destroy();
    await expect(addNote({ id: 'n3', body: 'c' })).rejects.toThrow(
      /action\(\) call sites are transformed by the build; in tests, create the database with createTestDatabase\(\{ schema: \{ notes \} \}\)/
    );
  });

  it('does not route to a test database created for other tables', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;
    await expect(countNotes({})).rejects.toThrow(/called without transformation/);
  });

  it('destroyDatabase() empties the test database', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;
    await t.run(upsertShipment, { orderId: 'o1', status: 'pending' });
    await destroyDatabase();
    expect(await t.run(listShipments, {})).toHaveLength(0);
  });
});

describe('createTestDatabase: the outbox', () => {
  const notes = table('notes', { id: text().primaryKey(), text: text().notNull() });
  const { action: noteAction } = defineDatabase({ schema: { notes } });
  const addNote = noteAction({
    args: { id: 'string', text: 'string', 'fail?': 'boolean' },
    handler: async (db, args, ctx) => {
      await db.insertInto('notes').values({ id: args.id, text: args.text }).execute();
      ctx.outbox.push({ job: 'note-added', args: { id: args.id } });
      if (args.fail) throw new Error('failed after the push');
      return args.id;
    },
  });

  it("keeps a successful action's messages and hands them to the deliver option", async () => {
    const deliveries: unknown[] = [];
    const t = await createTestDatabase({ schema: { notes }, tenantId: 'acme', outbox: (envelopes) => void deliveries.push(...envelopes) });
    await t.run(addNote, { id: 'n1', text: 'hello' });
    expect(t.outbox).toEqual([
      {
        message: { job: 'note-added', args: { id: 'n1' } },
        database: 'test',
        instanceKey: 'acme',
        tenantId: 'acme',
        recordedAt: expect.any(Number),
        attempts: 0,
      },
    ]);
    expect(deliveries).toEqual(t.outbox);
    // Called directly, as app code does, the action runs here too.
    await addNote({ id: 'n2', text: 'again' });
    expect(t.outbox.map((e) => (e.message as { args: { id: string } }).args.id)).toEqual(['n1', 'n2']);
    t.destroy();
  });

  it("names the database and its instance as the options say: a tenant named 'global' is a tenant", async () => {
    const t = await createTestDatabase({ schema: { notes }, tenantId: 'global', database: 'notes' });
    await t.run(addNote, { id: 'n1', text: 'hello' });
    expect(t.outbox[0]).toMatchObject({ database: 'notes', instanceKey: 'global', tenantId: 'global' });
    t.destroy();

    const shared = await createTestDatabase({ schema: { notes }, tenantId: 'acme', database: 'notes', instance: 'global' });
    await shared.run(addNote, { id: 'n2', text: 'for everyone' });
    expect(shared.outbox[0]).toMatchObject({ database: 'notes', instanceKey: 'global', tenantId: null });
    shared.destroy();
  });

  it("takes a global database's instance from its defineDatabase()", async () => {
    const shared = table('shared_notes', { id: text().primaryKey() });
    const { action: sharedAction } = defineDatabase({ schema: { shared }, instance: 'global' });
    const share = sharedAction({
      args: { id: 'string' },
      handler: async (db, args, ctx) => {
        await db.insertInto('shared_notes').values({ id: args.id }).execute();
        ctx.outbox.push({ shared: args.id, key: ctx.instanceKey });
      },
    });
    const t = await createTestDatabase({ schema: { shared }, tenantId: 'acme' });
    await t.run(share, { id: 's1' });
    expect(t.outbox[0]).toMatchObject({ message: { shared: 's1', key: 'global' }, instanceKey: 'global', tenantId: null });
    t.destroy();
  });

  it('records nothing for an action that throws', async () => {
    const t = await createTestDatabase({ schema: { notes } });
    await expect(t.run(addNote, { id: 'n1', text: 'x', fail: true })).rejects.toThrow('failed after the push');
    expect(t.outbox).toEqual([]);
    t.destroy();
  });
});

// An action is one transaction of its object in production (runAction, the
// workers tests): the test database runs it the same way, so a test that
// passes here does not pass on a guarantee production lacks.
describe('createTestDatabase: an action is one transaction', () => {
  const vouchers = table('vouchers', { id: integer().primaryKey({ autoIncrement: true }), number: integer().notNull().unique() });
  const lines = table('lines', { id: integer().primaryKey({ autoIncrement: true }), note: text().notNull() });
  const balances = table('balances', { id: integer().primaryKey(), amount: integer().notNull() });
  const ledger = { vouchers, lines, balances };
  const { action: ledgerAction } = defineDatabase({ schema: ledger });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const post = ledgerAction({
    args: { number: 'number', again: 'boolean' },
    handler: async (db, args) => {
      await db.insertInto('vouchers').values({ number: args.number }).execute();
      await db.insertInto('lines').values({ note: `debit ${args.number}` }).execute();
      await db.insertInto('lines').values({ note: `credit ${args.number}` }).execute();
      if (args.again) await db.insertInto('vouchers').values({ number: args.number }).execute();
    },
  });
  const addToBalance = ledgerAction({
    args: { amount: 'number' },
    handler: async (db, args) => {
      const row = await db.selectFrom('balances').select('amount').where('id', '=', 1).executeTakeFirst();
      await sleep(2);
      const next = (row?.amount ?? 0) + args.amount;
      await db.insertInto('balances').values({ id: 1, amount: next }).onConflict((oc) => oc.column('id').doUpdateSet({ amount: next })).execute();
      return next;
    },
  });
  const failing = ledgerAction({
    args: {},
    handler: async (db): Promise<void> => {
      await db.insertInto('lines').values({ note: 'callee' }).execute();
      throw new Error('the callee failed');
    },
  });
  const callsFailing = ledgerAction({
    args: {},
    handler: async (db) => {
      await db.insertInto('lines').values({ note: 'caller' }).execute();
      await failing({}).catch(() => {});
      return 'went on';
    },
  });
  const withPart = ledgerAction({
    args: { fail: 'boolean' },
    handler: async (db, args, ctx) => {
      ctx.outbox.push('outer');
      await ctx
        .transaction(async () => {
          await db.insertInto('lines').values({ note: 'part' }).execute();
          ctx.outbox.push('part');
          if (args.fail) throw new Error('the part failed');
        })
        .catch(() => {});
      await db.insertInto('lines').values({ note: 'after' }).execute();
    },
  });
  const siblingParts = ledgerAction({
    args: {},
    handler: async (db, _args, ctx) => {
      const log: string[] = [];
      const first = ctx
        .transaction(async () => {
          log.push('first starts');
          await db.insertInto('lines').values({ note: 'first' }).execute();
          await sleep(10);
          throw new Error('first');
        })
        .catch(() => log.push('first rolled back'));
      const second = ctx.transaction(async () => {
        log.push('second starts');
        await db.insertInto('lines').values({ note: 'second' }).execute();
      });
      await Promise.all([first, second]);
      return log;
    },
  });
  const kyselyTransaction = ledgerAction({
    args: {},
    handler: async (db) => db.transaction().execute(async (trx) => trx.insertInto('lines').values({ note: 'kysely' }).execute()),
  });

  const notes = (t: { sqlite: { prepare(sql: string): { all(): unknown[] } } }) =>
    (t.sqlite.prepare('SELECT note FROM lines ORDER BY id').all() as Array<{ note: string }>).map((row) => row.note);

  it('keeps none of its writes when a statement fails part-way', async () => {
    const t = await createTestDatabase({ schema: ledger, outbox: async () => {} });
    await t.run(post, { number: 1, again: false });
    await expect(t.run(post, { number: 2, again: true })).rejects.toThrow(/UNIQUE constraint failed/);
    expect(notes(t)).toEqual(['debit 1', 'credit 1']);
    t.destroy();
  });

  it('runs the calls of a database one after the other, across an await', async () => {
    const t = await createTestDatabase({ schema: ledger });
    const sums = await Promise.all(Array.from({ length: 5 }, () => addToBalance({ amount: 10 })));
    expect(sums.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    t.destroy();
  });

  it('rolls back a part that fails on its own, its messages with it, and goes on', async () => {
    const t = await createTestDatabase({ schema: ledger, outbox: async () => {} });
    await t.run(withPart, { fail: true });
    expect(notes(t)).toEqual(['after']);
    expect(t.outbox.map((envelope) => envelope.message)).toEqual(['outer']);
    await t.run(withPart, { fail: false });
    expect(t.outbox.map((envelope) => envelope.message)).toEqual(['outer', 'outer', 'part']);
    t.destroy();
  });

  it('runs two parts started at once one after the other', async () => {
    const t = await createTestDatabase({ schema: ledger });
    expect(await t.run(siblingParts, {})).toEqual(['first starts', 'first rolled back', 'second starts']);
    expect(notes(t)).toEqual(['second']);
    t.destroy();
  });

  it('rolls back an action of the same database called from one when it throws', async () => {
    const t = await createTestDatabase({ schema: ledger });
    expect(await t.run(callsFailing, {})).toBe('went on');
    expect(notes(t)).toEqual(['caller']);
    t.destroy();
  });

  it("refuses Kysely's db.transaction(), naming ctx.transaction()", async () => {
    const t = await createTestDatabase({ schema: ledger });
    await expect(t.run(kyselyTransaction, {})).rejects.toThrow(/ctx\.transaction\(/);
    t.destroy();
  });

  it('refuses a call back into a database an action further out runs in', async () => {
    const audit = table('audit', { id: integer().primaryKey({ autoIncrement: true }), note: text().notNull() });
    const { action: auditAction } = defineDatabase({ schema: { audit } });
    const ping = ledgerAction({ args: {}, handler: async () => 'pong' });
    const logAndPing = auditAction({ args: {}, handler: async () => ping({}) });
    const callsAudit = ledgerAction({ args: {}, handler: async () => logAndPing({}) });
    const t = await createTestDatabase({ schema: ledger, database: 'ledger' });
    const a = await createTestDatabase({ schema: { audit }, database: 'audit' });
    await expect(t.run(callsAudit, {})).rejects.toThrow(
      /A call into ledger \(test\), which is waiting on this call: ledger \(test\) → audit \(test\) → ledger \(test\)/,
    );
    // Not a cycle: the other database, alone.
    expect(await logAndPing({}).catch((error: Error) => error.message)).toBe('pong');
    a.destroy();
    t.destroy();
  });

  describe('a query or a push that runs after its action ended', () => {
    const late: string[] = [];
    const afterwards = (what: () => Promise<unknown> | unknown) =>
      void (async () => {
        await sleep(5);
        try {
          await what();
          late.push('ran');
        } catch (error) {
          late.push((error as Error).message);
        }
      })();
    const settled = async () => {
      await sleep(20);
      return late.splice(0);
    };
    const refused = expect.stringMatching(/after its action ended/);

    it('is refused when the action did not await it', async () => {
      const notAwaited = ledgerAction({
        args: {},
        handler: async (db) => {
          await db.insertInto('lines').values({ note: 'awaited' }).execute();
          afterwards(() => db.insertInto('lines').values({ note: 'not awaited' }).execute());
        },
      });
      const t = await createTestDatabase({ schema: ledger });
      await t.run(notAwaited, {});
      expect(await settled()).toEqual([refused]);
      expect(notes(t)).toEqual(['awaited']);
      t.destroy();
    });

    it('is refused when Promise.all() gave up at another failure', async () => {
      const allFails = ledgerAction({
        args: {},
        handler: async (db): Promise<void> => {
          await Promise.all([
            Promise.reject(new Error('the first failed')),
            (async () => {
              await sleep(5);
              await db.insertInto('lines').values({ note: 'the second' }).execute().catch((error: Error) => late.push(error.message));
            })(),
          ]);
        },
      });
      const t = await createTestDatabase({ schema: ledger });
      await expect(t.run(allFails, {})).rejects.toThrow('the first failed');
      expect(await settled()).toEqual([refused]);
      expect(notes(t)).toEqual([]);
      t.destroy();
    });

    it('refuses a message pushed after the action returned, and a part started then', async () => {
      const pushAfterwards = ledgerAction({
        args: {},
        handler: async (_db, _args, ctx) => {
          afterwards(() => ctx.outbox.push('late'));
          afterwards(() => ctx.transaction(async () => 'late'));
        },
      });
      const t = await createTestDatabase({ schema: ledger, outbox: async () => {} });
      await t.run(pushAfterwards, {});
      expect(await settled()).toEqual([refused, refused]);
      expect(t.outbox).toEqual([]);
      t.destroy();
    });

    it("is refused after a part rolled back, not written into the action's transaction", async () => {
      const partNotAwaited = ledgerAction({
        args: {},
        handler: async (db, _args, ctx) => {
          await ctx
            .transaction(async () => {
              afterwards(() => db.insertInto('lines').values({ note: 'part, not awaited' }).execute());
              throw new Error('the part failed');
            })
            .catch(() => {});
          await sleep(15);
          await db.insertInto('lines').values({ note: 'after the part' }).execute();
        },
      });
      const t = await createTestDatabase({ schema: ledger });
      await t.run(partNotAwaited, {});
      expect(await settled()).toEqual([refused]);
      expect(notes(t)).toEqual(['after the part']);
      t.destroy();
    });
  });

  it('runs a handler with validated args: runHandler()', async () => {
    const t = await createTestDatabase({ schema: ledger, outbox: async () => {} });
    const value = await t.runHandler(async (db, args: { note: string }, ctx) => {
      await db.insertInto('lines').values({ note: args.note }).execute();
      ctx.outbox.push('handled');
      return ctx.instanceKey;
    }, { note: 'handled' });
    expect(value).toBe('test');
    expect(notes(t)).toEqual(['handled']);
    expect(t.outbox.map((envelope) => envelope.message)).toEqual(['handled']);
    await expect(t.runHandler(async (db) => {
      await db.insertInto('lines').values({ note: 'gone' }).execute();
      throw new Error('handler failed');
    }, {})).rejects.toThrow('handler failed');
    expect(notes(t)).toEqual(['handled']);
    t.destroy();
  });
});
