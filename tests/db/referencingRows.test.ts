import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { effectOf, guardReferencingRows, type Sql } from '../../src/db/referencingRows';

describe('what a statement does to the set of tables', () => {
  it.each([
    ['DROP TABLE `customers`;', { kind: 'drop', table: 'customers' }],
    ['  drop table if exists "main"."Order ""lines""";', { kind: 'drop', table: 'Order "lines"' }],
    ['DROP TABLE [old customers]', { kind: 'drop', table: 'old customers' }],
    ['DROP TABLE main.customers', { kind: 'drop', table: 'customers' }],
    ['CREATE TABLE `__new_customers` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n', { kind: 'create', table: '__new_customers' }],
    ['CREATE TEMP TABLE IF NOT EXISTS t AS SELECT 1', { kind: 'create', table: 't' }],
    ['ALTER TABLE `__new_customers` RENAME TO `customers`;', { kind: 'rename', from: '__new_customers', to: 'customers' }],
    ['alter table main.a rename to "b c"', { kind: 'rename', from: 'a', to: 'b c' }],
  ])('%s', (statement, effect) => {
    expect(effectOf(statement)).toEqual(effect);
  });

  it.each([
    'ALTER TABLE `customers` RENAME COLUMN `name` TO `title`;',
    'ALTER TABLE customers RENAME name TO title',
    'ALTER TABLE `customers` ADD `credit` integer;',
    'ALTER TABLE `customers` DROP COLUMN `credit`;',
    'DROP INDEX `customers_name`;',
    'CREATE INDEX `customers_name` ON `customers` (`name`);',
    'CREATE TABLE',
    'INSERT INTO `__new_customers`("id") SELECT "id" FROM `customers`;',
    'PRAGMA foreign_keys=OFF;',
  ])('nothing: %s', (statement) => {
    expect(effectOf(statement)).toBeNull();
  });
});

/** node:sqlite as the part of a Durable Object's SqlStorage the guard uses, counting what it is asked. */
function memory() {
  const database = new DatabaseSync(':memory:');
  const asked: string[] = [];
  const sql: Sql = {
    exec(query, ...bindings) {
      asked.push(query);
      const found = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => found };
    },
  };
  return { database, sql, asked };
}

describe('the guard of a chunk', () => {
  it('is none, and asks the database nothing, for a chunk that drops no table', () => {
    const { sql, asked } = memory();
    const statements = ['CREATE TABLE `a` (`id` text);', 'ALTER TABLE `a` ADD `b` text;', 'DROP INDEX `a_b`;'];

    expect(guardReferencingRows(sql, statements)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('runs a drop as it is where foreign keys are not enforced', () => {
    const { database, sql, asked } = memory();
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('CREATE TABLE customers (id text PRIMARY KEY)');
    database.exec('CREATE TABLE invoices (id text PRIMARY KEY, customer_id text REFERENCES customers(id) ON DELETE CASCADE)');
    database.exec("INSERT INTO customers VALUES ('c1'); INSERT INTO invoices VALUES ('i1', 'c1')");

    const statements = [
      'CREATE TABLE __new_customers (id text PRIMARY KEY, credit integer)',
      'INSERT INTO __new_customers (id) SELECT id FROM customers',
      'DROP TABLE customers',
      'ALTER TABLE __new_customers RENAME TO customers',
    ];
    const guard = guardReferencingRows(sql, statements)!;
    statements.forEach((statement, at) => guard.run(at, () => database.exec(statement)));
    guard.finish();

    expect(asked).toEqual(['PRAGMA foreign_keys']);
    expect(database.prepare('SELECT id, customer_id FROM invoices').all()).toEqual([{ id: 'i1', customer_id: 'c1' }]);
  });

  it('keeps the referencing rows where they are enforced, inside a transaction', () => {
    const { database, sql } = memory();
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('CREATE TABLE customers (id text PRIMARY KEY)');
    database.exec('CREATE TABLE invoices (id text PRIMARY KEY, customer_id text REFERENCES customers(id) ON DELETE CASCADE)');
    database.exec("INSERT INTO customers VALUES ('c1'); INSERT INTO invoices VALUES ('i1', 'c1')");

    const statements = [
      // Inside a transaction this changes nothing, as in a Durable Object.
      'PRAGMA foreign_keys=OFF',
      'CREATE TABLE __new_customers (id text PRIMARY KEY, credit integer)',
      'INSERT INTO __new_customers (id) SELECT id FROM customers',
      'DROP TABLE customers',
      'ALTER TABLE __new_customers RENAME TO customers',
      'PRAGMA foreign_keys=ON',
    ];
    database.exec('BEGIN');
    const guard = guardReferencingRows(sql, statements)!;
    statements.forEach((statement, at) => guard.run(at, () => database.exec(statement)));
    guard.finish();
    database.exec('COMMIT');

    expect(database.prepare('SELECT id, customer_id FROM invoices').all()).toEqual([{ id: 'i1', customer_id: 'c1' }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%hold%'").all()).toEqual([]);
  });
});
