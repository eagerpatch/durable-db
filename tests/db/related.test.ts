import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { table, text, integer } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createRelated, type AnySchema, type RelatedWhere } from '../../src';
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

describe('a relation under another name', () => {
  it('reads the same relation twice, each under the name .as() gave it', async () => {
    const rows = await t.db
      .selectFrom('customers')
      .select([
        'customers.id',
        related('customers', 'invoicesAsCustomer', { columns: ['number'], orderBy: { number: 'asc' } }).as('invoices'),
        related('customers', 'invoicesAsCustomer', { columns: ['number', 'issuedAt'], orderBy: { number: 'desc' }, limit: 1 }).as('latest'),
      ])
      .orderBy('customers.id')
      .execute();

    expect(rows).toEqual([
      { id: 'c1', invoices: [{ number: 1 }, { number: 2 }], latest: [{ number: 2, issuedAt: null }] },
      { id: 'c2', invoices: [{ number: 3 }], latest: [{ number: 3, issuedAt: null }] },
      { id: 'c3', invoices: [], latest: [] },
    ]);
  });

  it('renames inside with too, and gives dates and booleans as the table itself does', async () => {
    const rows = await t.db
      .selectFrom('customers')
      .select([
        related('customers', 'invoicesAsCustomer', {
          columns: ['id'],
          orderBy: { number: 'asc' },
          with: [
            related('invoices', 'referee', ['name', 'vip', 'createdAt']).as('referredBy'),
            related('invoices', 'invoiceLines', { columns: ['delivered', 'deliveredAt'], orderBy: { id: 'asc' }, limit: 1 }).as('first'),
          ],
        }).as('billed'),
      ])
      .where('customers.id', '=', 'c1')
      .execute();

    expect(rows).toEqual([
      {
        billed: [
          {
            id: 'i1',
            referredBy: { name: 'Firman HB', vip: false, createdAt: at('2026-02-03T04:05:06Z') },
            first: [{ delivered: true, deliveredAt: at('2026-05-02T10:00:00Z') }],
          },
          { id: 'i2', referredBy: null, first: [{ delivered: false, deliveredAt: null }] },
        ],
      },
    ]);
  });

  it('answers under exactly the name as written, whatever the columns are renamed to', async () => {
    // The columns of a row are camelCased on the way out; a name given here is not a column.
    const rows = await t.db
      .selectFrom('invoices')
      .select([
        'invoices.customerId',
        related('invoices', 'invoiceLines', {
          columns: ['invoiceId'],
          with: [related('invoiceLines', 'invoice', ['number']).as('of_invoice'), related('invoiceLines', 'invoice', ['id']).as("it's")],
        }).as('line_items'),
      ])
      .where('invoices.id', '=', 'i2')
      .execute();

    expect(rows).toEqual([{ customerId: 'c1', line_items: [{ invoiceId: 'i2', of_invoice: { number: 2 }, "it's": { id: 'i2' } }] }]);
  });

  it('is a new expression: the one it is called on keeps its name', () => {
    const lines = related('invoices', 'invoiceLines', ['id']);
    const renamed = lines.as('rows');
    expect([lines.table, lines.alias]).toEqual(['invoices', 'invoiceLines']);
    expect([renamed.table, renamed.alias]).toEqual(['invoices', 'rows']);
  });

  it('reads the relations of a returned row under their names too', async () => {
    const row = await t.db
      .updateTable('invoices')
      .set({ number: 30 })
      .where('id', '=', 'i3')
      .returning(['invoices.number', related('invoices', 'customer', ['name', 'vip']).as('billedTo')])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ number: 30, billedTo: { name: 'Firman HB', vip: false } });
  });
});

