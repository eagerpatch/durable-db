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
    expect(t.outbox).toMatchObject([{ message: { job: 'note-added', args: { id: 'n1' } }, instanceKey: 'acme', tenantId: 'acme' }]);
    expect(deliveries).toEqual(t.outbox);
    // Called directly, as app code does, the action runs here too.
    await addNote({ id: 'n2', text: 'again' });
    expect(t.outbox.map((e) => (e.message as { args: { id: string } }).args.id)).toEqual(['n1', 'n2']);
    t.destroy();
  });

  it('records nothing for an action that throws', async () => {
    const t = await createTestDatabase({ schema: { notes } });
    await expect(t.run(addNote, { id: 'n1', text: 'x', fail: true })).rejects.toThrow('failed after the push');
    expect(t.outbox).toEqual([]);
    t.destroy();
  });
});
