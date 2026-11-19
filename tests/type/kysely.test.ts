import { describe, expectTypeOf, it } from 'vitest';
import type { Kyselify } from 'drizzle-orm/kysely';
import { sql } from 'drizzle-orm';
import type { Insertable, Selectable, Updateable } from 'kysely';
import { integer, real, table, text } from '../../src/schema';
import type { DrizzleToKysely } from '../../src/db/types';

// What an action's `db` reads and writes: the lean mapping says of every kind
// of column what drizzle-orm's `Kyselify` says — the same row selected, the
// same values inserted and updated. These hold when `tsc -p tests/type/tsconfig.json` passes.

interface Address {
  street: string;
  city: string;
}

const everything = table('everything', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  note: text(),
  count: integer().notNull().default(0),
  flagged: integer({ mode: 'boolean' }).notNull().default(false),
  maybe: integer({ mode: 'boolean' }),
  at: integer({ mode: 'timestamp' }).notNull(),
  seenAt: integer({ mode: 'timestamp_ms' }),
  address: text({ mode: 'json' }).$type<Address>(),
  ratio: real().notNull(),
  made: text().notNull().$defaultFn(() => 'now'),
  status: text({ enum: ['open', 'paid'] }).notNull(),
  legacyName: text('legacy_name'),
  upper: text().generatedAlwaysAs(sql`upper(name)`),
});

type Ours = DrizzleToKysely<{ everything: typeof everything }>['everything'];
type Drizzles = Kyselify<typeof everything>;

describe('DrizzleToKysely', () => {
  it('selects what drizzle-orm’s Kyselify selects', () => {
    expectTypeOf<Selectable<Ours>>().toEqualTypeOf<Selectable<Drizzles>>();
  });

  it('inserts what it inserts — a default, a nullable column, an autoincrement key optional, a generated one never', () => {
    expectTypeOf<Insertable<Ours>>().toEqualTypeOf<Insertable<Drizzles>>();
  });

  it('updates what it updates', () => {
    expectTypeOf<Updateable<Ours>>().toEqualTypeOf<Updateable<Drizzles>>();
  });

  it('names a column as the database does', () => {
    expectTypeOf<keyof Ours>().toEqualTypeOf<keyof Drizzles>();
  });
});
