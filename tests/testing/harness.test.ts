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
const { action } = defineDatabase({ schema });

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

    // Booleans bind as 0/1 and read back as 0/1 — exactly like production
    // (durable-db's plugin chain converts dates, not booleans; apps coerce with
    // `!!row.col`). The harness faithfully reproduces that.
    const saved = await t.run(upsertSettings, { autoBook: true });
    expect(saved.autoBook).toBe(1);

    const read = await t.run(getSettings, {});
    expect(read?.autoBook).toBe(1);
  });

  it('upserts on the conflict key rather than duplicating', async () => {
    const t = await createTestDatabase({ schema });
    cleanup = t.destroy;

    await t.run(upsertSettings, { autoBook: false });
    await t.run(upsertSettings, { autoBook: true });

    const rows = await t.db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].autoBook).toBe(1);
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
