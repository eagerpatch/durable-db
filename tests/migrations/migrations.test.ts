import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import {
  type Snapshot,
  createEmptySnapshot,
  snapshotsEqual,
  hashSnapshot,
  generateSnapshotFromSchema,
  generateMigrationStatements,
  SchemaRenameRequiredError,
} from '../../src/migrations/snapshot';
import { loadMigrationFiles, generateMigrationName, loadSnapshot, saveSnapshot } from '../../src/migrations/generator';

describe('migrations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epdb-migrations-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createEmptySnapshot', () => {
    it('creates a valid empty snapshot', () => {
      const snapshot = createEmptySnapshot();

      expect(snapshot.version).toBe('6');
      expect(snapshot.dialect).toBe('sqlite');
      expect(snapshot.tables).toEqual({});
      expect(snapshot.enums).toEqual({});
    });
  });

  describe('snapshotsEqual', () => {
    it('returns true for identical snapshots', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();

      expect(snapshotsEqual(a, b)).toBe(true);
    });

    it('returns false when tables differ', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.tables = { users: { name: 'users' } } as any;

      expect(snapshotsEqual(a, b)).toBe(false);
    });

    it('returns false when views differ', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.views = { active_users: { name: 'active_users' } } as any;

      expect(snapshotsEqual(a, b)).toBe(false);
    });

    it('returns false when enums differ', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.enums = { role: { name: 'role', values: ['admin', 'user'] } } as any;

      expect(snapshotsEqual(a, b)).toBe(false);
    });
  });

  describe('hashSnapshot', () => {
    it('returns consistent hash for same snapshot', () => {
      const snapshot = createEmptySnapshot();

      expect(hashSnapshot(snapshot)).toBe(hashSnapshot(snapshot));
    });

    it('returns different hash for different snapshots', () => {
      const a = createEmptySnapshot();
      const b = createEmptySnapshot();
      b.tables = { users: { name: 'users' } } as any;

      expect(hashSnapshot(a)).not.toBe(hashSnapshot(b));
    });
  });

  describe('generateMigrationName', () => {
    it('generates a timestamp-based name', () => {
      const name = generateMigrationName();

      // Should be 14 characters (YYYYMMDDHHmmss)
      expect(name).toMatch(/^\d{14}$/);
    });

    it('includes suffix when provided', () => {
      const name = generateMigrationName('initial');

      expect(name).toMatch(/^\d{14}_initial$/);
    });
  });

  describe('loadSnapshot / saveSnapshot', () => {
    it('saves and loads a snapshot', () => {
      const snapshot = {
        version: '6',
        dialect: 'sqlite',
        id: 'test123',
        prevId: '',
        tables: { users: { name: 'users' } },
        enums: {},
        _meta: { tables: {}, columns: {} },
      } as unknown as Snapshot;

      saveSnapshot(tempDir, snapshot);
      const loaded = loadSnapshot(tempDir);

      expect(loaded).toEqual(snapshot);
    });

    it('returns empty snapshot when file does not exist', () => {
      const loaded = loadSnapshot(tempDir);

      expect(loaded.tables).toEqual({});
    });

    it('throws a descriptive error when snapshot file is corrupt', () => {
      const snapshotPath = path.join(tempDir, '_snapshot.json');
      fs.writeFileSync(snapshotPath, '{ not valid json', 'utf-8');

      expect(() => loadSnapshot(tempDir)).toThrow(/Failed to parse snapshot at/);
      expect(() => loadSnapshot(tempDir)).toThrow(/appears corrupt/);
    });

    it('creates directory if it does not exist', () => {
      const nestedDir = path.join(tempDir, 'nested', 'dir');
      const snapshot = createEmptySnapshot();

      saveSnapshot(nestedDir, snapshot);

      expect(fs.existsSync(path.join(nestedDir, '_snapshot.json'))).toBe(true);
    });
  });

  describe('loadMigrationFiles', () => {
    it('loads SQL files sorted by name', () => {
      fs.writeFileSync(
        path.join(tempDir, '002_second.sql'),
        'CREATE TABLE posts (id TEXT);'
      );
      fs.writeFileSync(
        path.join(tempDir, '001_first.sql'),
        'CREATE TABLE users (id TEXT);\nCREATE INDEX idx_users ON users(id);'
      );

      const migrations = loadMigrationFiles(tempDir);

      expect(Array.from(migrations.keys())).toEqual(['001_first', '002_second']);
      // Each file returns an array of chunks, each chunk is an array of statements
      expect(migrations.get('001_first')).toEqual([
        ['CREATE TABLE users (id TEXT)', 'CREATE INDEX idx_users ON users(id)'],
      ]);
      expect(migrations.get('002_second')).toEqual([
        ['CREATE TABLE posts (id TEXT)'],
      ]);
    });

    it('ignores comment lines', () => {
      fs.writeFileSync(
        path.join(tempDir, '001_test.sql'),
        '-- This is a comment\n\nCREATE TABLE users (id TEXT);'
      );

      const migrations = loadMigrationFiles(tempDir);

      expect(migrations.get('001_test')).toEqual([
        ['CREATE TABLE users (id TEXT)'],
      ]);
    });

    it('returns empty map for non-existent directory', () => {
      const migrations = loadMigrationFiles('/nonexistent/dir');

      expect(migrations.size).toBe(0);
    });

    it('handles multi-statement migrations', () => {
      fs.writeFileSync(
        path.join(tempDir, '001_multi.sql'),
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
CREATE INDEX idx_posts_user ON posts(user_id);`
      );

      const migrations = loadMigrationFiles(tempDir);
      const chunks = migrations.get('001_multi');

      // Should have 1 chunk with 3 statements
      expect(chunks).toHaveLength(1);
      expect(chunks![0]).toHaveLength(3);
    });

    it('handles empty SQL files gracefully', () => {
      fs.writeFileSync(path.join(tempDir, '001_empty.sql'), '');

      const migrations = loadMigrationFiles(tempDir);

      // Empty files are not added to the map
      expect(migrations.has('001_empty')).toBe(false);
    });

    it('handles SQL files with only comments', () => {
      fs.writeFileSync(
        path.join(tempDir, '001_comments.sql'),
        '-- Comment 1\n-- Comment 2\n\n'
      );

      const migrations = loadMigrationFiles(tempDir);

      // Files with only comments are not added to the map
      expect(migrations.has('001_comments')).toBe(false);
    });
  });
});

// ============================================================================
// Rename resolution (generateMigrationStatements)
// ============================================================================

describe('generateMigrationStatements rename resolution', () => {
  const columns = { id: text().primaryKey() };

  async function renameDiff() {
    const prev = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...columns, description: text().notNull(), price: integer() }),
    });
    const cur = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...columns, summary: text().notNull(), price: integer() }),
    });
    return { prev, cur };
  }

  /** Apply the "before" table with a row, then the statements; return the rows. */
  async function applyWithRow(prev: Snapshot, statements: string[]) {
    const { default: Database } = (await import('libsql')) as any;
    const db = new Database(':memory:');
    for (const stmt of await generateMigrationStatements(createEmptySnapshot(), prev)) db.exec(stmt);
    db.exec("INSERT INTO products (id, description, price) VALUES ('p1', 'A widget', 100)");
    for (const stmt of statements) db.exec(stmt);
    const rows = db.prepare('SELECT * FROM products').all();
    db.close();
    return rows;
  }

  it('throws SchemaRenameRequiredError instead of drizzle-kit\'s TTY error when it cannot prompt', async () => {
    const { prev, cur } = await renameDiff();
    const error = await generateMigrationStatements(prev, cur, { interactive: false }).catch((e) => e);
    expect(error).toBeInstanceOf(SchemaRenameRequiredError);
    expect(error.ambiguities).toEqual([
      { kind: 'column', table: 'products', created: ['summary'], deleted: ['description'] },
    ]);
    expect(error.message).not.toContain('Interactive prompts require a TTY terminal (process.stdin');
  });

  it('applies a --rename answer without asking, keeping the data', async () => {
    const { prev, cur } = await renameDiff();
    const statements = await generateMigrationStatements(prev, cur, {
      renames: ['products.description=summary'],
      interactive: false,
    });
    expect(statements).toEqual(['ALTER TABLE `products` RENAME COLUMN "description" TO "summary";']);
    expect(await applyWithRow(prev, statements)).toEqual([{ id: 'p1', summary: 'A widget', price: 100 }]);
  });

  it('answers every question with create + drop under noRenames', async () => {
    const prev = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...columns, description: text(), price: integer() }),
    });
    const cur = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...columns, summary: text(), price: integer() }),
    });
    const statements = await generateMigrationStatements(prev, cur, { noRenames: true, interactive: false });
    expect(statements.join('\n')).toContain('DROP COLUMN `description`');
    expect(statements.join('\n')).toContain('ADD `summary` text');
    expect(await applyWithRow(prev, statements)).toEqual([{ id: 'p1', price: 100, summary: null }]);
  });

  it('leaves unambiguous diffs to drizzle-kit untouched', async () => {
    const prev = await generateSnapshotFromSchema({ products: sqliteTable('products', { ...columns }) });
    const cur = await generateSnapshotFromSchema({
      products: sqliteTable('products', { ...columns, note: text() }),
    });
    expect(await generateMigrationStatements(prev, cur, { interactive: false })).toEqual([
      'ALTER TABLE `products` ADD `note` text;',
    ]);
  });
});
