// A foreign key is a relation. This module reads the ones a schema declares —
// `.references(() => customers.id)` on a column — and names them in both
// directions: `invoices.customer` (one) and `customers.invoices` (many).
// Nothing is declared twice: the types (`Relations<Schema>`) come from the
// column types `src/schema.ts` keeps the target on, the runtime registry
// (`relationsOf(schema)`) from the foreign keys Drizzle holds, and the two
// agree on every name.
//
// Names:
// - forward (one): the column's property without a trailing `Id` / `_id`
//   (`customerId` → `customer`);
// - inverse (many): the schema key of the table that holds the foreign key
//   (`invoices`); when that table points at the same target more than once,
//   `<key>As<Forward>` each (`invoicesAsCustomer`, `invoicesAsReferee`).
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = Record<string, SQLiteTableWithColumns<any>>;

// ── Types ──────────────────────────────────────────────────────────────

type RefOf<Col> = Col extends { _: { references: infer C } } ? C : never;
type TableNameOf<Col> = Col extends { _: { tableName: infer N } } ? N : never;
type ColumnsOf<T> = T extends { _: { columns: infer C } } ? C : never;
type NameOf<T> = T extends { _: { name: infer N } } ? N : never;
type KeyOf<S, Name> = { [K in keyof S & string]: NameOf<S[K]> extends Name ? K : never }[keyof S & string];

// The schema key a column points at. Never for a column without a reference,
// for one whose target the types do not know (`(): AnySQLiteColumn => …`, the
// escape a self reference needs) and for a table outside the schema.
type TargetOf<S, Col> = [RefOf<Col>] extends [never]
  ? never
  : string extends TableNameOf<RefOf<Col>>
    ? never
    : KeyOf<S, TableNameOf<RefOf<Col>>>;

/** Every foreign key of a schema the types know: the table and column that hold it, the table it points at. */
type Edge<S> = {
  [TK in keyof S & string]: {
    [CK in keyof ColumnsOf<S[TK]> & string]: [TargetOf<S, ColumnsOf<S[TK]>[CK]>] extends [never]
      ? never
      : {
          table: TK;
          column: CK;
          target: TargetOf<S, ColumnsOf<S[TK]>[CK]>;
          nullable: ColumnsOf<S[TK]>[CK] extends { _: { notNull: true } } ? false : true;
        };
  }[keyof ColumnsOf<S[TK]> & string];
}[keyof S & string];

type AnyEdge = { table: string; column: string; target: string; nullable: boolean };

type ForwardName<K extends string> = K extends `${infer P}Id`
  ? P extends ''
    ? K
    : P
  : K extends `${infer P}_id`
    ? P extends ''
      ? K
      : P
    : K;

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends unknown ? ([U] extends [T] ? false : true) : never;

type InverseName<S, E extends AnyEdge> =
  IsUnion<Extract<Edge<S>, { table: E['table']; target: E['target'] }>> extends true
    ? `${E['table']}As${Capitalize<ForwardName<E['column']>>}`
    : E['table'];

/** A relation as the types describe it. */
export type RelationType =
  | { kind: 'one'; target: string; nullable: boolean }
  | { kind: 'many'; target: string };

type Forward<S, TK> = {
  [E in Extract<Edge<S>, { table: TK }> as ForwardName<E['column']>]: { kind: 'one'; target: E['target']; nullable: E['nullable'] };
};

type Inverse<S, TK> = {
  [E in Extract<Edge<S>, { target: TK }> as InverseName<S, E>]: { kind: 'many'; target: E['table'] };
};

/**
 * The relations of a schema, per table: what its foreign keys say, in both
 * directions.
 *
 * ```ts
 * type R = Relations<typeof schema>;
 * // R['invoices']['customer']  → { kind: 'one'; target: 'customers'; nullable: false }
 * // R['customers']['invoices'] → { kind: 'many'; target: 'invoices' }
 * ```
 */
export type Relations<S> = {
  [TK in keyof S & string]: { [N in keyof (Forward<S, TK> & Inverse<S, TK>)]: (Forward<S, TK> & Inverse<S, TK>)[N] };
};

// ── Runtime ────────────────────────────────────────────────────────────

/** A relation as the runtime knows it. Tables are schema keys, columns their properties. */
export interface Relation {
  kind: 'one' | 'many';
  name: string;
  /** The table that has the relation. */
  table: string;
  /** The table it leads to. */
  target: string;
  /** The column of `table` the relation is matched on: the foreign key of a `one`, the referenced column of a `many`. */
  local: string;
  /** The column of `target` it matches. */
  foreign: string;
  /** A `one` whose foreign key may be null. Always false for a `many`. */
  nullable: boolean;
}