describe('createRelated()', () => {
  it('is the related() of a schema, with no database defined on it', async () => {
    const own = createRelated(schema);
    const rows = await t.db
      .selectFrom('invoices')
      .select(['invoices.id', own('invoices', 'customer', ['name', 'createdAt']), own('invoices', 'invoiceLines', { columns: ['description'], orderBy: { id: 'desc' }, limit: 1 })])
      .where('invoices.id', '=', 'i1')
      .execute();

    expect(rows).toEqual([{ id: 'i1', customer: { name: 'Bolaget AB', createdAt: at('2026-01-02T03:04:05Z') }, invoiceLines: [{ description: 'Setup' }] }]);
  });

  it('builds what the related() of a database on the same schema takes in with', async () => {
    const own = createRelated(schema);
    const rows = await t.db
      .selectFrom('invoiceLines')
      .select([related('invoiceLines', 'invoice', { columns: ['number'], with: [own('invoices', 'customer', ['name'])] })])
      .where('invoiceLines.id', '=', 'l4')
      .execute();

    expect(rows).toEqual([{ invoice: { number: 2, customer: { name: 'Bolaget AB' } } }]);
  });

  it('takes names that are known only when it runs, and checks them then', async () => {
    // A library that is handed a schema: its tables and relations are strings to it.
    const loose = createRelated(schema as AnySchema);
    const [tableName, relationName]: string[] = ['customers', 'invoicesAsCustomer'];
    const expression = loose(tableName!, relationName!, {
      columns: ['number'],
      orderBy: { number: 'desc' },
      with: [loose('invoices', 'invoiceLines', ['description']).as('lines')],
    }).as('invoices');

    const rows = await t.db.selectFrom('customers').select(['customers.id', expression]).where('customers.id', '=', 'c1').execute();
    expect(rows).toEqual([
      {
        id: 'c1',
        invoices: [
          { number: 2, lines: [{ description: 'Licence' }] },
          { number: 1, lines: [{ description: 'Hours' }, { description: 'Travel' }, { description: 'Setup' }] },
        ],
      },
    ]);

    expect(() => loose('customers', 'orders', ['id'])).toThrow(/"customers" has no relation "orders"\. Its relations: invoicesAsCustomer, invoicesAsReferee\./);
    expect(() => loose('invoices', 'customer', ['nope'])).toThrow(/the column "nope" is not a column of "customers"/);
  });
});

