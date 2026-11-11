/**
 * A migration that rebuilds or drops a table other tables reference, run
 * through the real migration path in workerd.
 *
 * SQLite changes a column's type, constraints or foreign keys by rebuilding
 * the table: create `__new_t`, copy the rows, `DROP TABLE t`, rename. drizzle-kit
 * wraps that in `PRAGMA foreign_keys=OFF/ON`, which a Durable Object ignores
 * (its storage is always inside a transaction, where the pragma does nothing).
 * With foreign keys on, the DROP deletes the table's rows first — and runs the
 * `ON DELETE` action of every row that references them.
 *
 * The statements below are what drizzle-kit generates for each change, verbatim.
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

type Outcome = { journal: string[]; columns: string[] } | { error: string; name: string };

interface TestEnv {
  TEST_DEV_HANDOFF_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub & {
      migrateWith: (migrations: Record<string, { chunks: string[][] }>) => Promise<Outcome>;
    };
  };
}

const objects = (env as unknown as TestEnv).TEST_DEV_HANDOFF_DO;

/** Applies `init`, writes `seed`, then applies `change` as one generated migration. */
async function migrate(init: string[], seed: string[], change: string[]) {
  const stub = objects.get(objects.idFromName(`fk-${crypto.randomUUID()}`));
  const first = { '20261101000000_init': { chunks: [init] } };
  expect(await stub.migrateWith(first)).not.toHaveProperty('error');
  await runInDurableObject(stub, async (_instance, state) => {
    for (const statement of seed) state.storage.sql.exec(statement);
  });
  const outcome = await stub.migrateWith({ ...first, '20261102000000_change': { chunks: [change] } });
  const read = (query: string) =>
    runInDurableObject(stub, async (_instance, state) => state.storage.sql.exec(query).toArray());
  return { outcome, read };
}

const APPLIED = { journal: ['20261101000000_init[0]', '20261102000000_change[0]'] };

const CUSTOMERS = 'CREATE TABLE `customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`credit` text\n);\n';

const invoices = (onDelete: string, notNull = ' NOT NULL') =>
  `CREATE TABLE \`invoices\` (\n\t\`id\` text PRIMARY KEY NOT NULL,\n\t\`customer_id\` text${notNull},\n\t\`number\` integer NOT NULL,\n\tFOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`) ON UPDATE no action ON DELETE ${onDelete}\n);\n`;

// customers.credit: text → integer
const REBUILD_CUSTOMERS = [
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`credit` integer\n);\n',
  'INSERT INTO `__new_customers`("id", "name", "credit") SELECT "id", "name", "credit" FROM `customers`;',
  'DROP TABLE `customers`;',
  'ALTER TABLE `__new_customers` RENAME TO `customers`;',
  'PRAGMA foreign_keys=ON;',
];

const SEED = [
  "INSERT INTO customers (id, name, credit) VALUES ('c1', 'Bolaget AB', '100'), ('c2', 'Firman HB', NULL)",
  "INSERT INTO invoices (id, customer_id, number) VALUES ('i1', 'c1', 1), ('i2', 'c1', 2), ('i3', 'c2', 3)",
];

describe('rebuilding a table that others reference (real workerd)', () => {
  it.each(['cascade', 'no action', 'restrict'])('keeps the rows that reference it: ON DELETE %s', async (onDelete) => {
    const { outcome, read } = await migrate([CUSTOMERS, invoices(onDelete)], SEED, REBUILD_CUSTOMERS);

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id, number FROM invoices ORDER BY id')).toEqual([
      { id: 'i1', customer_id: 'c1', number: 1 },
      { id: 'i2', customer_id: 'c1', number: 2 },
      { id: 'i3', customer_id: 'c2', number: 3 },
    ]);
    expect(await read('SELECT id, credit FROM customers ORDER BY id')).toEqual([
      { id: 'c1', credit: 100 },
      { id: 'c2', credit: null },
    ]);
  });

  it('keeps what they reference: ON DELETE set null', async () => {
    const { outcome, read } = await migrate([CUSTOMERS, invoices('set null', '')], SEED, REBUILD_CUSTOMERS);

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual([
      { id: 'i1', customer_id: 'c1' },
      { id: 'i2', customer_id: 'c1' },
      { id: 'i3', customer_id: 'c2' },
    ]);
  });

  it('still enforces the references afterwards', async () => {
    const { read } = await migrate([CUSTOMERS, invoices('cascade')], SEED, REBUILD_CUSTOMERS);

    // The children reference the rebuilt table, not the dropped one: deleting a parent cascades as before.
    await read("DELETE FROM customers WHERE id = 'c1'");
    expect(await read('SELECT id FROM invoices ORDER BY id')).toEqual([{ id: 'i3' }]);
  });
});

// accounts.credit: text → integer, in a table that references itself
const REBUILD_ACCOUNTS = [
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_accounts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`parent_id` text,\n\t`credit` integer,\n\tFOREIGN KEY (`parent_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
  'INSERT INTO `__new_accounts`("id", "parent_id", "credit") SELECT "id", "parent_id", "credit" FROM `accounts`;',
  'DROP TABLE `accounts`;',
  'ALTER TABLE `__new_accounts` RENAME TO `accounts`;',
  'PRAGMA foreign_keys=ON;',
];

