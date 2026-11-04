import { describe, it, expect } from 'vitest';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { generateSnapshotFromSchema } from '../../src/migrations/snapshot';
import { analyzeMigrationRisks, NOT_NULL_WITHOUT_DEFAULT_HINT } from '../../src/migrations/risks';

const base = { id: text().primaryKey(), name: text().notNull() };

async function diff(before: Record<string, any>, after: Record<string, any>) {
  return [
    await generateSnapshotFromSchema({ products: sqliteTable('products', before) }),
    await generateSnapshotFromSchema({ products: sqliteTable('products', after) }),
  ] as const;
}

describe('analyzeMigrationRisks', () => {
  it('flags a NOT NULL column added without a default as an error', async () => {
    const [prev, cur] = await diff(base, { ...base, currency: text().notNull() });
    expect(analyzeMigrationRisks(prev, cur)).toEqual([
      expect.objectContaining({
        kind: 'add-not-null-without-default',
        severity: 'error',
        table: 'products',
        column: 'currency',
        message: expect.stringContaining(NOT_NULL_WITHOUT_DEFAULT_HINT),
      }),
    ]);
  });

  it('accepts a NOT NULL column with a default, and a nullable one', async () => {
    const [prev, cur] = await diff(base, {
      ...base,
      currency: text().notNull().default('SEK'),
      note: text(),
    });
    expect(analyzeMigrationRisks(prev, cur)).toEqual([]);
  });

  it('accepts NOT NULL columns of a new table (CREATE TABLE has no rows)', async () => {
    const prev = await generateSnapshotFromSchema({});
    const cur = await generateSnapshotFromSchema({ products: sqliteTable('products', base) });
    expect(analyzeMigrationRisks(prev, cur)).toEqual([]);
  });

  it('warns about a dropped column and a dropped table', async () => {
    const prev = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...base, legacy: text() }),
      archive: sqliteTable('archive', { id: text().primaryKey() }),
    });
    const cur = await generateSnapshotFromSchema({ products: sqliteTable('products', base) });
    const risks = analyzeMigrationRisks(prev, cur);
    expect(risks).toHaveLength(2);
    expect(risks.map((r) => [r.kind, r.severity, r.message])).toEqual(expect.arrayContaining([
      ['drop-column', 'warning', 'products.legacy is dropped — its data is lost'],
      ['drop-table', 'warning', 'table archive is dropped — its rows are lost'],
    ]));
  });

  it('warns when a column becomes NOT NULL', async () => {
    const [prev, cur] = await diff({ ...base, sku: text() }, { ...base, sku: text().notNull() });
    expect(analyzeMigrationRisks(prev, cur)).toEqual([
      expect.objectContaining({ kind: 'set-not-null', severity: 'warning', column: 'sku' }),
    ]);
  });

  it('treats a renamed column as neither dropped nor added', async () => {
    const [prev, cur] = await diff(
      { ...base, description: text().notNull() },
      { ...base, summary: text().notNull() },
    );
    // Unresolved: create + drop — the new NOT NULL column fails, the old one's data is lost
    expect(analyzeMigrationRisks(prev, cur).map((r) => r.kind).sort()).toEqual([
      'add-not-null-without-default',
      'drop-column',
    ]);
    // Answered as a rename: nothing at risk
    expect(analyzeMigrationRisks(prev, cur, [
      { kind: 'column', table: 'products', from: 'description', to: 'summary' },
    ])).toEqual([]);
  });

  it('ignores an INTEGER PRIMARY KEY (SQLite fills the rowid)', async () => {
    const prev = await generateSnapshotFromSchema({ t: sqliteTable('t', { name: text() }) });
    const cur = await generateSnapshotFromSchema({ t: sqliteTable('t', { id: integer().primaryKey(), name: text() }) });
    expect(analyzeMigrationRisks(prev, cur)).toEqual([]);
  });
});
