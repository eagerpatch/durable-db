import { SqliteDurableObject, type Migrations } from '../../src/db/SqliteDurableObject';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createKyselyFromSql } from '../../src/db/kysely';
import type { DrizzleToKysely } from '../../src/db/types';
import { integer, table, text } from '../../src/schema';

const customers = table('customers', {
  id: text().primaryKey(),
  name: text().notNull(),
  vip: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
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
const schema = { customers, invoices, invoiceLines };

const { related } = defineDatabase({ schema });

/**
 * Reads along foreign keys with `related()` in a real Durable Object: the
 * JSON subqueries it writes, and what its plugins make of their answers,
 * against workerd's SQLite.
 */
export class TestRelatedDO extends SqliteDurableObject {
  migrations: Migrations = {
    '20240101_invoicing': {
      chunks: [
        [
          `CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, vip INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
          `CREATE TABLE invoices (
            id TEXT PRIMARY KEY,
            number INTEGER NOT NULL,
            customer_id TEXT NOT NULL REFERENCES customers(id),
            referee_id TEXT REFERENCES customers(id)
          )`,
          `CREATE TABLE invoice_lines (
            id TEXT PRIMARY KEY,
            invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0,
            delivered_at INTEGER
          )`,
          `CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id)`,
        ],
      ],
    },
  };

  private async seeded() {
    await this.ensureMigrations();
    const db = createKyselyFromSql<DrizzleToKysely<typeof schema>>(this.sql, { schema });
    await db
      .insertInto('customers')
      .values([
        { id: 'c1', name: 'Bolaget AB', vip: true, createdAt: new Date('2026-01-02T03:04:05Z') },
        { id: 'c2', name: 'Firman HB', vip: false, createdAt: new Date('2026-02-01T00:00:00Z') },
      ])
      .execute();
    await db
      .insertInto('invoices')
      .values([
        { id: 'i1', number: 1, customerId: 'c1', refereeId: 'c2' },
        { id: 'i2', number: 2, customerId: 'c1', refereeId: null },
      ])
      .execute();
    await db
      .insertInto('invoiceLines')
      .values([
        { id: 'l1', invoiceId: 'i1', description: 'Hours', delivered: false, deliveredAt: null },
        { id: 'l2', invoiceId: 'i1', description: 'Travel', delivered: false, deliveredAt: null },
        { id: 'l3', invoiceId: 'i1', description: 'Setup', delivered: true, deliveredAt: new Date('2026-05-02T10:00:00Z') },
      ])
      .execute();
    return db;
  }

  /** Both kinds of relation, order and limit, and what a date and a boolean come back as. */
  async read() {
    const db = await this.seeded();
    const rows = await db
      .selectFrom('invoices')
      .select([
        'invoices.number',
        related('invoices', 'customer', ['name', 'vip', 'createdAt']),
        related('invoices', 'referee', ['name']),
        related('invoices', 'invoiceLines', { columns: ['description', 'delivered', 'deliveredAt'], orderBy: { id: 'desc' }, limit: 2 }),
      ])
      .orderBy('invoices.number')
      .execute();
    const first = rows[0]!;
    return {
      rows: rows.map((row) => ({
        number: row.number,
        customer: row.customer.name,
        referee: row.referee,
        lines: row.invoiceLines.map((line) => line.description),
      })),
      vip: first.customer.vip,
      createdAt: first.customer.createdAt instanceof Date ? first.customer.createdAt.toISOString() : typeof first.customer.createdAt,
      delivered: first.invoiceLines.map((line) => line.delivered),
      deliveredAt: first.invoiceLines.map((line) => (line.deliveredAt instanceof Date ? line.deliveredAt.toISOString() : line.deliveredAt)),
    };
  }

  /** Three levels in one query: a customer, its invoices, their lines and referee. */
  async nested() {
    await this.seeded();
    let queries = 0;
    const counted = createKyselyFromSql<DrizzleToKysely<typeof schema>>(this.sql, {
      schema,
      plugins: [
        {
          transformQuery: (args) => {
            queries++;
            return args.node;
          },
          transformResult: async (args) => args.result,
        },
      ],
    });
    const customer = await counted
      .selectFrom('customers')
      .select([
        'customers.name',
        related('customers', 'invoicesAsCustomer', {
          columns: ['number'],
          orderBy: { number: 'asc' },
          with: [related('invoices', 'invoiceLines', { columns: ['description'], orderBy: { id: 'asc' } }), related('invoices', 'referee', ['name'])],
        }),
      ])
      .where('customers.id', '=', 'c1')
      .executeTakeFirstOrThrow();
    return { customer, queries };
  }

  /** A relation's where: a boolean and a date bound inside the relation's subquery, before its order and limit. */
  async filtered() {
    const db = await this.seeded();
    return db
      .selectFrom('invoices')
      .select([
        'invoices.number',
        related('invoices', 'invoiceLines', { columns: ['description'], where: (eb) => eb('delivered', '=', false), orderBy: { id: 'desc' }, limit: 1 }).as('open'),
        related('invoices', 'invoiceLines', { columns: ['description'], where: (eb) => eb('deliveredAt', '>=', new Date('2026-05-01T00:00:00Z')) }).as('delivered'),
      ])
      .orderBy('invoices.number')
      .execute();
  }

  /** The foreign keys are enforced here, so what a relation reads is what they leave. */
  async afterCascade() {
    const db = await this.seeded();
    await db.deleteFrom('invoices').where('id', '=', 'i1').execute();
    return db
      .selectFrom('customers')
      .select(['customers.id', related('customers', 'invoicesAsCustomer', { columns: ['id'], with: [related('invoices', 'invoiceLines', ['id'])] })])
      .where('customers.id', '=', 'c1')
      .executeTakeFirstOrThrow();
  }
}
