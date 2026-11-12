// Reading along a relation, in the query that reads the row.
//
//   db.selectFrom('invoices')
//     .select(['invoices.id', 'invoices.number'])
//     .select([
//       related('invoices', 'customer', ['id', 'name']),
//       related('invoices', 'invoiceLines', { columns: ['id', 'description'], orderBy: { id: 'asc' } }),
//       related('invoices', 'invoiceLines', { columns: ['id'], where: (eb) => eb('delivered', '=', false) }).as('open'),
//     ])
//
// `related()` is an expression Kysely selects like any other: a correlated
// subquery that answers the related row(s) as JSON — one query, one round to
// SQLite, however deep `with` goes. Two plugins make the answer what the types
// say: the first sees which selections are relations (before any other plugin
// rewrites the query), the last parses their JSON and revives dates and
// booleans the way the columns of the row itself are.
//
// A relation is answered under its name; `.as('name')` answers it under
// another, so one relation can be read twice (`.as('latest')` with a limit,
// next to the whole list).
//
// Opt in: a query without `related()` passes both plugins untouched.
import {
  AliasNode,
  IdentifierNode,
  OperationNodeTransformer,
  TableNode,
  expressionBuilder,
  sql,
  type AliasedExpression,
  type Expression,
  type ExpressionBuilder,
  type KyselyPlugin,
  type OperationNode,
  type QueryId,
  type RawBuilder,
  type ReferenceNode,
  type RootOperationNode,
  type Selectable,
  type SelectQueryNode,
  type SqlBool,
  type UnknownRow,
} from 'kysely';
import { getTableColumns } from 'drizzle-orm';
import { dateSerializers, parseJsonValue } from './plugins';
import { relationOf, type AnySchema, type Relation, type Relations } from './relations';
import type { DrizzleToKysely } from './types';

// ── Types ──────────────────────────────────────────────────────────────

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Row<S extends AnySchema, TK> = TK extends keyof S ? Selectable<DrizzleToKysely<S>[TK]> : never;

type TargetOf<Rel> = Rel extends { target: infer T } ? T : never;

/** What the relations in `with` add to a row: each under its name. */
type Nested<W> = W extends readonly RelatedExpression<string, string, unknown>[]
  ? { [E in W[number] as E['alias']]: E extends RelatedExpression<string, string, infer V> ? V : never }
  : {};

/** A `one` answers its row (or null, when the foreign key may be null), a `many` a list. */
type Value<Rel, Item> = Rel extends { kind: 'one'; nullable: false } ? Item : Rel extends { kind: 'one' } ? Item | null : Item[];

/**
 * Which rows of a `many` to read: a condition on the related table `TK`,
 * written with Kysely's expression builder — `(eb) => eb('quantity', '>', 0)`.
 */
export type RelatedWhere<S extends AnySchema, TK extends keyof S> = (eb: ExpressionBuilder<DrizzleToKysely<S>, TK>) => Expression<SqlBool>;

export interface RelatedOptions<C extends string, W, K extends string = C, E = ExpressionBuilder<any, any>> {
  /** The columns of the related table to read. */
  columns: readonly C[];
  /** Relations of the related table, read with each row: `related('<that table>', …)`. */
  with?: W;
  /** A `many` only: the order of its rows, first key first. */
  orderBy?: { [P in K]?: 'asc' | 'desc' };
  /** A `many` only: at most this many rows per parent. */
  limit?: number;
  /**
   * A `many` only: which of its rows — a condition on the related table, by
   * Kysely's expression builder: `(eb) => eb('quantity', '>', 0)`. Its columns
   * are named alone or after the table (`'invoiceLines.quantity'`); another
   * table is read in a subquery (`eb.exists(eb.selectFrom(…))`), which names
   * the related row's columns after the table. It applies before `limit`.
   */
  where?: (eb: E) => Expression<SqlBool>;
}

/**
 * `related(table, relation, columns)`: the rows `relation` leads to from each
 * row of `table`, as a selection.
 */
