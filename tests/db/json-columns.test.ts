import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { table, text, integer, blob } from '../../src/schema';
import { defineDatabase } from '../../src/db/defineDatabase';
import { createTestDatabase, type TestDatabase } from '../../src/testing';

// `meta` is a plain text column of authors and a JSON column of documents: the
// same name, and only one of them is JSON.
const authors = table('authors', {
  id: text().primaryKey(),
  name: text().notNull(),
  meta: text(),
});

const documents = table('documents', {
  id: text().primaryKey(),
  title: text().notNull(),
  authorId: text().references(() => authors.id),
  meta: text({ mode: 'json' }),
  // camelCase: `meta_data` in SQLite.
  metaData: text({ mode: 'json' }),
  tags: text({ mode: 'json' })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  // JSON stored as a blob: the UTF-8 bytes of the same text.
  packed: blob({ mode: 'json' }),
  raw: blob(),
  createdAt: integer({ mode: 'timestamp' }),
});

const schema = { authors, documents };
const { related } = defineDatabase({ schema });

let t: TestDatabase<any>;
beforeEach(async () => {
  t = await createTestDatabase({ schema });
  await t.db
    .insertInto('authors')
    .values([
      { id: 'a1', name: 'Ada', meta: '{"plain":"text"}' },
      { id: 'a2', name: 'Grace', meta: null },
    ])
    .execute();
});
afterEach(() => t.destroy());

/** What SQLite holds, past every plugin. */
const stored = (sqlText: string) => t.sqlite.prepare(sqlText).all() as Record<string, unknown>[];

