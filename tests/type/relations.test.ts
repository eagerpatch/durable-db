import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { integer, table, text } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createRelated, type AnyRelated, type RelatedExpression, type RelatedWhere } from '../../src/db/related';
import type { AnySchema, Relations } from '../../src/db/relations';

// What the types say of a schema's relations, and of a query that reads along
// them. These hold when `tsc -p tests/type/tsconfig.json` passes.

const customers = table('customers', {
  id: text().primaryKey(),
  name: text().notNull(),
  vip: integer({ mode: 'boolean' }).notNull().default(false),
});
const invoices = table('invoices', {
  id: text().primaryKey(),
  number: integer().notNull(),
  customerId: text().notNull().references(() => customers.id),
  refereeId: text().references(() => customers.id),
});
const invoiceLines = table('invoice_lines', {
  id: text().primaryKey(),
  invoiceId: text().notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  delivered: integer({ mode: 'boolean' }).notNull().default(false),
  deliveredAt: integer({ mode: 'timestamp' }),
});
const categories = table('categories', {
  id: text().primaryKey(),
  // A table that points at itself says so without its type: TypeScript cannot infer a circle.
  parentId: text().references((): AnySQLiteColumn => categories.id),
});
const schema = { customers, invoices, invoiceLines, categories };
type R = Relations<typeof schema>;

const { action, related, relations } = defineDatabase({ schema });

describe('Relations<Schema>', () => {
  it('names a foreign key from the table that holds it: a one, nullable as its column', () => {
    expectTypeOf<R['invoices']['customer']>().toEqualTypeOf<{ kind: 'one'; target: 'customers'; nullable: false }>();
    expectTypeOf<R['invoices']['referee']>().toEqualTypeOf<{ kind: 'one'; target: 'customers'; nullable: true }>();
    expectTypeOf<R['invoiceLines']['invoice']>().toEqualTypeOf<{ kind: 'one'; target: 'invoices'; nullable: false }>();
  });

  it('names it from the table it points at: a many, by the schema key', () => {
    expectTypeOf<R['invoices']['invoiceLines']>().toEqualTypeOf<{ kind: 'many'; target: 'invoiceLines' }>();
    expectTypeOf<keyof R['invoices']>().toEqualTypeOf<'customer' | 'referee' | 'invoiceLines'>();
  });

  it('tells two foreign keys to the same table apart', () => {
    expectTypeOf<keyof R['customers']>().toEqualTypeOf<'invoicesAsCustomer' | 'invoicesAsReferee'>();
    expectTypeOf<R['customers']['invoicesAsReferee']>().toEqualTypeOf<{ kind: 'many'; target: 'invoices' }>();
  });

  it('leaves out a reference whose target the types were not told', () => {
    expectTypeOf<keyof R['categories']>().toEqualTypeOf<never>();
    // The registry reads the foreign key itself, so it has both directions.
    expect(Object.keys(relations.categories ?? {}).sort()).toEqual(['categories', 'parent']);
  });
});

describe('related()', () => {
  it('is typed by the relation and the columns asked for', () => {
    expectTypeOf(related('invoices', 'customer', ['id', 'name'])).toEqualTypeOf<
      RelatedExpression<'invoices', 'customer', { id: string; name: string }>
    >();
    expectTypeOf(related('invoices', 'referee', ['name'])).toEqualTypeOf<RelatedExpression<'invoices', 'referee', { name: string } | null>>();
    expectTypeOf(related('customers', 'invoicesAsCustomer', ['number'])).toEqualTypeOf<
      RelatedExpression<'customers', 'invoicesAsCustomer', { number: number }[]>
    >();
  });

  it('types the rows of the query that selects it', () => {
    const listInvoices = action({
      args: {},
      handler: async (db) =>
        db
          .selectFrom('invoices')
          .select([
            'invoices.id',
            related('invoices', 'customer', ['id', 'vip']),
            related('invoices', 'referee', ['name']),
            related('invoices', 'invoiceLines', { columns: ['description', 'delivered', 'deliveredAt'], orderBy: { id: 'desc' }, limit: 2 }),
          ])
          .execute(),
    });
    expectTypeOf<Awaited<ReturnType<typeof listInvoices>>>().toEqualTypeOf<
      {
        id: string;
        customer: { id: string; vip: boolean };
        referee: { name: string } | null;
        invoiceLines: { description: string; delivered: boolean; deliveredAt: Date | null }[];
      }[]
    >();
  });

  it('nests what `with` reads under each row', () => {
    const lines = related('invoices', 'invoiceLines', ['description']);
    const nested = related('customers', 'invoicesAsCustomer', {
      columns: ['number'],
      with: [lines, related('invoices', 'referee', ['name'])],
    });
    expectTypeOf(nested).toEqualTypeOf<
      RelatedExpression<
        'customers',
        'invoicesAsCustomer',
        { number: number; invoiceLines: { description: string }[]; referee: { name: string } | null }[]
      >
    >();
  });

  it('refuses what the schema does not have', () => {
    const refused = () => {
      // @ts-expect-error not a relation of invoices
      related('invoices', 'lines', ['id']);
      // @ts-expect-error not a column of customers
      related('invoices', 'customer', ['number']);
      // @ts-expect-error not a column to order by
      related('invoices', 'invoiceLines', { columns: ['id'], orderBy: { number: 'asc' } });
      // @ts-expect-error a relation of invoices, read from a customer
      related('invoices', 'customer', { columns: ['id'], with: [related('invoices', 'referee', ['name'])] });
      // @ts-expect-error the types were not told where parentId leads
      related('categories', 'parent', ['id']);
    };
    expect(refused).toBeTypeOf('function');
  });
});