/** `relations[table][name]`. */
export type RelationMap = Record<string, Record<string, Relation>>;

interface Registry {
  relations: RelationMap;
  /** Names two relations of a table both claim: `table` → `name` → what claims it. */
  conflicts: Map<string, Map<string, string[]>>;
}

const registries = new WeakMap<object, Registry>();

function forwardName(column: string): string {
  if (column.length > 2 && column.endsWith('Id')) return column.slice(0, -2);
  if (column.length > 3 && column.endsWith('_id')) return column.slice(0, -3);
  return column;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function propertyOf(table: object, column: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [property, candidate] of Object.entries(getTableColumns(table as any))) {
    if (candidate === column) return property;
  }
  return undefined;
}

function build(schema: AnySchema): Registry {
  const keys = new Map<unknown, string>();
  for (const [key, table] of Object.entries(schema)) keys.set(table, key);

  // The foreign keys that are relations: one column, between two tables of the schema.
  interface Found {
    table: string;
    column: string;
    target: string;
    foreign: string;
    nullable: boolean;
  }
  const found: Found[] = [];
  for (const [key, table] of Object.entries(schema)) {
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const { columns, foreignTable, foreignColumns } = foreignKey.reference();
      if (columns.length !== 1 || foreignColumns.length !== 1) continue;
      const target = keys.get(foreignTable);
      const column = propertyOf(table, columns[0]);
      const foreign = target === undefined ? undefined : propertyOf(foreignTable, foreignColumns[0]);
      if (target === undefined || column === undefined || foreign === undefined) continue;
      found.push({ table: key, column, target, foreign, nullable: !columns[0]!.notNull });
    }
  }

  const registry: Registry = { relations: {}, conflicts: new Map() };
  for (const key of Object.keys(schema)) registry.relations[key] = {};
  const claims = new Map<string, string>();

  const add = (relation: Relation, from: string) => {
    const claim = `${relation.table}.${relation.name}`;
    const earlier = claims.get(claim);
    if (earlier === undefined) {
      claims.set(claim, from);
      registry.relations[relation.table]![relation.name] = relation;
      return;
    }
    // Neither gets the name: which one is meant cannot be told.
    delete registry.relations[relation.table]![relation.name];
    let ofTable = registry.conflicts.get(relation.table);
    if (!ofTable) registry.conflicts.set(relation.table, (ofTable = new Map()));
    const claimed = ofTable.get(relation.name) ?? [earlier];
    claimed.push(from);
    ofTable.set(relation.name, claimed);
  };

  for (const edge of found) {
    const from = `${edge.table}.${edge.column} → ${edge.target}.${edge.foreign}`;
    const forward = forwardName(edge.column);
    add({ kind: 'one', name: forward, table: edge.table, target: edge.target, local: edge.column, foreign: edge.foreign, nullable: edge.nullable }, from);

    const siblings = found.filter((other) => other.table === edge.table && other.target === edge.target).length;
    const inverse = siblings > 1 ? `${edge.table}As${capitalize(forward)}` : edge.table;
    add({ kind: 'many', name: inverse, table: edge.target, target: edge.table, local: edge.foreign, foreign: edge.column, nullable: false }, from);
  }
  return registry;
}

function registryOf(schema: AnySchema): Registry {
  let registry = registries.get(schema);
  if (!registry) registries.set(schema, (registry = build(schema)));
  return registry;
}

/**
 * The relations a schema's foreign keys declare, per table. Read the first
 * time it is asked for (a foreign key's target is a callback, so every table
 * of the schema exists by then) and kept.
 */
export function relationsOf(schema: AnySchema): RelationMap {
  return registryOf(schema).relations;
}

/** One relation of a table, or an error that says what there is. */
export function relationOf(schema: AnySchema, table: string, name: string): Relation {
  const registry = registryOf(schema);
  const ofTable = registry.relations[table];
  if (!ofTable) {
    throw new Error(`[durable-db] "${table}" is not a table of this database's schema (its tables: ${Object.keys(schema).join(', ') || 'none'}).`);
  }
  const relation = ofTable[name];
  if (relation) return relation;
  const claimed = registry.conflicts.get(table)?.get(name);
  if (claimed) {
    throw new Error(
      `[durable-db] "${table}" has ${claimed.length} relations that would be named "${name}" (${claimed.join('; ')}): rename a column so each gets a name of its own.`,
    );
  }
  const names = Object.keys(ofTable);
  throw new Error(
    `[durable-db] "${table}" has no relation "${name}". ` +
      (names.length > 0
        ? `Its relations: ${names.join(', ')}.`
        : 'No foreign key leads to or from it: a relation is a column with .references(() => other.column).'),
  );
}
