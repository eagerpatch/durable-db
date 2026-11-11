import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { integer, table, text } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import type { RelatedExpression } from '../../src/db/related';
import type { Relations } from '../../src/db/relations';

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