// customers.credit and invoices.total: text → integer — two rebuilds, the second one outside the pragmas
const REBUILD_CUSTOMERS_AND_INVOICES = [
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`credit` integer\n);\n',
  'INSERT INTO `__new_customers`("id", "credit") SELECT "id", "credit" FROM `customers`;',
  'DROP TABLE `customers`;',
  'ALTER TABLE `__new_customers` RENAME TO `customers`;',
  'PRAGMA foreign_keys=ON;',
  'CREATE TABLE `__new_invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` text NOT NULL,\n\t`total` integer,\n\tFOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
  'INSERT INTO `__new_invoices`("id", "customer_id", "total") SELECT "id", "customer_id", "total" FROM `invoices`;',
  'DROP TABLE `invoices`;',
  'ALTER TABLE `__new_invoices` RENAME TO `invoices`;',
  'CREATE INDEX `invoices_customer` ON `invoices` (`customer_id`);',
];

// The customers table is removed; invoices keeps the column without the reference
const DROP_CUSTOMERS = [
  'DROP TABLE `customers`;',
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` text NOT NULL\n);\n',
  'INSERT INTO `__new_invoices`("id", "customer_id") SELECT "id", "customer_id" FROM `invoices`;',
  'DROP TABLE `invoices`;',
  'ALTER TABLE `__new_invoices` RENAME TO `invoices`;',
  'PRAGMA foreign_keys=ON;',
];

describe('the other shapes drizzle-kit generates (real workerd)', () => {
  it('keeps the rows of a table that references itself', async () => {
    const { outcome, read } = await migrate(
      ['CREATE TABLE `accounts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`parent_id` text,\n\t`credit` text,\n\tFOREIGN KEY (`parent_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade\n);\n'],
      ["INSERT INTO accounts (id, parent_id, credit) VALUES ('a1', NULL, '1'), ('a2', 'a1', '2'), ('a3', 'a2', NULL)"],
      REBUILD_ACCOUNTS
    );

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, parent_id, credit FROM accounts ORDER BY id')).toEqual([
      { id: 'a1', parent_id: null, credit: 1 },
      { id: 'a2', parent_id: 'a1', credit: 2 },
      { id: 'a3', parent_id: 'a2', credit: null },
    ]);
  });

  it('keeps children and their children when a parent and a child are both rebuilt', async () => {
    const { outcome, read } = await migrate(
      [
        'CREATE TABLE `customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`credit` text\n);\n',
        'CREATE TABLE `invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` text NOT NULL,\n\t`total` text,\n\tFOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
        'CREATE TABLE `invoice_lines` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`invoice_id` text NOT NULL,\n\t`description` text,\n\tFOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
      ],
      [
        "INSERT INTO customers (id, credit) VALUES ('c1', '100')",
        "INSERT INTO invoices (id, customer_id, total) VALUES ('i1', 'c1', '250'), ('i2', 'c1', NULL)",
        "INSERT INTO invoice_lines (invoice_id, description) VALUES ('i1', 'Hours'), ('i1', 'Travel'), ('i2', 'Setup')",
        // A gap in the ids, and a sequence past the highest one left.
        'DELETE FROM invoice_lines WHERE id = 2',
        "INSERT INTO invoice_lines (invoice_id, description) VALUES ('i1', 'Material')",
        'DELETE FROM invoice_lines WHERE id = 4',
      ],
      REBUILD_CUSTOMERS_AND_INVOICES
    );

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id, total FROM invoices ORDER BY id')).toEqual([
      { id: 'i1', customer_id: 'c1', total: 250 },
      { id: 'i2', customer_id: 'c1', total: null },
    ]);
    expect(await read('SELECT id, invoice_id, description FROM invoice_lines ORDER BY id')).toEqual([
      { id: 1, invoice_id: 'i1', description: 'Hours' },
      { id: 3, invoice_id: 'i2', description: 'Setup' },
    ]);
    // AUTOINCREMENT never hands out an id again.
    await read("INSERT INTO invoice_lines (invoice_id, description) VALUES ('i2', 'Next')");
    expect(await read("SELECT id FROM invoice_lines WHERE description = 'Next'")).toEqual([{ id: 5 }]);
    expect(await read("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'invoices_customer'")).toHaveLength(1);
  });

  it('keeps the rows of a table whose parent is dropped', async () => {
    const { outcome, read } = await migrate(
      [
        CUSTOMERS,
        'CREATE TABLE `invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` text NOT NULL,\n\tFOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
      ],
      [SEED[0], "INSERT INTO invoices (id, customer_id) VALUES ('i1', 'c1'), ('i2', 'c2')"],
      DROP_CUSTOMERS
    );

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual([
      { id: 'i1', customer_id: 'c1' },
      { id: 'i2', customer_id: 'c2' },
    ]);
    expect(await read("SELECT name FROM sqlite_master WHERE name = 'customers'")).toEqual([]);
  });
});

