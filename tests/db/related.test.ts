import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { table, text, integer } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createTestDatabase, type TestDatabase } from '../../src/testing';

const customers = table('customers', {
  id: text().primaryKey(),
  name: text().notNull(),
  vip: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});

const invoices = table('invoices', {
  id: text().primaryKey(),
  number: integer().notNull(),
  customerId: text()
    .notNull()
    .references(() => customers.id),
  refereeId: text().references(() => customers.id),
  issuedAt: integer({ mode: 'timestamp' }),
});

// The schema key (invoiceLines) is not what its table is called.
const invoiceLines = table('invoice_lines', {
  id: text().primaryKey(),
  invoiceId: text()
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  quantity: integer().notNull(),
  delivered: integer({ mode: 'boolean' }).notNull().default(false),
  deliveredAt: integer({ mode: 'timestamp' }),
});

// A table that references itself: the callback is annotated, as TypeScript asks.
const categories = table('categories', {
  id: text().primaryKey(),
  name: text().notNull(),
  parentId: text().references((): AnySQLiteColumn => categories.id),
});

const schema = { customers, invoices, invoiceLines, categories };
const { action, related, relations } = defineDatabase({ schema });

const at = (iso: string) => new Date(iso);

let t: TestDatabase<any>;
beforeEach(async () => {
  t = await createTestDatabase({ schema });
  await t.db
    .insertInto('customers')
    .values([
      { id: 'c1', name: 'Bolaget AB', vip: true, createdAt: at('2026-01-02T03:04:05Z') },
      { id: 'c2', name: 'Firman HB', vip: false, createdAt: at('2026-02-03T04:05:06Z') },
      { id: 'c3', name: 'Ingen', vip: false, createdAt: at('2026-03-04T05:06:07Z') },
    ])
    .execute();
  await t.db
    .insertInto('invoices')
    .values([
      { id: 'i1', number: 1, customerId: 'c1', refereeId: 'c2', issuedAt: at('2026-05-01T00:00:00Z') },
      { id: 'i2', number: 2, customerId: 'c1', refereeId: null, issuedAt: null },
      { id: 'i3', number: 3, customerId: 'c2', refereeId: null, issuedAt: null },
    ])
    .execute();
  await t.db
    .insertInto('invoiceLines')
    .values([
      { id: 'l1', invoiceId: 'i1', description: 'Hours', quantity: 10, delivered: true, deliveredAt: at('2026-05-02T10:00:00Z') },
      { id: 'l2', invoiceId: 'i1', description: 'Travel', quantity: 1, delivered: false, deliveredAt: null },
      { id: 'l3', invoiceId: 'i1', description: 'Setup', quantity: 2, delivered: false, deliveredAt: null },
      { id: 'l4', invoiceId: 'i2', description: 'Licence', quantity: 5, delivered: false, deliveredAt: null },
    ])
    .execute();
  await t.db
    .insertInto('categories')
    .values([
      { id: 'k1', name: 'Root', parentId: null },
      { id: 'k2', name: 'Leaf', parentId: 'k1' },
      { id: 'k3', name: 'Other leaf', parentId: 'k1' },
    ])
    .execute();
});
afterEach(() => t.destroy());

describe('the relations of a schema', () => {
  it('are its foreign keys, named in both directions', () => {
    expect(relations.invoices!.customer).toEqual({
      kind: 'one',
      name: 'customer',
      table: 'invoices',
      target: 'customers',
      local: 'customerId',
      foreign: 'id',
      nullable: false,
    });
    expect(relations.invoices!.referee).toMatchObject({ kind: 'one', target: 'customers', nullable: true });
    expect(relations.invoices!.invoiceLines).toMatchObject({ kind: 'many', target: 'invoiceLines', local: 'id', foreign: 'invoiceId' });
    expect(relations.invoiceLines!.invoice).toMatchObject({ kind: 'one', target: 'invoices', nullable: false });
  });

  it('names the way back after the column when two lead to the same table', () => {
    expect(Object.keys(relations.customers!).sort()).toEqual(['invoicesAsCustomer', 'invoicesAsReferee']);
    expect(relations.customers!.invoicesAsReferee).toMatchObject({ kind: 'many', target: 'invoices', foreign: 'refereeId' });
  });

  it('holds a table that references itself', () => {
    expect(relations.categories!.parent).toMatchObject({ kind: 'one', target: 'categories', nullable: true });
    expect(relations.categories!.categories).toMatchObject({ kind: 'many', target: 'categories', foreign: 'parentId' });
  });
});

