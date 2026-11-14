import { describe, it, expect } from 'vitest';
import Database from 'libsql';
import { accept, replayWithRows, sift, type RowsDatabaseConstructor } from '../../src/migrations/withRows';

const libsql = Database as unknown as RowsDatabaseConstructor;

// Migrations as `db generate` writes them: one chunk, drizzle-kit's statements.
const migration = (name: string, ...statements: string[]) => [name, [statements]] as const;

const first = migration(
  '0001_first',
  'CREATE TABLE `products` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `sku` text)',
  'CREATE TABLE `cart_items` (`id` text PRIMARY KEY NOT NULL, `product_id` text NOT NULL, `qty` integer NOT NULL)',
);

// drizzle-kit's rebuild of a table, the way it writes one that gains a foreign key.
const rebuild = (table: string, columns: string, copy: string, ...before: string[]) => [
  'PRAGMA foreign_keys=OFF',
  ...before,
  `CREATE TABLE \`__new_${table}\` (${columns})`,
  `INSERT INTO \`__new_${table}\`(${copy}) SELECT ${copy} FROM \`${table}\``,
  `DROP TABLE \`${table}\``,
  `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\``,
  'PRAGMA foreign_keys=ON',
];

const withForeignKey = '`id` text PRIMARY KEY NOT NULL, `product_id` text NOT NULL, `qty` integer NOT NULL, FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action';