export interface Related<S extends AnySchema> {
  <
    TK extends keyof Relations<S> & string,
    R extends keyof Relations<S>[TK] & string,
    C extends keyof Row<S, TargetOf<Relations<S>[TK][R]>> & string,
  >(
    table: TK,
    relation: R,
    columns: readonly C[],
  ): RelatedExpression<TK, R, Value<Relations<S>[TK][R], Simplify<Pick<Row<S, TargetOf<Relations<S>[TK][R]>>, C>>>>;
  <
    TK extends keyof Relations<S> & string,
    R extends keyof Relations<S>[TK] & string,
    C extends keyof Row<S, TargetOf<Relations<S>[TK][R]>> & string,
    W extends readonly RelatedExpression<TargetOf<Relations<S>[TK][R]> & string, string, unknown>[] = [],
  >(
    table: TK,
    relation: R,
    options: RelatedOptions<
      C,
      W,
      keyof Row<S, TargetOf<Relations<S>[TK][R]>> & string,
      ExpressionBuilder<DrizzleToKysely<S>, TargetOf<Relations<S>[TK][R]> & keyof S>
    >,
  ): RelatedExpression<
    TK,
    R,
    Value<Relations<S>[TK][R], Simplify<Pick<Row<S, TargetOf<Relations<S>[TK][R]>>, C> & Nested<W>>>
  >;
}

/**
 * `related` for a schema whose tables are known only when the code runs (a
 * library that is handed one): the names are strings, checked against the
 * schema when it is called, and what it answers is typed by the caller.
 */
export interface AnyRelated {
  (table: string, relation: string, columns: readonly string[]): RelatedExpression<string, string, unknown>;
  (
    table: string,
    relation: string,
    options: RelatedOptions<string, readonly RelatedExpression<string, string, unknown>[]>,
  ): RelatedExpression<string, string, unknown>;
}

// ── The expression ─────────────────────────────────────────────────────

/** A relation to read, checked against the schema: what `related()` builds. */
export interface RelatedSpec {
  schema: AnySchema;
  relation: Relation;
  /** The key it is answered under: the relation's name, or what `.as()` said. */
  alias: string;
  columns: string[];
  with: RelatedSpec[];
  orderBy: [column: string, direction: 'asc' | 'desc'][];
  limit?: number;
  /** The condition `where` answered, as written: its columns are qualified when it is rendered. */
  where?: OperationNode;
}

/** What the result plugin needs to know of a selected relation. */
interface Meta {
  /** The table its rows are of: which of their values are dates and booleans. */
  target: string;
  with: Map<string, Meta>;
}

const RELATED = Symbol.for('durable-db.related');
type Marked = AliasNode & { readonly [RELATED]?: Meta };

const specs = new WeakMap<object, RelatedSpec>();

function metaOf(spec: RelatedSpec): Meta {
  return { target: spec.relation.target, with: new Map(spec.with.map((nested) => [nested.alias, metaOf(nested)])) };
}

/** The names a select reads its tables under: a table's own, or its alias. */
function namesIn(node: SelectQueryNode): Set<string> {
  const names = new Set<string>();
  const add = (source: OperationNode) => {
    if (TableNode.is(source)) names.add(source.table.identifier.name);
    else if (AliasNode.is(source) && IdentifierNode.is(source.alias)) names.add(source.alias.name);
  };
  for (const source of node.from?.froms ?? []) add(source);
  for (const join of node.joins ?? []) add(join.table);
  return names;
}

// A condition is written about the related table: its columns alone, or after
// the table's name. In the query the related rows go by an alias, so every such
// column is moved to it — also inside a subquery of the condition, where the
// table's name is how the related row is told from the subquery's own (unless
// the subquery reads that table itself, under its own name: then the name is
// the subquery's).
class Qualify extends OperationNodeTransformer {
  readonly #target: string;
  readonly #alias: string;
  readonly #where: string;
  /** How many selects of the condition's own this is inside. */
  #depth = 0;
  /** How many of those read the related table under its name. */
  #shadowed = 0;