describe('related()', () => {
  const listInvoices = action({
    args: {},
    handler: async (db) =>
      db
        .selectFrom('invoices')
        .select(['invoices.id', 'invoices.number'])
        .select([
          related('invoices', 'customer', ['id', 'name', 'vip', 'createdAt']),
          related('invoices', 'referee', ['name']),
          related('invoices', 'invoiceLines', ['id', 'description', 'delivered', 'deliveredAt']),
        ])
        .orderBy('invoices.number')
        .execute(),
  });

  it('reads one row, no row and many rows next to the row itself', async () => {
    const rows = await t.run(listInvoices, {});

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: 'i1',
      number: 1,
      customer: { id: 'c1', name: 'Bolaget AB', vip: true, createdAt: at('2026-01-02T03:04:05Z') },
      referee: { name: 'Firman HB' },
      invoiceLines: [
        { id: 'l1', description: 'Hours', delivered: true, deliveredAt: at('2026-05-02T10:00:00Z') },
        { id: 'l2', description: 'Travel', delivered: false, deliveredAt: null },
        { id: 'l3', description: 'Setup', delivered: false, deliveredAt: null },
      ],
    });
    // A foreign key that is null leads nowhere; a row nothing points at has an empty list.
    expect(rows[1]!.referee).toBeNull();
    expect(rows[2]!.invoiceLines).toEqual([]);
  });

  it('gives dates and booleans as the table itself does', async () => {
    const [row] = await t.run(listInvoices, {});
    expect(row!.customer.createdAt).toBeInstanceOf(Date);
    expect(row!.customer.vip).toBe(true);
    expect(row!.invoiceLines[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(row!.invoiceLines[1]!.delivered).toBe(false);
  });

  it('orders and limits the rows of a relation, for each row', async () => {
    const rows = await t.db
      .selectFrom('invoices')
      .select([
        'invoices.id',
        related('invoices', 'invoiceLines', { columns: ['description'], orderBy: { quantity: 'desc' }, limit: 2 }),
      ])
      .orderBy('invoices.id')
      .execute();

    expect(rows).toEqual([
      { id: 'i1', invoiceLines: [{ description: 'Hours' }, { description: 'Setup' }] },
      { id: 'i2', invoiceLines: [{ description: 'Licence' }] },
      { id: 'i3', invoiceLines: [] },
    ]);
  });

  it('follows relations of the related rows, as deep as asked', async () => {
    const rows = await t.db
      .selectFrom('customers')
      .select([
        'customers.name',
        related('customers', 'invoicesAsCustomer', {
          columns: ['number', 'issuedAt'],
          orderBy: { number: 'asc' },
          with: [
            related('invoices', 'referee', ['name', 'vip']),
            related('invoices', 'invoiceLines', { columns: ['description', 'delivered', 'deliveredAt'], orderBy: { id: 'asc' }, limit: 1 }),
          ],
        }),
      ])
      .where('customers.id', '=', 'c1')
      .execute();

    expect(rows).toEqual([
      {
        name: 'Bolaget AB',
        invoicesAsCustomer: [
          {
            number: 1,
            issuedAt: at('2026-05-01T00:00:00Z'),
            referee: { name: 'Firman HB', vip: false },
            invoiceLines: [{ description: 'Hours', delivered: true, deliveredAt: at('2026-05-02T10:00:00Z') }],
          },
          { number: 2, issuedAt: null, referee: null, invoiceLines: [{ description: 'Licence', delivered: false, deliveredAt: null }] },
        ],
      },
    ]);
  });

  it('reads a relation alone, and one that only holds relations', async () => {
    const rows = await t.db
      .selectFrom('invoiceLines')
      .select([related('invoiceLines', 'invoice', { columns: [], with: [related('invoices', 'customer', ['name'])] })])
      .where('invoiceLines.id', '=', 'l4')
      .execute();

    expect(rows).toEqual([{ invoice: { customer: { name: 'Bolaget AB' } } }]);
  });

  it('follows a table that references itself, both ways', async () => {
    // Its callback is annotated, so its types name no target: the cast is the price (for now).
    const loose = related as any;
    const rows = await t.db
      .selectFrom('categories')
      .select(['categories.id', loose('categories', 'parent', ['name']), loose('categories', 'categories', { columns: ['name'], orderBy: { name: 'asc' } })])
      .orderBy('categories.id')
      .execute();

    expect(rows).toEqual([
      { id: 'k1', parent: null, categories: [{ name: 'Leaf' }, { name: 'Other leaf' }] },
      { id: 'k2', parent: { name: 'Root' }, categories: [] },
      { id: 'k3', parent: { name: 'Root' }, categories: [] },
    ]);
  });

  it('reads the relations of a row an insert or update returns', async () => {
    const row = await t.db
      .insertInto('invoices')
      .values({ id: 'i9', number: 9, customerId: 'c2', refereeId: 'c1', issuedAt: null })
      .returning(['invoices.id', related('invoices', 'customer', ['name']), related('invoices', 'invoiceLines', ['id'])])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ id: 'i9', customer: { name: 'Firman HB' }, invoiceLines: [] });
  });

  it('leaves a query without a relation as it was', async () => {
    const rows = await t.db.selectFrom('invoiceLines').select(['id', 'invoiceId', 'delivered']).where('id', '=', 'l1').execute();
    expect(rows).toEqual([{ id: 'l1', invoiceId: 'i1', delivered: true }]);
  });
});