describe('replayWithRows', () => {
  it('passes what an empty database passes and rows do not mind', () => {
    const replay = replayWithRows(libsql, [first, migration('0002_bio', 'ALTER TABLE `products` ADD `bio` text'), migration('0003_index', 'CREATE INDEX `products_name` ON `products` (`name`)')]);
    expect(replay).toEqual({ findings: [], unseeded: [] });
  });

  it('finds a foreign key added where a row references nothing: the pragma that would hide it does nothing in an object', () => {
    const { findings } = replayWithRows(libsql, [first, migration('0002_fk', ...rebuild('cart_items', withForeignKey, '"id", "product_id", "qty"'))]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ migration: '0002_fk', kind: 'fails', chunk: 0 });
    expect(findings[0]!.error).toMatch(/FOREIGN KEY constraint failed/);
    expect(findings[0]!.message).toContain('fails on a database that has rows');
    expect(findings[0]!.message).toContain('remove or repair those rows in this migration, before the statement');
  });

  it('passes the same migration once it repairs the rows first', () => {
    const repaired = rebuild('cart_items', withForeignKey, '"id", "product_id", "qty"', 'DELETE FROM `cart_items` WHERE `product_id` NOT IN (SELECT `id` FROM `products`)');
    expect(replayWithRows(libsql, [first, migration('0002_fk', ...repaired)]).findings).toEqual([]);
  });

  it('finds a column made NOT NULL where a row holds NULL, and passes it with the rows given a value first', () => {
    const columns = '`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `sku` text NOT NULL';
    const copy = '"id", "name", "sku"';
    const { findings } = replayWithRows(libsql, [first, migration('0002_sku', ...rebuild('products', columns, copy))]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.error).toMatch(/NOT NULL constraint failed: __new_products\.sku/);
    expect(findings[0]!.message).toContain('UPDATE … SET … WHERE … IS NULL');

    const backfilled = rebuild('products', columns, copy, "UPDATE `products` SET `sku` = 'none' WHERE `sku` IS NULL");
    expect(replayWithRows(libsql, [first, migration('0002_sku', ...backfilled)]).findings).toEqual([]);
  });

  it('finds a unique index over a column two rows hold the same value in', () => {
    const { findings } = replayWithRows(libsql, [first, migration('0002_unique', 'CREATE UNIQUE INDEX `products_name_unique` ON `products` (`name`)')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.error).toMatch(/UNIQUE constraint failed/);
  });

  it('follows a rename: the rows and their values are there under the new names', () => {
    const renames = migration('0002_rename', 'ALTER TABLE `products` RENAME COLUMN "name" TO "title"', 'ALTER TABLE `cart_items` RENAME TO `basket_items`');
    expect(replayWithRows(libsql, [first, renames]).findings).toEqual([]);
  });

  it('finds a rebuild that leaves a column behind: its values are gone, and nothing failed', () => {
    const { findings } = replayWithRows(libsql, [first, migration('0002_forgot', ...rebuild('products', '`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `sku` text', '"id", "name"'))]);
    expect(findings).toEqual([
      {
        migration: '0002_forgot',
        kind: 'loses-values',
        table: 'products',
        column: 'sku',
        message: expect.stringMatching(/^products\.sku is empty after it in \d+ row\(s\) that held a value before/),
        fingerprint: 'loses-values:products.sku',
      },
    ]);
  });

  it('finds rows that are gone without a statement that deletes them, and lets a DELETE of the migration be', () => {
    const filtered = [
      'CREATE TABLE `__new_products` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `sku` text)',
      'INSERT INTO `__new_products`("id", "name", "sku") SELECT "id", "name", "sku" FROM `products` WHERE `sku` IS NOT NULL',
      'DROP TABLE `products`',
      'ALTER TABLE `__new_products` RENAME TO `products`',
    ];
    const { findings } = replayWithRows(libsql, [first, migration('0002_filtered', ...filtered)]);
    expect(findings).toEqual([expect.objectContaining({ kind: 'loses-rows', table: 'products', fingerprint: 'loses-rows:products' })]);

    expect(replayWithRows(libsql, [first, migration('0002_delete', 'DELETE FROM `products` WHERE `sku` IS NULL')]).findings).toEqual([]);
  });

  it('keeps the rows that reference a rebuilt table, as the object does: a cascade takes none of them', () => {
    const start = migration(
      '0001_first',
      'CREATE TABLE `customers` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)',
      'CREATE TABLE `invoices` (`id` text PRIMARY KEY NOT NULL, `customer_id` text NOT NULL, FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade)',
    );
    const widened = migration('0002_widen', ...rebuild('customers', '`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `email` text', '"id", "name"'));
    expect(replayWithRows(libsql, [start, widened]).findings).toEqual([]);
  });

  it('goes on after a migration that fails: the ones after it are checked too', () => {
    const { findings, stopped } = replayWithRows(libsql, [
      first,
      migration('0002_fk', ...rebuild('cart_items', withForeignKey, '"id", "product_id", "qty"')),
      migration('0003_unique', 'CREATE UNIQUE INDEX `products_name_unique` ON `products` (`name`)'),
    ]);
    expect(stopped).toBeUndefined();
    expect(findings.map((finding) => [finding.migration, finding.kind])).toEqual([
      ['0002_fk', 'fails'],
      ['0003_unique', 'fails'],
    ]);
  });

  it('stops at a migration that fails on an empty database too: that is not about rows', () => {
    const replay = replayWithRows(libsql, [first, migration('0002_broken', 'ALTER TABLE `nowhere` ADD `x` text')]);
    expect(replay.stopped).toMatchObject({ migration: '0002_broken' });
    expect(replay.findings).toHaveLength(1);
  });

  it('says which tables it could make no row for', () => {
    const picky = migration('0001_picky', "CREATE TABLE `codes` (`id` text PRIMARY KEY NOT NULL, `code` text NOT NULL CHECK (`code` GLOB '[0-9][0-9][0-9]'))");
    const replay = replayWithRows(libsql, [picky, migration('0002_more', 'ALTER TABLE `codes` ADD `note` text')]);
    expect(replay.findings).toEqual([]);
    expect(replay.unseeded).toEqual([{ table: 'codes', reason: expect.stringMatching(/CHECK constraint failed/) }]);
  });
});

describe('what was looked at and let through', () => {
  it('is kept by migration and fingerprint: an accepted finding is no longer open, a new one is', () => {
    const { findings } = replayWithRows(libsql, [first, migration('0002_unique', 'CREATE UNIQUE INDEX `products_name_unique` ON `products` (`name`)')]);
    const accepted = accept({}, findings);
    expect(Object.keys(accepted)).toEqual(['0002_unique']);
    expect(sift(findings, accepted)).toEqual({ open: [], accepted: findings });
    expect(sift(findings, {})).toEqual({ open: findings, accepted: [] });
    // Deterministic: the same migrations give the same fingerprints.
    expect(replayWithRows(libsql, [first, migration('0002_unique', 'CREATE UNIQUE INDEX `products_name_unique` ON `products` (`name`)')]).findings[0]!.fingerprint).toBe(findings[0]!.fingerprint);
  });
});