describe('a JSON-mode column', () => {
  it('is written as JSON and read back as its value', async () => {
    await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', meta: { a: 1, nested: { list: [1, 'two', null] } }, metaData: ['x', 'y'] })
      .execute();

    expect(stored('select meta, meta_data, tags, typeof(meta) as kind from documents')).toEqual([
      { meta: '{"a":1,"nested":{"list":[1,"two",null]}}', meta_data: '["x","y"]', tags: '[]', kind: 'text' },
    ]);
    const row = await t.db.selectFrom('documents').select(['meta', 'metaData', 'tags']).executeTakeFirstOrThrow();
    expect(row).toEqual({ meta: { a: 1, nested: { list: [1, 'two', null] } }, metaData: ['x', 'y'], tags: [] });
  });

  it('keeps a string a string, a number a number and null null', async () => {
    await t.db
      .insertInto('documents')
      .values([
        { id: 'text', title: 't', meta: 'hello', metaData: '123' },
        { id: 'number', title: 't', meta: 42, metaData: false },
        { id: 'nothing', title: 't', meta: null },
      ])
      .execute();

    // A string is stored as JSON too: read back, "123" is still a string.
    expect(stored("select meta, meta_data from documents where id = 'text'")).toEqual([{ meta: '"hello"', meta_data: '"123"' }]);
    const rows = await t.db.selectFrom('documents').select(['id', 'meta', 'metaData']).orderBy('id').execute();
    expect(rows).toEqual([
      { id: 'nothing', meta: null, metaData: null },
      { id: 'number', meta: 42, metaData: false },
      { id: 'text', meta: 'hello', metaData: '123' },
    ]);
  });

  it('writes a Date inside it as its ISO string', async () => {
    await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', meta: { at: new Date('2026-01-02T03:04:05.000Z') }, createdAt: new Date('2026-05-06T07:08:09.000Z') })
      .execute();

    const row = await t.db.selectFrom('documents').select(['meta', 'createdAt']).executeTakeFirstOrThrow();
    expect(row.meta).toEqual({ at: '2026-01-02T03:04:05.000Z' });
    // The timestamp column next to it is a Date as before.
    expect(row.createdAt).toEqual(new Date('2026-05-06T07:08:09.000Z'));
  });

  it('is written by an update, an upsert and a returning', async () => {
    const inserted = await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', meta: { v: 1 }, tags: ['new'] })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(inserted).toMatchObject({ id: 'd1', meta: { v: 1 }, metaData: null, tags: ['new'] });

    const updated = await t.db
      .updateTable('documents')
      .set({ meta: { v: 2 }, metaData: { camel: true } })
      .where('id', '=', 'd1')
      .returning(['meta', 'metaData as data'])
      .executeTakeFirstOrThrow();
    expect(updated).toEqual({ meta: { v: 2 }, data: { camel: true } });

    // An aliased table and a qualified column.
    await t.db.updateTable('documents as d').set({ tags: ['a', 'b'] }).where('d.id', '=', 'd1').execute();

    const upserted = await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'Again', meta: { v: 3 } })
      .onConflict((oc) => oc.column('id').doUpdateSet({ meta: { v: 4 }, title: 'Again' }))
      .returning(['title', 'meta', 'tags'])
      .executeTakeFirstOrThrow();
    expect(upserted).toEqual({ title: 'Again', meta: { v: 4 }, tags: ['a', 'b'] });
    expect(stored('select meta, meta_data, tags from documents')).toEqual([{ meta: '{"v":4}', meta_data: '{"camel":true}', tags: '["a","b"]' }]);
  });

  it('is read under an alias, by selectAll and through a join', async () => {
    await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', authorId: 'a1', meta: { v: 1 }, metaData: { camel: true } })
      .execute();

    expect(await t.db.selectFrom('documents').select(['meta as m', 'documents.metaData as other']).executeTakeFirstOrThrow()).toEqual({
      m: { v: 1 },
      other: { camel: true },
    });
    expect(await t.db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()).toMatchObject({ meta: { v: 1 }, metaData: { camel: true }, tags: [] });
    expect(await t.db.selectFrom('documents as d').selectAll('d').executeTakeFirstOrThrow()).toMatchObject({ meta: { v: 1 }, metaData: { camel: true } });

    // `meta` of the document is JSON; the author's is text that only looks like it.
    const joined = await t.db
      .selectFrom('documents as d')
      .innerJoin('authors as a', 'a.id', 'd.authorId')
      .select(['d.meta', 'a.meta as authorMeta', 'd.tags'])
      .executeTakeFirstOrThrow();
    expect(joined).toEqual({ meta: { v: 1 }, authorMeta: '{"plain":"text"}', tags: [] });

    // Selected from the author alone it stays the text it is.
    expect(await t.db.selectFrom('authors').select('meta').where('id', '=', 'a1').executeTakeFirstOrThrow()).toEqual({ meta: '{"plain":"text"}' });
    expect(await t.db.selectFrom('authors').selectAll().where('id', '=', 'a1').executeTakeFirstOrThrow()).toMatchObject({ meta: '{"plain":"text"}' });
  });

  it('leaves a plain column of the same name alone on write', async () => {
    await t.db.insertInto('authors').values({ id: 'a3', name: 'Lin', meta: 'just text' }).execute();
    await t.db.updateTable('authors').set({ meta: 'other text' }).where('id', '=', 'a3').execute();
    expect(stored("select meta from authors where id = 'a3'")).toEqual([{ meta: 'other text' }]);
  });

  it('is read from a raw query by its name, unless another table has a plain column of that name', async () => {
    await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', meta: { v: 1 }, metaData: { camel: true }, tags: ['a'] })
      .execute();

    const { rows } = await sql<Record<string, unknown>>`select meta, meta_data, tags from documents`.execute(t.db);
    // `meta` is plain text in authors: a raw query does not say which one it reads.
    expect(rows).toEqual([{ meta: '{"v":1}', metaData: { camel: true }, tags: ['a'] }]);
  });

  it('answers text that is no JSON as it is', async () => {
    t.sqlite.exec("insert into documents (id, title, meta, tags) values ('legacy', 'Old', 'not json', '[]')");
    expect(await t.db.selectFrom('documents').select('meta').executeTakeFirstOrThrow()).toEqual({ meta: 'not json' });
  });

  it('stores its JSON as bytes in a blob column', async () => {
    await t.db
      .insertInto('documents')
      .values({ id: 'd1', title: 'One', packed: { å: 'ö', n: [1, 2] } })
      .execute();

    expect(stored('select typeof(packed) as kind, cast(packed as text) as json from documents')).toEqual([{ kind: 'blob', json: '{"å":"ö","n":[1,2]}' }]);
    expect(await t.db.selectFrom('documents').select('packed').executeTakeFirstOrThrow()).toEqual({ packed: { å: 'ö', n: [1, 2] } });

    await t.db.updateTable('documents').set({ packed: ['replaced'] }).execute();
    expect(await t.db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()).toMatchObject({ packed: ['replaced'] });
  });

  it('is read through a relation', async () => {
    await t.db
      .insertInto('documents')
      .values([
        { id: 'd1', title: 'One', authorId: 'a1', meta: { v: 1 }, metaData: 'a string', tags: ['a'] },
        { id: 'd2', title: 'Two', authorId: 'a1', meta: null },
      ])
      .execute();

    const author = await t.db
      .selectFrom('authors')
      .select(['id', 'meta', related('authors', 'documents', { columns: ['id', 'meta', 'metaData', 'tags'], orderBy: { id: 'asc' } })])
      .where('id', '=', 'a1')
      .executeTakeFirstOrThrow();
    expect(author).toEqual({
      id: 'a1',
      meta: '{"plain":"text"}',
      documents: [
        { id: 'd1', meta: { v: 1 }, metaData: 'a string', tags: ['a'] },
        { id: 'd2', meta: null, metaData: null, tags: [] },
      ],
    });

    // The other way: the document's JSON at the top, the author's text inside.
    const document = await t.db
      .selectFrom('documents')
      .select(['meta', related('documents', 'author', ['name', 'meta'])])
      .where('id', '=', 'd1')
      .executeTakeFirstOrThrow();
    expect(document).toEqual({ meta: { v: 1 }, author: { name: 'Ada', meta: '{"plain":"text"}' } });
  });
});

describe('a blob parameter', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);

  it('is bound from a Uint8Array and from an ArrayBuffer, and answered as an ArrayBuffer', async () => {
    await t.db
      .insertInto('documents')
      .values([
        { id: 'view', title: 't', raw: bytes },
        { id: 'buffer', title: 't', raw: bytes.buffer.slice(1, 4) },
      ])
      .execute();

    expect(stored('select id, typeof(raw) as kind, hex(raw) as hex from documents order by id')).toEqual([
      { id: 'buffer', kind: 'blob', hex: '0102FA' },
      { id: 'view', kind: 'blob', hex: '000102FAFF' },
    ]);

    const rows = await t.db.selectFrom('documents').select(['id', 'raw']).orderBy('id').execute();
    expect(rows.map((row) => row.raw instanceof ArrayBuffer)).toEqual([true, true]);
    expect(rows.map((row) => [...new Uint8Array(row.raw as ArrayBuffer)])).toEqual([
      [1, 2, 250],
      [0, 1, 2, 250, 255],
    ]);
  });

  it('is bound in a where and an update', async () => {
    await t.db.insertInto('documents').values({ id: 'd1', title: 't', raw: bytes }).execute();
    await t.db.updateTable('documents').set({ raw: new Uint8Array([9, 8]) }).where('raw', '=', bytes).execute();
    expect(stored('select hex(raw) as hex from documents')).toEqual([{ hex: '0908' }]);
  });
});