describe('where', () => {
  it('is a condition on the related table, typed from the schema', () => {
    const open = related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('delivered', '=', false) });
    expectTypeOf(open).toEqualTypeOf<RelatedExpression<'invoices', 'invoiceLines', { id: string }[]>>();

    // A column alone or after its table, with an order and under another name.
    const late = related('invoices', 'invoiceLines', {
      columns: ['description'],
      where: (eb) => eb('invoiceLines.deliveredAt', '>', new Date(0)),
      orderBy: { deliveredAt: 'desc' },
    }).as('late');
    expectTypeOf(late).toEqualTypeOf<RelatedExpression<'invoices', 'late', { description: string }[]>>();

    // Another table is read in a subquery, which names the related row after its table.
    const billed = related('customers', 'invoicesAsCustomer', {
      columns: ['number'],
      where: (eb) => eb.exists(eb.selectFrom('invoiceLines').select('invoiceLines.id').whereRef('invoiceLines.invoiceId', '=', 'invoices.id')),
    });
    expectTypeOf(billed).toEqualTypeOf<RelatedExpression<'customers', 'invoicesAsCustomer', { number: number }[]>>();

    // A condition kept apart says which table it is about.
    const hours: RelatedWhere<typeof schema, 'invoiceLines'> = (eb) => eb('description', '=', 'Hours');
    expectTypeOf(related('invoices', 'invoiceLines', { columns: ['id'], where: hours })).toEqualTypeOf<
      RelatedExpression<'invoices', 'invoiceLines', { id: string }[]>
    >();
  });

  it('refuses what the related table does not have', () => {
    const refused = () => {
      // @ts-expect-error not a column of invoiceLines
      related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('number', '>', 1) });
      // @ts-expect-error a column of the row it hangs on, not of the related rows
      related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('invoices.number', '>', 1) });
      // @ts-expect-error a description is text
      related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('description', '=', 1) });
      // @ts-expect-error a condition, not a value
      related('invoices', 'invoiceLines', { columns: ['id'], where: () => 'yes' });
      // @ts-expect-error a condition about another table
      related('invoices', 'invoiceLines', { columns: ['id'], where: hoursOfInvoices });
    };
    const hoursOfInvoices: RelatedWhere<typeof schema, 'invoices'> = (eb) => eb('number', '=', 1);
    expect(refused).toBeTypeOf('function');
  });
});

describe('.as()', () => {
  it('names the key a relation is answered under, in a row and under another relation', () => {
    const latest = related('customers', 'invoicesAsCustomer', { columns: ['number'], orderBy: { number: 'desc' }, limit: 1 }).as('latest');
    expectTypeOf(latest).toEqualTypeOf<RelatedExpression<'customers', 'latest', { number: number }[]>>();

    const nested = related('invoiceLines', 'invoice', { columns: ['id'], with: [related('invoices', 'customer', ['name']).as('billedTo')] });
    expectTypeOf(nested).toEqualTypeOf<RelatedExpression<'invoiceLines', 'invoice', { id: string; billedTo: { name: string } }>>();

    const listCustomers = action({
      args: {},
      handler: async (db) => db.selectFrom('customers').select(['customers.id', latest, related('customers', 'invoicesAsCustomer', ['id'])]).execute(),
    });
    expectTypeOf<Awaited<ReturnType<typeof listCustomers>>>().toEqualTypeOf<
      { id: string; latest: { number: number }[]; invoicesAsCustomer: { id: string }[] }[]
    >();
  });

  it('still belongs to the table it was read from', () => {
    const refused = () => {
      // @ts-expect-error a relation of invoices under another name is no relation of customers
      related('invoices', 'customer', { columns: ['id'], with: [related('invoices', 'referee', ['name']).as('invoicesAsCustomer')] });
    };
    expect(refused).toBeTypeOf('function');
  });
});

describe('createRelated()', () => {
  it('is typed like the related() of a database on that schema', () => {
    const own = createRelated(schema);
    expectTypeOf(own).toEqualTypeOf(related);
    expectTypeOf(own('invoices', 'referee', ['name'])).toEqualTypeOf<RelatedExpression<'invoices', 'referee', { name: string } | null>>();
  });

  it('takes strings for a schema whose tables are known only when it runs', () => {
    const loose = createRelated(schema as AnySchema);
    expectTypeOf(loose).toEqualTypeOf<AnyRelated>();

    const name: string = 'customer';
    const one = loose('invoices', name, ['id']);
    expectTypeOf(one).toEqualTypeOf<RelatedExpression<string, string, unknown>>();
    // What it builds goes into another of its relations, renamed or not.
    const many = loose('customers', 'invoicesAsCustomer', { columns: ['number'], orderBy: { number: 'desc' }, limit: 2, with: [one.as('who')] });
    expectTypeOf(many).toEqualTypeOf<RelatedExpression<string, string, unknown>>();
  });
});