describe('the query related() writes', () => {
  it('is one statement, with nothing bound: names and the limit are written out', () => {
    const { sql, parameters } = t.db
      .selectFrom('invoices')
      .select([
        'invoices.id',
        related('invoices', 'customer', ['name']),
        related('invoices', 'invoiceLines', { columns: ['invoiceId'], orderBy: { id: 'desc' }, limit: 3 }),
      ])
      .compile();

    expect(parameters).toEqual([]);
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'select `invoices`.`id`, ' +
        "(select json_object('name', `_r1`.`name`) from `customers` as `_r1` where `_r1`.`id` = `invoices`.`customer_id` limit 1) as `customer`, " +
        "(select json_group_array(json_object('invoiceId', `_r1`.`invoice_id`)) from " +
        '(select * from `invoice_lines` as `_s1` where `_s1`.`invoice_id` = `invoices`.`id` order by `_s1`.`id` desc limit 3) as `_r1`) as `invoice_lines` ' +
        'from `invoices`',
    );
  });
});

describe('what related() refuses', () => {
  const loose = related as any;

  it.each([
    ['a table the schema does not have', () => loose('orders', 'customer', ['id']), /"orders" is not a table of this database's schema/],
    ['a relation the table does not have', () => loose('invoices', 'lines', ['id']), /"invoices" has no relation "lines"\. Its relations: customer, referee, invoiceLines\./],
    ['a column the target does not have', () => loose('invoices', 'customer', ['nope']), /the column "nope" is not a column of "customers"\. Its columns: id, name, vip, createdAt\./],
    ['nothing to read', () => loose('invoices', 'customer', []), /reads nothing: name the columns to read/],
    ['no columns at all', () => loose('invoices', 'customer'), /takes the columns to read/],
    ['an order on a column the target does not have', () => loose('invoices', 'invoiceLines', { columns: ['id'], orderBy: { nope: 'asc' } }), /orderBy "nope" is not a column of "invoiceLines"/],
    ['a direction that is none', () => loose('invoices', 'invoiceLines', { columns: ['id'], orderBy: { id: 'up' } }), /orderBy\.id is 'asc' or 'desc'/],
    ['a limit that is no count', () => loose('invoices', 'invoiceLines', { columns: ['id'], limit: -1 }), /limit is a whole number, 0 or more/],
    ['an order or a limit where one row is read', () => loose('invoices', 'customer', { columns: ['id'], limit: 1 }), /leads to one row/],
    ['a relation of another table in with', () => loose('invoices', 'customer', { columns: ['id'], with: [related('invoices', 'customer', ['id'])] }), /with takes relations of "customers", and "customer" is one of "invoices"/],
    ['what is no relation in with', () => loose('invoices', 'customer', { columns: ['id'], with: ['invoicesAsCustomer'] }), /with is a list of relations/],
    [
      'the same relation twice',
      () => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [related('invoices', 'referee', ['id']), related('invoices', 'referee', ['name'])] }),
      /"referee" is there twice/,
    ],
  ])('%s', (_what, build, message) => {
    expect(build).toThrow(message);
  });

  it('a relation of another database', () => {
    const other = defineDatabase({ schema: { customers, invoices } });
    expect(() => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [other.related('invoices', 'customer', ['id'])] })).toThrow(/of another database/);
  });

  it('two relations that would share a name, saying which', () => {
    const owners = table('owners', { id: text().primaryKey() });
    const things = table('things', {
      id: text().primaryKey(),
      owner: text().references(() => owners.id),
      ownerId: text().references(() => owners.id),
    });
    const clashing = defineDatabase({ schema: { owners, things } });
    expect(() => (clashing.related as any)('things', 'owner', ['id'])).toThrow(/"things" has 2 relations that would be named "owner"/);
  });
});