describe("a relation's where", () => {
  const lines = (where: RelatedWhere<typeof schema, 'invoiceLines'>) =>
    t.db
      .selectFrom('invoices')
      .select(['invoices.id', related('invoices', 'invoiceLines', { columns: ['id'], orderBy: { id: 'asc' }, where })])
      .orderBy('invoices.id')
      .execute();

  it('reads the rows of a relation that meet a condition, for each row', async () => {
    const rows = await t.db
      .selectFrom('invoices')
      .select(['invoices.id', related('invoices', 'invoiceLines', { columns: ['description'], where: (eb) => eb('quantity', '>', 1) })])
      .orderBy('invoices.id')
      .execute();

    expect(rows).toEqual([
      { id: 'i1', invoiceLines: [{ description: 'Hours' }, { description: 'Setup' }] },
      { id: 'i2', invoiceLines: [{ description: 'Licence' }] },
      { id: 'i3', invoiceLines: [] },
    ]);
  });

  it('takes a column alone or after its table, and what Kysely builds of them', async () => {
    expect(await lines((eb) => eb('invoiceLines.quantity', '>', 1))).toEqual([
      { id: 'i1', invoiceLines: [{ id: 'l1' }, { id: 'l3' }] },
      { id: 'i2', invoiceLines: [{ id: 'l4' }] },
      { id: 'i3', invoiceLines: [] },
    ]);
    expect((await lines((eb) => eb.or([eb('description', '=', 'Travel'), eb('quantity', '>=', 10)])))[0]).toEqual({
      id: 'i1',
      invoiceLines: [{ id: 'l1' }, { id: 'l2' }],
    });
    expect((await lines((eb) => eb('description', 'in', ['Setup', 'Licence'])))[0]).toEqual({ id: 'i1', invoiceLines: [{ id: 'l3' }] });
  });

  it('compares booleans and dates as the table holds them', async () => {
    expect((await lines((eb) => eb('delivered', '=', true)))[0]).toEqual({ id: 'i1', invoiceLines: [{ id: 'l1' }] });
    expect((await lines((eb) => eb('delivered', '=', false)))[0]).toEqual({ id: 'i1', invoiceLines: [{ id: 'l2' }, { id: 'l3' }] });
    expect((await lines((eb) => eb('deliveredAt', '>', at('2026-05-01T00:00:00Z'))))[0]).toEqual({ id: 'i1', invoiceLines: [{ id: 'l1' }] });
    expect((await lines((eb) => eb('deliveredAt', '>', at('2026-06-01T00:00:00Z'))))[0]).toEqual({ id: 'i1', invoiceLines: [] });
    expect((await lines((eb) => eb('deliveredAt', 'is', null)))[0]).toEqual({ id: 'i1', invoiceLines: [{ id: 'l2' }, { id: 'l3' }] });
  });

  it('filters before the order and the limit cut', async () => {
    const rows = await t.db
      .selectFrom('invoices')
      .select([
        'invoices.id',
        related('invoices', 'invoiceLines', { columns: ['description'], where: (eb) => eb('delivered', '=', false), orderBy: { quantity: 'desc' }, limit: 1 }),
      ])
      .orderBy('invoices.id')
      .execute();

    expect(rows).toEqual([
      { id: 'i1', invoiceLines: [{ description: 'Setup' }] },
      { id: 'i2', invoiceLines: [{ description: 'Licence' }] },
      { id: 'i3', invoiceLines: [] },
    ]);
  });

  it('filters a relation of the related rows, and the same relation twice under two names', async () => {
    const rows = await t.db
      .selectFrom('customers')
      .select([
        'customers.id',
        related('customers', 'invoicesAsCustomer', {
          columns: ['number'],
          orderBy: { number: 'asc' },
          where: (eb) => eb('number', '<', 3),
          with: [
            related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('delivered', '=', true) }).as('delivered'),
            related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('delivered', '=', false), orderBy: { id: 'desc' } }).as('open'),
          ],
        }),
      ])
      .orderBy('customers.id')
      .execute();

    expect(rows).toEqual([
      {
        id: 'c1',
        invoicesAsCustomer: [
          { number: 1, delivered: [{ id: 'l1' }], open: [{ id: 'l3' }, { id: 'l2' }] },
          { number: 2, delivered: [], open: [{ id: 'l4' }] },
        ],
      },
      // Its one invoice is number 3.
      { id: 'c2', invoicesAsCustomer: [] },
      { id: 'c3', invoicesAsCustomer: [] },
    ]);
  });

  it('reads another table in a subquery, which names the related row after its table', async () => {
    const rows = await t.db
      .selectFrom('customers')
      .select([
        'customers.id',
        related('customers', 'invoicesAsCustomer', {
          columns: ['id'],
          where: (eb) =>
            eb.exists(eb.selectFrom('invoiceLines').select('invoiceLines.id').whereRef('invoiceLines.invoiceId', '=', 'invoices.id').where('invoiceLines.quantity', '>', 5)),
        }),
      ])
      .orderBy('customers.id')
      .execute();

    // i1 has a line of 10; i2's one line is 5, i3 has none.
    expect(rows).toEqual([
      { id: 'c1', invoicesAsCustomer: [{ id: 'i1' }] },
      { id: 'c2', invoicesAsCustomer: [] },
      { id: 'c3', invoicesAsCustomer: [] },
    ]);
  });

  it('filters the rows of a table that references itself, not the row they hang on', async () => {
    const loose = related as any;
    const rows = await t.db
      .selectFrom('categories')
      .select(['categories.id', loose('categories', 'categories', { columns: ['name'], where: (eb: any) => eb('categories.name', '=', 'Leaf') })])
      .orderBy('categories.id')
      .execute();

    expect(rows).toEqual([
      { id: 'k1', categories: [{ name: 'Leaf' }] },
      { id: 'k2', categories: [] },
      { id: 'k3', categories: [] },
    ]);

    // A subquery that reads the table itself keeps the table's name for its own rows.
    const withSiblings = await t.db
      .selectFrom('categories')
      .select([
        'categories.id',
        loose('categories', 'categories', {
          columns: ['name'],
          orderBy: { name: 'asc' },
          where: (eb: any) => eb.exists(eb.selectFrom('categories').select('categories.id').where('categories.name', '=', 'Root')),
        }),
      ])
      .where('categories.id', '=', 'k1')
      .execute();
    expect(withSiblings).toEqual([{ id: 'k1', categories: [{ name: 'Leaf' }, { name: 'Other leaf' }] }]);
  });

  it('filters the relations of a row an action answers, and of one createRelated() reads', async () => {
    const open = action({
      args: { 'min?': 'number' },
      handler: async (db, args) =>
        db
          .selectFrom('invoices')
          .select(['invoices.id', related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('quantity', '>=', args.min ?? 0) })])
          .where('invoices.id', '=', 'i1')
          .executeTakeFirstOrThrow(),
    });
    expect(await t.run(open, { min: 2 })).toEqual({ id: 'i1', invoiceLines: [{ id: 'l1' }, { id: 'l3' }] });
    expect(await t.run(open, {})).toEqual({ id: 'i1', invoiceLines: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] });

    const loose = createRelated(schema as AnySchema);
    const row = await t.db
      .selectFrom('invoices')
      .select(['invoices.id', loose('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('quantity', '=', 1) })])
      .where('invoices.id', '=', 'i1')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id: 'i1', invoiceLines: [{ id: 'l2' }] });
  });
});

