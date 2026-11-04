import { describe, it, expect } from 'vitest';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { generateSnapshotFromSchema } from '../../src/migrations/snapshot';
import {
  applyRenames,
  findAmbiguities,
  parseRenameSpec,
  renamesFromStatements,
  SchemaRenameRequiredError,
  toSnakeCase,
  unusedRenames,
  withoutRemoved,
} from '../../src/migrations/renames';

const orgs = sqliteTable('orgs', { id: text().primaryKey() });

async function snapshots() {
  const before = await generateSnapshotFromSchema({
    orgs,
    products: sqliteTable('products', {
      id: text().primaryKey(),
      description: text().notNull(),
      orgId: text().references(() => orgs.id),
    }, (t) => [index('products_description_idx').on(t.description)]),
  });
  const after = await generateSnapshotFromSchema({
    orgs,
    products: sqliteTable('products', {
      id: text().primaryKey(),
      summary: text().notNull(),
      orgId: text().references(() => orgs.id),
    }, (t) => [index('products_description_idx').on(t.summary)]),
  });
  return { before, after };
}

describe('parseRenameSpec', () => {
  it('parses a column rename', () => {
    expect(parseRenameSpec('products.description=summary')).toEqual({
      kind: 'column', table: 'products', from: 'description', to: 'summary',
    });
  });

  it('accepts the table on both sides of a column rename', () => {
    expect(parseRenameSpec('products.description=products.summary')).toEqual({
      kind: 'column', table: 'products', from: 'description', to: 'summary',
    });
  });

  it('parses a table rename', () => {
    expect(parseRenameSpec('items=products')).toEqual({ kind: 'table', from: 'items', to: 'products' });
  });

  it('rejects malformed answers', () => {
    expect(() => parseRenameSpec('products.description')).toThrow(/expected <table>\.<old>=<new>/);
    expect(() => parseRenameSpec('a.b.c=d')).toThrow(/Invalid rename/);
  });
});

describe('toSnakeCase', () => {
  it('converts the way drizzle names columns', () => {
    expect(toSnakeCase('displayName')).toBe('display_name');
    expect(toSnakeCase('userProfiles')).toBe('user_profiles');
    expect(toSnakeCase('already_snake')).toBe('already_snake');
  });
});

describe('findAmbiguities', () => {
  it('finds a column that may be a rename', async () => {
    const { before, after } = await snapshots();
    expect(findAmbiguities(before, after)).toEqual([
      { kind: 'column', table: 'products', created: ['summary'], deleted: ['description'] },
    ]);
  });

  it('finds nothing when columns are only added', async () => {
    const before = await generateSnapshotFromSchema({ t: sqliteTable('t', { id: text().primaryKey() }) });
    const after = await generateSnapshotFromSchema({
      t: sqliteTable('t', { id: text().primaryKey(), extra: text() }),
    });
    expect(findAmbiguities(before, after)).toEqual([]);
  });

  it('finds a table that may be a rename', async () => {
    const before = await generateSnapshotFromSchema({ items: sqliteTable('items', { id: text().primaryKey() }) });
    const after = await generateSnapshotFromSchema({ products: sqliteTable('products', { id: text().primaryKey() }) });
    expect(findAmbiguities(before, after)).toEqual([
      { kind: 'table', created: ['products'], deleted: ['items'] },
    ]);
  });
});