const INVOICES_CASCADE = invoices('cascade');
const UNCHANGED = [
  { id: 'i1', customer_id: 'c1' },
  { id: 'i2', customer_id: 'c1' },
  { id: 'i3', customer_id: 'c2' },
];

describe('what else is in the way of a rebuild (real workerd)', () => {
  it('keeps the rows of tables that reference each other', async () => {
    const { outcome, read } = await migrate(
      [
        'CREATE TABLE `customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`credit` text,\n\t`last_invoice_id` text,\n\tFOREIGN KEY (`last_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null\n);\n',
        INVOICES_CASCADE,
      ],
      [
        "INSERT INTO customers (id, credit) VALUES ('c1', '100'), ('c2', NULL)",
        SEED[1],
        "UPDATE customers SET last_invoice_id = 'i2' WHERE id = 'c1'",
        "UPDATE customers SET last_invoice_id = 'i3' WHERE id = 'c2'",
      ],
      [
        'PRAGMA foreign_keys=OFF;',
        'CREATE TABLE `__new_customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`credit` integer,\n\t`last_invoice_id` text,\n\tFOREIGN KEY (`last_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null\n);\n',
        'INSERT INTO `__new_customers`("id", "credit", "last_invoice_id") SELECT "id", "credit", "last_invoice_id" FROM `customers`;',
        'DROP TABLE `customers`;',
        'ALTER TABLE `__new_customers` RENAME TO `customers`;',
        'PRAGMA foreign_keys=ON;',
      ]
    );

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual(UNCHANGED);
    expect(await read('SELECT id, credit, last_invoice_id FROM customers ORDER BY id')).toEqual([
      { id: 'c1', credit: 100, last_invoice_id: 'i2' },
      { id: 'c2', credit: null, last_invoice_id: 'i3' },
    ]);
  });

  it('runs no trigger of the tables it moves aside, and leaves them in place', async () => {
    const { outcome, read } = await migrate(
      [
        CUSTOMERS,
        INVOICES_CASCADE,
        'CREATE TABLE `log` (\n\t`what` text NOT NULL,\n\t`invoice_id` text NOT NULL\n);\n',
        "CREATE TRIGGER `invoices_deleted` AFTER DELETE ON `invoices` BEGIN INSERT INTO log (what, invoice_id) VALUES ('deleted', old.id); END;",
        "CREATE TRIGGER `invoices_added` AFTER INSERT ON `invoices` BEGIN INSERT INTO log (what, invoice_id) VALUES ('added', new.id); END;",
      ],
      [...SEED, 'DELETE FROM log'],
      REBUILD_CUSTOMERS
    );

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual(UNCHANGED);
    expect(await read('SELECT what, invoice_id FROM log')).toEqual([]);

    await read("DELETE FROM invoices WHERE id = 'i3'");
    await read("INSERT INTO invoices (id, customer_id, number) VALUES ('i4', 'c2', 4)");
    expect(await read('SELECT what, invoice_id FROM log ORDER BY what')).toEqual([
      { what: 'added', invoice_id: 'i4' },
      { what: 'deleted', invoice_id: 'i3' },
    ]);
  });

  it('fails a rebuild that leaves out rows others reference, and changes nothing', async () => {
    const { outcome, read } = await migrate([CUSTOMERS, INVOICES_CASCADE], SEED, [
      ...REBUILD_CUSTOMERS.slice(0, 2),
      'INSERT INTO `__new_customers`("id", "name", "credit") SELECT "id", "name", "credit" FROM `customers` WHERE "id" <> \'c2\';',
      ...REBUILD_CUSTOMERS.slice(3),
    ]);

    expect(outcome).toMatchObject({
      error: expect.stringMatching(/1 row\(s\) of "invoices" reference rows of "customers" that the rebuild of "customers" leaves out/),
    });
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual(UNCHANGED);
    expect(await read('SELECT id, credit FROM customers ORDER BY id')).toEqual([
      { id: 'c1', credit: '100' },
      { id: 'c2', credit: null },
    ]);
    expect(await read("SELECT name FROM sqlite_master WHERE name LIKE '%durable_db_hold%' OR name LIKE '%new_customers%'")).toEqual([]);
    expect(await read('SELECT name FROM __migrations')).toHaveLength(1);
  });

  it('fails rebuilds that are woven into each other, and changes nothing', async () => {
    const { outcome, read } = await migrate([CUSTOMERS, INVOICES_CASCADE], SEED, [
      REBUILD_CUSTOMERS[1],
      REBUILD_CUSTOMERS[2],
      'CREATE TABLE `__new_invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` text NOT NULL,\n\t`number` text NOT NULL,\n\tFOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade\n);\n',
      'INSERT INTO `__new_invoices`("id", "customer_id", "number") SELECT "id", "customer_id", "number" FROM `invoices`;',
      'DROP TABLE `customers`;',
      'DROP TABLE `invoices`;',
      'ALTER TABLE `__new_customers` RENAME TO `customers`;',
      'ALTER TABLE `__new_invoices` RENAME TO `invoices`;',
    ]);

    expect(outcome).toMatchObject({
      error: expect.stringMatching(/drops "invoices" in the middle of the rebuild of "customers"/),
    });
    expect(await read('SELECT id, customer_id FROM invoices ORDER BY id')).toEqual(UNCHANGED);
    expect(await read('SELECT id, credit FROM customers ORDER BY id')).toHaveLength(2);
  });

  it('lets a table that is dropped and created anew take its rows, and theirs, with it', async () => {
    const { outcome, read } = await migrate([CUSTOMERS, INVOICES_CASCADE], SEED, ['DROP TABLE `customers`;', CUSTOMERS]);

    expect(outcome).toMatchObject(APPLIED);
    expect(await read('SELECT id FROM customers')).toEqual([]);
    expect(await read('SELECT id FROM invoices')).toEqual([]);
  });
});