describe('the query related() writes', () => {
  it('binds the values of a where, and names its columns after the rows it reads', () => {
    const { sql, parameters } = t.db
      .selectFrom('invoices')
      .select([
        related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('quantity', '>', 1) }).as('some'),
        related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('invoiceLines.description', '=', 'Hours'), limit: 2 }).as('few'),
      ])
      .compile();

    expect(parameters).toEqual([1, 'Hours']);
    expect(sql.replace(/\s+/g, ' ')).toBe(
      "select (select json_group_array(json_object('id', `_r1`.`id`)) from `invoice_lines` as `_r1` " +
        'where `_r1`.`invoice_id` = `invoices`.`id` and (`_r1`.`quantity` > ?)) as `some`, ' +
        "(select json_group_array(json_object('id', `_r1`.`id`)) from " +
        '(select * from `invoice_lines` as `_s1` where `_s1`.`invoice_id` = `invoices`.`id` and (`_s1`.`description` = ?) limit 2) as `_r1`) as `few` ' +
        'from `invoices`',
    );
  });

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
    [
      'a where where one row is read',
      () => loose('invoices', 'customer', { columns: ['id'], where: (eb: any) => eb('vip', '=', true) }),
      /leads to one row: orderBy, limit and where are for a relation that leads to many/,
    ],
    ['a where that is no function', () => loose('invoices', 'invoiceLines', { columns: ['id'], where: { quantity: 1 } }), /where is a function that answers a condition — where: \(eb\) => eb\('<column>', '=', value\)/],
    ['a where that answers no condition', () => loose('invoices', 'invoiceLines', { columns: ['id'], where: () => true }), /where answers a condition/],
    [
      'a where on a column of another table',
      () => loose('invoices', 'invoiceLines', { columns: ['id'], where: (eb: any) => eb('invoices.number', '>', 1) }),
      /related\('invoices', 'invoiceLines'\): where is a condition on "invoiceLines", and "invoices\.number" is of another table — read that one in a subquery/,
    ],
    ['a relation of another table in with', () => loose('invoices', 'customer', { columns: ['id'], with: [related('invoices', 'customer', ['id'])] }), /with takes relations of "customers", and "customer" is one of "invoices"/],
    ['what is no relation in with', () => loose('invoices', 'customer', { columns: ['id'], with: ['invoicesAsCustomer'] }), /with is a list of relations/],
    [
      'the same relation twice',
      () => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [related('invoices', 'referee', ['id']), related('invoices', 'referee', ['name'])] }),
      /"referee" is there twice/,
    ],
    [
      'two relations under one name',
      () => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [related('invoices', 'customer', ['id']).as('who'), related('invoices', 'referee', ['id']).as('who')] }),
      /"who" is there twice — as a column and a relation, or two relations under one name/,
    ],
    [
      'a relation under the name of a column that is read',
      () => loose('customers', 'invoicesAsCustomer', { columns: ['number'], with: [related('invoices', 'referee', ['id']).as('number')] }),
      /"number" is there twice/,
    ],
    ['a name that is none', () => related('invoices', 'customer', ['id']).as(''), /related\('invoices', 'customer'\)\.as\(\) takes the name to answer it under/],
  ])('%s', (_what, build, message) => {
    expect(build).toThrow(message);
  });

  it('a relation of another database', () => {
    const other = defineDatabase({ schema: { customers, invoices } });
    expect(() => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [other.related('invoices', 'customer', ['id'])] })).toThrow(/of another database/);
    const copy = createRelated({ ...schema });
    expect(() => loose('customers', 'invoicesAsCustomer', { columns: ['id'], with: [copy('invoices', 'customer', ['id'])] })).toThrow(/of another database/);
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