describe('applyRenames', () => {
  it('renames the column, its references, and emits drizzle-kit\'s statement', async () => {
    const { before, after } = await snapshots();
    const result = applyRenames(before, after, [parseRenameSpec('products.description=summary')]);

    expect(result.statements).toEqual(['ALTER TABLE `products` RENAME COLUMN "description" TO "summary";']);
    expect(result.applied).toEqual([{ kind: 'column', table: 'products', from: 'description', to: 'summary' }]);
    const table = (result.snapshot.tables as any).products;
    expect(Object.keys(table.columns)).toEqual(['id', 'summary', 'org_id']);
    expect(table.columns.summary.name).toBe('summary');
    expect(table.indexes.products_description_idx.columns).toEqual(['summary']);
    // nothing left to ask
    expect(findAmbiguities(result.snapshot, after)).toEqual([]);
    // the input is not mutated
    expect((before.tables as any).products.columns.description).toBeDefined();
  });

  it('accepts camelCase names', async () => {
    const before = await generateSnapshotFromSchema({
      t: sqliteTable('user_profiles', { id: text().primaryKey(), displayName: text() }),
    });
    const after = await generateSnapshotFromSchema({
      t: sqliteTable('user_profiles', { id: text().primaryKey(), fullName: text() }),
    });
    const result = applyRenames(before, after, [parseRenameSpec('userProfiles.displayName=fullName')]);
    expect(result.statements).toEqual(['ALTER TABLE `user_profiles` RENAME COLUMN "display_name" TO "full_name";']);
  });

  it('renames a table and the foreign keys that point at it', async () => {
    const itemsBefore = sqliteTable('items', { id: text().primaryKey() });
    const before = await generateSnapshotFromSchema({
      itemsBefore,
      reviews: sqliteTable('reviews', { id: text().primaryKey(), itemId: text().references(() => itemsBefore.id) }),
    });
    const productsAfter = sqliteTable('products', { id: text().primaryKey() });
    const after = await generateSnapshotFromSchema({
      productsAfter,
      reviews: sqliteTable('reviews', { id: text().primaryKey(), itemId: text().references(() => productsAfter.id) }),
    });

    const result = applyRenames(before, after, [parseRenameSpec('items=products')]);
    expect(result.statements).toEqual(['ALTER TABLE `items` RENAME TO `products`;']);
    const fk = Object.values((result.snapshot.tables as any).reviews.foreignKeys)[0] as any;
    expect(fk.tableTo).toBe('products');
  });

  it('skips an answer that does not match this diff', async () => {
    const { before, after } = await snapshots();
    const result = applyRenames(before, after, [parseRenameSpec('products.title=name')]);
    expect(result.statements).toEqual([]);
    expect(result.applied).toEqual([]);
  });
});

describe('withoutRemoved', () => {
  it('drops vanished columns and the indexes that name them', async () => {
    const { before, after } = await snapshots();
    const mid = withoutRemoved(before, after) as any;
    expect(Object.keys(mid.tables.products.columns)).toEqual(['id', 'org_id']);
    expect(mid.tables.products.indexes).toEqual({});
    expect(findAmbiguities(before, mid)).toEqual([]);
    expect(findAmbiguities(mid, after)).toEqual([]);
  });
});

describe('renamesFromStatements', () => {
  it('reads column and table renames, not drizzle-kit\'s table recreation', () => {
    expect(renamesFromStatements([
      'ALTER TABLE `products` RENAME COLUMN "description" TO "summary";',
      'ALTER TABLE `items` RENAME TO `products`;',
      'ALTER TABLE `__new_products` RENAME TO `products`;',
    ])).toEqual([
      { kind: 'column', table: 'products', from: 'description', to: 'summary' },
      { kind: 'table', from: 'items', to: 'products' },
    ]);
  });
});

describe('unusedRenames', () => {
  it('reports the answers no statement performed', () => {
    const performed = renamesFromStatements(['ALTER TABLE `products` RENAME COLUMN "description" TO "summary";']);
    const used = parseRenameSpec('products.description=summary');
    const unused = parseRenameSpec('products.title=name');
    expect(unusedRenames([used, unused], performed)).toEqual([unused]);
  });
});

describe('SchemaRenameRequiredError', () => {
  it('names the command, the question and both answers', () => {
    const error = new SchemaRenameRequiredError([
      { kind: 'column', table: 'products', created: ['summary'], deleted: ['description'] },
    ]).forDatabase('catalog');

    const message = error.describe('lagerverk db generate');
    expect(message).toContain('catalog: the schema change needs rename resolution');
    expect(message).toContain('interactive terminal (TTY)');
    expect(message).toContain('products: summary added, description removed');
    expect(message).toContain('lagerverk db generate --rename products.description=summary');
    expect(message).toContain('lagerverk db generate --no-renames');
    expect(error.message).toContain('catalog:');
  });
});