  constructor(target: string, alias: string, where: string) {
    super();
    this.#target = target;
    this.#alias = alias;
    this.#where = where;
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const shadows = namesIn(node).has(this.#target);
    this.#depth++;
    if (shadows) this.#shadowed++;
    try {
      return super.transformSelectQuery(node, queryId);
    } finally {
      this.#depth--;
      if (shadows) this.#shadowed--;
    }
  }

  protected override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    const table = node.table?.table.identifier.name;
    const moved = table === undefined ? this.#depth === 0 : table === this.#target && this.#shadowed === 0;
    if (moved) return super.transformReference({ ...node, table: TableNode.create(this.#alias) }, queryId);
    if (table !== undefined && table !== this.#target && this.#depth === 0) {
      const column = 'column' in node.column ? node.column.column.name : '*';
      throw new TypeError(
        `${this.#where}: where is a condition on "${this.#target}", and "${table}.${column}" is of another table — read that one in a subquery: eb.exists(eb.selectFrom('${table}')…).`,
      );
    }
    return super.transformReference(node, queryId);
  }
}

const messageOf = (spec: Pick<RelatedSpec, 'relation'>) => `[durable-db] related('${spec.relation.table}', '${spec.relation.name}')`;

/** ` and (<the condition>)` about the rows that go by `alias` — or nothing. */
function filter(spec: RelatedSpec, alias: string): RawBuilder<unknown> {
  if (!spec.where) return sql``;
  const node = new Qualify(spec.relation.target, alias, messageOf(spec)).transformNode(spec.where);
  return sql` and (${{ toOperationNode: () => node }})`;
}

// `outer` is what the parent row goes by where this is selected: its table at
// the top, the parent relation's alias below. Names are the schema's (keys and
// properties): the schema plugin turns them into SQL's, like everywhere else.
// JSON keys and the limit are literals, never parameters — a Durable Object's
// SQLite takes at most 100 of those per query. The values of a `where` are
// parameters, like those of any condition.
function render(spec: RelatedSpec, outer: string, depth: number): RawBuilder<unknown> {
  const { relation } = spec;
  const row = `_r${depth}`;
  const pairs = spec.columns.map((column) => sql`${sql.lit(column)}, ${sql.ref(`${row}.${column}`)}`);
  for (const nested of spec.with) {
    // A subquery's text is text again: json() makes it the value it holds (and null of null).
    pairs.push(sql`${sql.lit(nested.alias)}, json(${render(nested, row, depth + 1)})`);
  }
  const object = sql`json_object(${sql.join(pairs)})`;
  const target = sql.table(relation.target);
  const matches = (alias: string) => sql`${sql.ref(`${alias}.${relation.foreign}`)} = ${sql.ref(`${outer}.${relation.local}`)}`;

  if (relation.kind === 'one') {
    return sql`(select ${object} from ${target} as ${sql.ref(row)} where ${matches(row)} limit 1)`;
  }
  if (spec.orderBy.length === 0 && spec.limit === undefined) {
    return sql`(select json_group_array(${object}) from ${target} as ${sql.ref(row)} where ${matches(row)}${filter(spec, row)})`;
  }
  // Ordered and cut per parent before they are gathered.
  const inner = `_s${depth}`;
  const order =
    spec.orderBy.length === 0
      ? sql``
      : sql` order by ${sql.join(spec.orderBy.map(([column, direction]) => sql`${sql.ref(`${inner}.${column}`)} ${sql.raw(direction)}`))}`;
  const limit = spec.limit === undefined ? sql`` : sql` limit ${sql.lit(spec.limit)}`;
  return sql`(select json_group_array(${object}) from (select * from ${target} as ${sql.ref(inner)} where ${matches(inner)}${filter(spec, inner)}${order}${limit}) as ${sql.ref(row)})`;
}

/**
 * A relation as a selection: what `related()` returns. `table` is the table
 * it is a relation of (so `with` takes only the related table's own), `alias`
 * the key it is answered under — the relation's name, until `.as()` says
 * another.
 */
export class RelatedExpression<TK extends string, A extends string, V> implements AliasedExpression<V, A> {
  readonly table: TK;
  readonly alias: A;

  constructor(spec: RelatedSpec) {
    this.table = spec.relation.table as TK;
    this.alias = spec.alias as A;
    specs.set(this, spec);
  }

  /**
   * The same relation, answered under `name` instead of its own:
   * `related('customers', 'invoices', { columns: ['id'], limit: 1 }).as('latest')`.
   * A new expression — this one keeps its name.
   */
  as<N extends string>(name: N): RelatedExpression<TK, N, V> {
    const spec = specs.get(this)!;
    if (typeof name !== 'string' || name === '') {
      throw new TypeError(`[durable-db] related('${spec.relation.table}', '${spec.relation.name}').as() takes the name to answer it under.`);
    }
    return new RelatedExpression<TK, N, V>({ ...spec, alias: name });
  }

  get expression(): Expression<V> {
    return render(specs.get(this)!, this.table, 1) as RawBuilder<V>;
  }

  toOperationNode(): AliasNode {
    const spec = specs.get(this)!;
    const node = AliasNode.create(render(spec, this.table, 1).toOperationNode(), IdentifierNode.create(this.alias));
    // The mark the first plugin reads: Kysely keeps this very node in the query it hands the plugins.
    const marked: Marked = { ...node, [RELATED]: metaOf(spec) };
    return Object.freeze(marked);
  }
}

// ── related() ──────────────────────────────────────────────────────────

// Everything a relation is rendered from is checked here, when `related()` is
// called: a name that reaches the SQL is a relation, a table or a column of
// the schema, a direction is one of two words, a limit a number and a
// condition one about the related table.
function specOf(schema: AnySchema, table: string, name: string, arg: unknown): RelatedSpec {
  const relation = relationOf(schema, table, name);
  const where = messageOf({ relation });
  const options = (Array.isArray(arg) ? { columns: arg } : arg) as Partial<RelatedOptions<string, unknown>> | null | undefined;
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${where} takes the columns to read: ['id', …], or { columns, with, orderBy, limit, where }.`);
  }

  const known = getTableColumns(schema[relation.target]!);
  const column = (key: unknown, what: string): string => {
    if (typeof key !== 'string' || !Object.hasOwn(known, key)) {
      throw new TypeError(`${where}: ${what} "${String(key)}" is not a column of "${relation.target}". Its columns: ${Object.keys(known).join(', ')}.`);
    }
    return key;
  };

  if (options.columns !== undefined && !Array.isArray(options.columns)) throw new TypeError(`${where}: columns is a list of column names.`);
  const columns = [...new Set((options.columns ?? []).map((key) => column(key, 'the column')))];
  for (const key of columns) {
    if (known[key]!.getSQLType() === 'blob') {
      throw new TypeError(`${where}: "${key}" is a blob, and a relation is read as JSON, which holds none — read it in a query of its own.`);
    }
  }

  const nested = options.with ?? [];
  if (!Array.isArray(nested)) throw new TypeError(`${where}: with is a list of relations: [related('${relation.target}', …)].`);
  const names = new Set(columns);
  const inner: RelatedSpec[] = [];
  for (const item of nested) {
    const spec = item instanceof RelatedExpression ? specs.get(item) : undefined;
    if (!spec) throw new TypeError(`${where}: with is a list of relations: [related('${relation.target}', …)].`);
    if (spec.schema !== schema || spec.relation.table !== relation.target) {
      const other = spec.schema === schema ? '' : ' of another database';
      throw new TypeError(
        `${where}: with takes relations of "${relation.target}", and "${spec.relation.name}" is one of "${spec.relation.table}"${other}.`,
      );
    }
    // By the key each is answered under: a relation may be there twice under two names (`.as()`).
    if (names.has(spec.alias)) {
      throw new TypeError(`${where}: "${spec.alias}" is there twice — as a column and a relation, or two relations under one name.`);
    }
    names.add(spec.alias);
    inner.push(spec);
  }
  if (names.size === 0) throw new TypeError(`${where} reads nothing: name the columns to read.`);

  const orderBy: RelatedSpec['orderBy'] = [];
  for (const [key, direction] of Object.entries(options.orderBy ?? {})) {
    if (direction === undefined) continue;
    if (direction !== 'asc' && direction !== 'desc') throw new TypeError(`${where}: orderBy.${key} is 'asc' or 'desc'.`);
    orderBy.push([column(key, 'orderBy'), direction]);
  }
  const { limit } = options;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError(`${where}: limit is a whole number, 0 or more.`);
  // A condition on the one row a foreign key leads to would make a relation that is always there one that may not be.
  if (relation.kind === 'one' && (orderBy.length > 0 || limit !== undefined || options.where !== undefined)) {
    throw new TypeError(`${where} leads to one row: orderBy, limit and where are for a relation that leads to many.`);
  }

  let condition: OperationNode | undefined;
  if (options.where !== undefined) {
    const example = `where: (eb) => eb('<column>', '=', value)`;
    if (typeof options.where !== 'function') throw new TypeError(`${where}: where is a function that answers a condition — ${example}`);
    const answered: unknown = options.where(expressionBuilder());
    if (typeof answered !== 'object' || answered === null || typeof (answered as Expression<unknown>).toOperationNode !== 'function') {
      throw new TypeError(`${where}: where answers a condition — ${example}`);
    }
    condition = (answered as Expression<unknown>).toOperationNode();
    // Checked now, like the names above; the alias its columns move to is known when it is rendered.
    new Qualify(relation.target, relation.target, where).transformNode(condition);
  }

  return { schema, relation, alias: relation.name, columns, with: inner, orderBy, limit, where: condition };
}

/**
 * `related` for a schema: what `defineDatabase()` hands out, and the way to
 * it for code that is handed a schema — typed by the schema's tables, or by
 * strings (`AnyRelated`) when its type names none.
 */
export function createRelated<S extends AnySchema>(schema: S): string extends keyof S ? AnyRelated : Related<S> {
  const related = (table: string, relation: string, arg: unknown) => new RelatedExpression(specOf(schema, table, relation, arg));
  return related as unknown as string extends keyof S ? AnyRelated : Related<S>;
}

// ── The plugins ────────────────────────────────────────────────────────

function isMarked(node: unknown): node is Marked & { readonly [RELATED]: Meta } {
  return typeof node === 'object' && node !== null && (node as Marked)[RELATED] !== undefined;
}

/** The relations among what a query selects (or returns): each by the key its rows carry it under. */
function relationsIn(node: RootOperationNode): Map<string, Meta> | undefined {
  const root = node as { selections?: readonly OperationNode[]; returning?: { selections?: readonly OperationNode[] } };
  let found: Map<string, Meta> | undefined;
  for (const item of [...(root.selections ?? []), ...(root.returning?.selections ?? [])]) {
    const selected = (item as { selection?: unknown }).selection;
    if (!isMarked(selected)) continue;
    found ??= new Map();
    found.set((selected.alias as IdentifierNode).name, selected[RELATED]);
  }
  return found;
}

// As the boolean plugin reads a column of the row itself.
function toBoolean(value: unknown): unknown {
  if (typeof value === 'number') return value !== 0;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
}

/**
 * The two plugins behind `related()`. `capture` goes first — it reads the
 * query as the builder made it, marks and all — and `results` last, when the
 * row's keys are the schema's again.
 */
export function createRelatedPlugins(
  schema: AnySchema,
  options: {
    /**
     * The key a result row has for a name a query writes: SchemaPlugin's
     * `resultKey` when the names are camelCased. Default: the name itself.
     */
    resultKey?: (name: string) => string;
  } = {},
): { capture: KyselyPlugin; results: KyselyPlugin } {
  const resultKey = options.resultKey ?? ((name: string) => name);
  const selected = new WeakMap<QueryId, Map<string, Meta>>();
  const kinds = new Map<string, { dates: Set<string>; booleans: Set<string>; jsons: Set<string> }>();

  const kindsOf = (table: string) => {
    let kind = kinds.get(table);
    if (!kind) {
      kind = { dates: new Set(), booleans: new Set(), jsons: new Set() };
      const target = schema[table];
      const columns: Record<string, { dataType: string }> = target ? getTableColumns(target) : {};
      for (const [key, column] of Object.entries(columns)) {
        if (column.dataType === 'date') kind.dates.add(key);
        else if (column.dataType === 'boolean') kind.booleans.add(key);
        else if (column.dataType === 'json') kind.jsons.add(key);
      }
      kinds.set(table, kind);
    }
    return kind;
  };

  const revive = (value: unknown, meta: Meta): unknown => {
    if (Array.isArray(value)) return value.map((item) => revive(item, meta));
    if (typeof value !== 'object' || value === null) return value;
    const { dates, booleans, jsons } = kindsOf(meta.target);
    const row = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(row)) {
      const nested = meta.with.get(key);
      if (nested) row[key] = revive(item, nested);
      else if (dates.has(key)) {
        if (typeof item === 'string' && dateSerializers.isSerializedDateString(item)) row[key] = dateSerializers.deserialize(item);
      } else if (booleans.has(key)) row[key] = toBoolean(item);
      // A JSON-mode column is text to SQLite: inside the relation's JSON it is a string of JSON.
      else if (jsons.has(key)) row[key] = parseJsonValue(item);
    }
    return row;
  };

  const capture: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const found = relationsIn(node);
      if (found) selected.set(queryId, found);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  const results: KyselyPlugin = {
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result, queryId }) {
      const relations = selected.get(queryId);
      if (!relations) return result;
      const rows = result.rows.map((row): UnknownRow => {
        const out: UnknownRow = { ...row };
        for (const [alias, meta] of relations) {
          // Answered under the name as written, whatever the other plugins made of it
          // (`line_items` comes back from the camelCasing as `lineItems`).
          const key = resultKey(alias);
          if (key !== alias && Object.hasOwn(out, key)) {
            out[alias] = out[key];
            delete out[key];
          }
          const raw = out[alias];
          // Null is a `one` that leads nowhere; anything else is the subquery's JSON.
          if (typeof raw === 'string') out[alias] = revive(JSON.parse(raw), meta);
        }
        return out;
      });
      return { ...result, rows };
    },
  };

  return { capture, results };
}
