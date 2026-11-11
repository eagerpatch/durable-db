import {
  AliasNode,
  CamelCasePlugin,
  ColumnNode,
  ColumnUpdateNode,
  DeleteQueryNode,
  IdentifierNode,
  InsertQueryNode,
  PrimitiveValueListNode,
  ReferenceNode,
  SelectAllNode,
  SelectQueryNode,
  TableNode,
  UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  sql,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow
} from 'kysely';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { getTableColumns, getTableName, is, isSQLWrapper, Table } from 'drizzle-orm';
import { toCamelCase, toSnakeCase } from 'drizzle-orm/casing';

/**
 * Schema-aware CamelCasePlugin that uses Drizzle schema for column name mapping.
 *
 * Extends CamelCasePlugin to handle non-standard column names that don't follow
 * simple camelCase ↔ snake_case conversion. For example, a JS property `userId`
 * mapped to SQL column `user_identifier` would be handled correctly.
 *
 * Falls back to standard CamelCasePlugin behavior for columns not in the schema.
 */
export class SchemaPlugin extends CamelCasePlugin {
  private jsToSql: Map<string, string>;
  private sqlToJs: Map<string, string>;

  constructor(schema: Record<string, SQLiteTableWithColumns<any>>) {
    super();
    this.jsToSql = new Map();
    this.sqlToJs = new Map();

    for (const [schemaKey, table] of Object.entries(schema)) {
      const tableConfig = getTableConfig(table);

      // Map schema key (camelCase) → SQL table name
      const sqlTableName = tableConfig.name;
      if (schemaKey !== sqlTableName) {
        this.jsToSql.set(schemaKey, sqlTableName);
        this.sqlToJs.set(sqlTableName, schemaKey);
      }

      // Map column property names → SQL column names (only when they differ)
      const sqlColumnNames = new Set(tableConfig.columns.map(c => c.name));
      for (const [propertyName, value] of Object.entries(table)) {
        if (
          value &&
          typeof value === 'object' &&
          'name' in value &&
          typeof value.name === 'string' &&
          sqlColumnNames.has(value.name) &&
          propertyName !== value.name
        ) {
          this.jsToSql.set(propertyName, value.name);
          this.sqlToJs.set(value.name, propertyName);
        }
      }
    }
  }

  protected override snakeCase(str: string): string {
    return this.jsToSql.get(str) ?? super.snakeCase(str);
  }

  protected override camelCase(str: string): string {
    return this.sqlToJs.get(str) ?? super.camelCase(str);
  }

  /**
   * The key a result row has for an identifier a query writes as `name`: it
   * is snake_cased on the way in and camelCased on the way out.
   */
  resultKey(name: string): string {
    return this.camelCase(this.snakeCase(name));
  }
}

// ---------------------------------------------------------------------------
// DrizzleDefaultsPlugin — handles defaultFn / onUpdateFn from Drizzle schemas
// ---------------------------------------------------------------------------

function getKyselyTableName(node: OperationNode | undefined): string | null {
  if (node && TableNode.is(node)) {
    return node.table.identifier.name;
  }
  return null;
}

/** A binary value: an ArrayBuffer or a view of one (a Uint8Array, a Buffer). */
function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function getKyselyColumnName(node: OperationNode | undefined): string | null {
  if (!node) return null;
  if (ColumnNode.is(node)) return node.column.name;
  if (ColumnUpdateNode.is(node) && node.column) return getKyselyColumnName(node.column);
  return null;
}

function convertDrizzleSql(drizzleSql: { sql: string; params: any[] }): string {
  return drizzleSql.sql.split('?').reduce((acc, part, index) => {
    const param = (index < drizzleSql.params.length) ? drizzleSql.params[index] : '';
    return acc + part + param;
  }, '');
}

function createValueNode(val: any): OperationNode {
  if (isSQLWrapper(val)) {
    const sqliteDialect = new SQLiteSyncDialect();
    const drizzleSql = sqliteDialect.sqlToQuery(val as any);
    return sql.raw(convertDrizzleSql(drizzleSql)).toOperationNode();
  }
  return ValueNode.create(val);
}

export type ColumnDefaults = { defaultFn?: () => any; onUpdateFn?: () => any };
export type TableDefaults = Record<string, ColumnDefaults>;

export function extractDefaults(schemas: Record<string, Table>) {
  const defaults = new Map<string, TableDefaults>();

  for (const schema of Object.values(schemas)) {
    const tableName = toCamelCase(getTableName(schema));
    const columns = getTableColumns(schema);
    const tableDefaults: TableDefaults = {};

    for (const column of Object.values(columns)) {
      const { defaultFn, onUpdateFn, name } = column;
      if (defaultFn || onUpdateFn) {
        tableDefaults[name] = { defaultFn, onUpdateFn };
      }
    }

    if (Object.keys(tableDefaults).length > 0) {
      defaults.set(tableName, tableDefaults);
    }
  }

  return defaults;
}

/**
 * Plugin that handles Drizzle's defaultFn and onUpdateFn during Kysely queries.
 *
 * On INSERT: auto-populates columns that have a defaultFn but weren't provided,
 * and resolves DefaultInsertValueNode markers to actual values.
 *
 * On UPDATE: auto-adds column updates for columns with onUpdateFn that weren't
 * already included in the SET clause.
 */
export class DrizzleDefaultsPlugin implements KyselyPlugin {
  private defaults: Map<string, TableDefaults>;

  constructor(drizzleSchemas: Record<string, Table>) {
    this.defaults = extractDefaults(drizzleSchemas);
  }

  private transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const tableName = getKyselyTableName(node.into);
    if (!tableName) return node;

    const tableDefaults = this.defaults.get(tableName);
    if (!tableDefaults) return node;

    if (!node.values || !ValuesNode.is(node.values)) {
      return node;
    }

    const providedColumns = node.columns ?? [];
    const providedColumnNames = providedColumns.map(col => col.column.name);

    // Columns that have a defaultFn but weren't provided in the INSERT
    const missingDefaults = Object.entries(tableDefaults)
      .filter(([colName, { defaultFn }]) => defaultFn && !providedColumnNames.includes(colName))
      .map(([colName, { defaultFn }]) => ({ name: colName, defaultFn: defaultFn! }));

    const newColumns = [
      ...providedColumns,
      ...missingDefaults.map(({ name }) => ColumnNode.create(name)),
    ];

    const newRows = node.values.values.map((rowNode) => {
      if (missingDefaults.length === 0 && PrimitiveValueListNode.is(rowNode)) {
        return rowNode;
      }

      let originalValues: OperationNode[];
      if (PrimitiveValueListNode.is(rowNode)) {
        originalValues = rowNode.values.map(val => ValueNode.create(val));
      } else if (ValueListNode.is(rowNode)) {
        originalValues = [...rowNode.values];
      } else {
        throw new Error('Unsupported row node type in insert query');
      }

      // Resolve DefaultInsertValueNode markers
      const processedValues = originalValues.map((val, idx) => {
        if (val.kind === 'DefaultInsertValueNode') {
          const colName = providedColumns[idx].column.name;
          const colDef = tableDefaults[colName];
          if (colDef?.defaultFn) {
            return createValueNode(colDef.defaultFn());
          }
        }
        return val;
      });

      // Append default values for missing columns
      const missingValues = missingDefaults.map(({ defaultFn }) => createValueNode(defaultFn()));

      return ValueListNode.create([...processedValues, ...missingValues]);
    });

    return InsertQueryNode.cloneWith(node, {
      columns: newColumns,
      values: ValuesNode.create(newRows),
    });
  }

  private transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    const tableName = getKyselyTableName(node.table);
    if (!tableName) return node;

    const tableDefaults = this.defaults.get(tableName);
    if (!tableDefaults) return node;

    const existingUpdates = new Set(
      (node.updates?.map(getKyselyColumnName)) || []
    );
    const newUpdates = node.updates ? [...node.updates] : [];

    for (const [colName, { onUpdateFn }] of Object.entries(tableDefaults)) {
      if (!onUpdateFn || existingUpdates.has(colName)) continue;

      newUpdates.push(
        ColumnUpdateNode.create(
          ColumnNode.create(colName),
          createValueNode(onUpdateFn())
        )
      );
    }

    if (newUpdates.length === (node.updates?.length || 0)) {
      return node;
    }

    return { ...node, updates: newUpdates };
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const { node } = args;
    switch (node.kind) {
      case 'InsertQueryNode':
        return this.transformInsertQuery(node as InsertQueryNode);
      case 'UpdateQueryNode':
        return this.transformUpdateQuery(node as UpdateQueryNode);
      default:
        return node;
    }
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/**
 * Date serialization helpers for SQLite
 * SQLite stores dates as TEXT in ISO format (without timezone)
 */
export const dateSerializers = {
  /**
   * Serialize a Date to SQLite format
   * Converts to ISO string, removes timezone info
   */
  serialize(value: Date): string {
    return value.toISOString().replace('T', ' ').slice(0, 19);
  },

  /**
   * Deserialize a SQLite date string to Date
   * Parses assuming UTC timezone
   */
  deserialize(value: string): Date {
    const normalized = value.replace(' ', 'T');
    // Strings that already carry timezone info (Z or ±HH:MM) must be parsed
    // as-is — appending another 'Z' would produce an Invalid Date, which
    // serializes to null over RPC/JSON.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)) {
      return new Date(normalized);
    }
    // SQLite CURRENT_TIMESTAMP is UTC but without timezone indicator
    // Add 'Z' to make JavaScript parse it as UTC
    return new Date(normalized + 'Z');
  },

  /**
   * Check if a string looks like an ISO date
   */
  isDateString(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value);
  },

  /**
   * Check if a string matches exactly the format produced by serialize()
   * (and SQLite's CURRENT_TIMESTAMP): `YYYY-MM-DD HH:MM:SS`.
   *
   * The read path only deserializes strings in this exact format. Anything
   * else — full ISO strings with a 'T' separator, timezone, or milliseconds —
   * was stored by the user as a plain string and must round-trip verbatim.
   */
  isSerializedDateString(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  },
};

/**
 * Collect the names of columns that Drizzle declares as date-typed
 * (e.g. `integer({ mode: 'timestamp' })`). Includes both the SQL column
 * name and the JS property name, since result rows may be seen in either
 * form depending on where this plugin sits relative to CamelCasePlugin.
 */
function collectDateColumnNames(schema: Record<string, Table>): Set<string> {
  const dateColumns = new Set<string>();

  for (const table of Object.values(schema)) {
    const columns = getTableColumns(table);
    for (const [propertyName, column] of Object.entries(columns)) {
      if (column.dataType === 'date') {
        dateColumns.add(column.name);
        dateColumns.add(propertyName);
        // Implicit columns keep the JS property name as column.name at
        // runtime; the actual SQL column is snake_cased by the migration
        // layer, so cover that form too.
        dateColumns.add(toSnakeCase(propertyName));
      }
    }
  }

  return dateColumns;
}

/**
 * Plugin that serializes/deserializes Date objects for SQLite
 *
 * On query: Converts Date objects to ISO strings
 * On result: Converts stored date strings back to Date objects — but only
 * for values in the exact format the write path produces, and (when a schema
 * is provided) only for columns Drizzle declares as date-typed. Plain text
 * columns holding date-looking strings round-trip verbatim.
 */
export class DateSerializePlugin implements KyselyPlugin {
  /**
   * Names of date-typed columns (SQL and JS forms) when constructed with a
   * schema; null means "no schema available", which falls back to matching
   * on value format alone.
   */
  private dateColumns: Set<string> | null;

  constructor(schema?: Record<string, Table>) {
    this.dateColumns = schema ? collectDateColumnNames(schema) : null;
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    // Transform Date values in the query
    return this.transformNode(args.node) as RootOperationNode;
  }

  private transformNode(node: unknown): unknown {
    if (node === null || node === undefined) {
      return node;
    }

    if (node instanceof Date) {
      return dateSerializers.serialize(node);
    }

    // A blob parameter is bound as it is: rebuilt like the objects below, a
    // Uint8Array would reach the driver as a plain object of its bytes.
    if (isBinary(node)) {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(item => this.transformNode(item));
    }

    if (typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        result[key] = this.transformNode(value);
      }
      return result;
    }

    return node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return {
      ...args.result,
      rows: args.result.rows.map(row => this.transformRow(row)),
    };
  }

  private transformRow(row: UnknownRow): UnknownRow {
    const result: UnknownRow = {};

    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && this.shouldDeserialize(key, value)) {
        result[key] = dateSerializers.deserialize(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private shouldDeserialize(key: string, value: string): boolean {
    // With a schema, only columns Drizzle declares as date-typed qualify
    if (this.dateColumns && !this.dateColumns.has(key)) {
      return false;
    }
    // Only deserialize the exact format the write path produces. User-stored
    // strings (ISO with 'T'/timezone/milliseconds) round-trip verbatim.
    return dateSerializers.isSerializedDateString(value);
  }
}

/**
 * Collect the names of columns Drizzle declares as boolean-typed
 * (`integer({ mode: 'boolean' })`). Mirrors collectDateColumnNames: covers
 * the SQL column name, the JS property name, and the snake_cased property
 * name, so it works on either side of the CamelCasePlugin.
 */
function collectBooleanColumnNames(schema: Record<string, Table>): Set<string> {
  const booleanColumns = new Set<string>();

  for (const table of Object.values(schema)) {
    const columns = getTableColumns(table);
    for (const [propertyName, column] of Object.entries(columns)) {
      if (column.dataType === 'boolean') {
        booleanColumns.add(column.name);
        booleanColumns.add(propertyName);
        booleanColumns.add(toSnakeCase(propertyName));
      }
    }
  }

  return booleanColumns;
}

/**
 * Plugin that deserializes boolean-mode columns on read.
 *
 * SQLite stores booleans as INTEGER 1/0 (the write side is normalized in the
 * driver — see normalizeParameter in kysely.ts), so schema-declared boolean
 * columns come back as numbers and must be mapped to real booleans. Legacy
 * rows written before the driver normalization existed carry TEXT
 * 'true'/'false' — those are mapped too, so old data keeps reading correctly.
 * Anything unrecognized round-trips verbatim rather than being guessed at.
 */
export class BooleanDeserializePlugin implements KyselyPlugin {
  private booleanColumns: Set<string>;

  constructor(schema: Record<string, Table>) {
    this.booleanColumns = collectBooleanColumnNames(schema);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    if (this.booleanColumns.size === 0) return args.result;
    return {
      ...args.result,
      rows: args.result.rows.map((row) => this.transformRow(row)),
    };
  }

  private transformRow(row: UnknownRow): UnknownRow {
    const result: UnknownRow = {};
    for (const [key, value] of Object.entries(row)) {
      result[key] = this.booleanColumns.has(key) ? this.toBoolean(value) : value;
    }
    return result;
  }

  private toBoolean(value: unknown): unknown {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'bigint') return value !== 0n;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
}

// ---------------------------------------------------------------------------
// JSON-mode columns
// ---------------------------------------------------------------------------

/** How a JSON-mode column is stored: `text({ mode: 'json' })` or `blob({ mode: 'json' })`. */
type JsonStorage = 'text' | 'blob';

interface JsonTable {
  /** The table's JSON-mode columns, under every name a query or a result knows them by. */
  json: Map<string, JsonStorage>;
  /** Its other columns, under the same names. */
  plain: Set<string>;
}

/**
 * The JSON-mode columns of a schema, table by table. A table is found under
 * its schema key and its SQL name; a column under its property name, its name
 * and its snake_cased property name, like collectDateColumnNames — so a
 * lookup works on either side of the CamelCasePlugin.
 */
function collectJsonTables(schema: Record<string, Table>): Map<string, JsonTable> {
  const tables = new Map<string, JsonTable>();

  for (const [schemaKey, table] of Object.entries(schema)) {
    const facts: JsonTable = { json: new Map(), plain: new Set() };
    for (const [propertyName, column] of Object.entries(getTableColumns(table))) {
      const names = [propertyName, column.name, toSnakeCase(propertyName)];
      if (column.dataType === 'json') {
        const storage: JsonStorage = column.getSQLType() === 'blob' ? 'blob' : 'text';
        for (const name of names) facts.json.set(name, storage);
      } else {
        for (const name of names) facts.plain.add(name);
      }
    }
    const tableName = getTableName(table);
    for (const name of [schemaKey, tableName, toCamelCase(tableName)]) {
      if (!tables.has(name)) tables.set(name, facts);
    }
  }

  return tables;
}

function hasJsonColumn(schema: Record<string, Table>): boolean {
  return Object.values(schema).some((table) =>
    Object.values(getTableColumns(table)).some((column) => column.dataType === 'json'),
  );
}

/**
 * What a JSON-mode column stores for a value: its JSON text, as UTF-8 bytes
 * in a blob column. A string is JSON too (`"text"`), so it reads back as the
 * string it was.
 */
function serializeJsonValue(value: unknown, storage: JsonStorage): unknown {
  if (value === null || value === undefined) return value;
  const json = JSON.stringify(value);
  // Nothing JSON can say (a function, a symbol): the driver's to refuse.
  if (json === undefined) return value;
  return storage === 'blob' ? new TextEncoder().encode(json) : json;
}

/**
 * What a JSON-mode column holds, from what SQLite answered: text is parsed,
 * bytes (a blob column) are read as UTF-8 first. What is no JSON — a row
 * written before these columns were serialized — is answered as it is.
 */
export function parseJsonValue(value: unknown): unknown {
  let text: unknown = value;
  if (isBinary(value)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      return value;
    }
  }
  if (typeof text !== 'string') return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/** The table a node names: `invoices`, or the one behind `invoices as i`. */
function tableNameOf(node: OperationNode | undefined): string | null {
  if (!node) return null;
  if (TableNode.is(node)) return node.table.identifier.name;
  if (AliasNode.is(node) && TableNode.is(node.node)) return node.node.table.identifier.name;
  return null;
}

/** The column a node names: `meta`, or the one in `i.meta`. */
function columnNameOf(node: OperationNode | undefined): string | null {
  if (!node) return null;
  if (ColumnNode.is(node)) return node.column.name;
  if (ReferenceNode.is(node) && ColumnNode.is(node.column)) return node.column.column.name;
  return null;
}

/** Every table a query names, however deep — never walking the values it carries. */
function walkTables(node: unknown, visit: (name: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkTables(item, visit);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const kind = (node as { kind?: unknown }).kind;
  // Operation nodes only, and none that holds a caller's values.
  if (typeof kind !== 'string' || kind === 'ValueNode' || kind === 'PrimitiveValueListNode') return;
  if (TableNode.is(node as OperationNode)) {
    visit((node as TableNode).table.identifier.name);
    return;
  }
  for (const value of Object.values(node)) walkTables(value, visit);
}

/** The names that are a JSON-mode column in one of `tables` and another kind of column in none. */
function jsonNamesAmong(tables: Iterable<JsonTable>): Set<string> {
  const json = new Set<string>();
  const plain = new Set<string>();
  for (const facts of new Set(tables)) {
    for (const name of facts.json.keys()) json.add(name);
    for (const name of facts.plain) plain.add(name);
  }
  for (const name of plain) json.delete(name);
  return json;
}

/** What a query reads from: its tables by the name it refers to them. */
interface JsonScope {
  /** The table's facts, or null for what is no table of the schema (a subquery, a CTE). */
  sources: Map<string, JsonTable | null>;
  /** A source with no name to refer to it by. */
  opaque: boolean;
  /** The JSON names to go by where a source says nothing. */
  fallback(): Set<string>;
}

export interface JsonPluginOptions {
  /**
   * The key a result row has for an identifier as a query writes it —
   * SchemaPlugin's `resultKey` when the names are camelCased. Default: the
   * identifier itself.
   */
  resultKey?: (name: string) => string;
}

/**
 * The two plugins behind JSON-mode columns (`text({ mode: 'json' })`,
 * `blob({ mode: 'json' })`): a value written to one is stored as its JSON, and
 * one that is read comes back as the value.
 *
 * `write` goes before the plugin that renames identifiers and before
 * DateSerializePlugin; `read` after them. In between they share which keys of
 * a query's rows are JSON columns, worked out from what the query selects:
 *
 * - a column (`meta`, `i.meta`, `i.meta as m`) is resolved against the tables
 *   the query reads from — the same name in a table where it is another kind
 *   of column is left alone;
 * - `selectAll()` / `returningAll()` are every JSON column of those tables;
 * - where the source is no table of the schema (a subquery, a CTE, a raw
 *   query), a name goes for a JSON column when it is one in a table the query
 *   names (in any table, for a query that names none) and another kind of
 *   column in none of them.
 *
 * An expression (a JSON path, a function call, `related()`) is the caller's:
 * it is neither serialized nor parsed. So is a value compared with a JSON
 * column in a `where`.
 */
export function createJsonPlugins(
  schema: Record<string, Table>,
  options: JsonPluginOptions = {},
): { write: KyselyPlugin; read: KyselyPlugin } {
  const tables = collectJsonTables(schema);
  const resultKey = options.resultKey ?? ((name: string) => name);
  const selected = new WeakMap<QueryId, Set<string>>();
  let everywhere: Set<string> | undefined;

  // -- writing ---------------------------------------------------------------

  const writeValue = (facts: JsonTable, column: string | null, node: OperationNode): OperationNode => {
    const storage = column === null ? undefined : facts.json.get(column);
    if (!storage || !ValueNode.is(node)) return node;
    return Object.freeze({ ...node, value: serializeJsonValue(node.value, storage) });
  };

  const writeUpdates = (facts: JsonTable, updates: ReadonlyArray<ColumnUpdateNode>): ReadonlyArray<ColumnUpdateNode> =>
    updates.map((update) => {
      const value = writeValue(facts, columnNameOf(update.column), update.value);
      return value === update.value ? update : Object.freeze({ ...update, value });
    });

  const writeInsert = (node: InsertQueryNode): InsertQueryNode => {
    const facts = tables.get(tableNameOf(node.into) ?? '');
    if (!facts || facts.json.size === 0) return node;
    let out = node;

    if (node.columns && node.values && ValuesNode.is(node.values)) {
      const storages = node.columns.map((column) => facts.json.get(column.column.name));
      if (storages.some((storage) => storage !== undefined)) {
        const rows = node.values.values.map((row) => {
          if (PrimitiveValueListNode.is(row)) {
            return PrimitiveValueListNode.create(
              row.values.map((value, i) => (storages[i] ? serializeJsonValue(value, storages[i]) : value)),
            );
          }
          if (ValueListNode.is(row)) {
            return ValueListNode.create(
              row.values.map((value, i) => {
                const storage = storages[i];
                if (!storage || !ValueNode.is(value)) return value;
                return Object.freeze({ ...value, value: serializeJsonValue(value.value, storage) });
              }),
            );
          }
          return row;
        });
        out = InsertQueryNode.cloneWith(out, { values: ValuesNode.create(rows) });
      }
    }

    // `on conflict … do update set`: the same table's columns.
    if (node.onConflict?.updates) {
      out = InsertQueryNode.cloneWith(out, {
        onConflict: Object.freeze({ ...node.onConflict, updates: writeUpdates(facts, node.onConflict.updates) }),
      });
    }

    return out;
  };

  const writeUpdate = (node: UpdateQueryNode): UpdateQueryNode => {
    const facts = tables.get(tableNameOf(node.table) ?? '');
    if (!facts || facts.json.size === 0 || !node.updates) return node;
    return Object.freeze({ ...node, updates: writeUpdates(facts, node.updates) });
  };

  // -- reading ---------------------------------------------------------------

  const fallbackFor = (root: RootOperationNode): Set<string> => {
    const named = new Set<JsonTable>();
    let any = false;
    walkTables(root, (name) => {
      any = true;
      const facts = tables.get(name);
      if (facts) named.add(facts);
    });
    if (any) return jsonNamesAmong(named);
    return (everywhere ??= jsonNamesAmong(tables.values()));
  };

  const scopeOf = (root: RootOperationNode, sources: ReadonlyArray<OperationNode | undefined>): JsonScope => {
    let fallback: Set<string> | undefined;
    const scope: JsonScope = { sources: new Map(), opaque: false, fallback: () => (fallback ??= fallbackFor(root)) };
    for (const node of sources) {
      if (!node) continue;
      if (TableNode.is(node)) {
        const name = node.table.identifier.name;
        scope.sources.set(name, tables.get(name) ?? null);
      } else if (AliasNode.is(node) && IdentifierNode.is(node.alias)) {
        const table = TableNode.is(node.node) ? tables.get(node.node.table.identifier.name) : undefined;
        scope.sources.set(node.alias.name, table ?? null);
      } else {
        scope.opaque = true;
      }
    }
    return scope;
  };

  const isJson = (scope: JsonScope, qualifier: string | null, column: string): boolean => {
    if (qualifier !== null) {
      const facts = scope.sources.get(qualifier);
      return facts ? facts.json.has(column) : scope.fallback().has(column);
    }
    let json = false;
    for (const facts of scope.sources.values()) {
      if (!facts) continue;
      if (facts.plain.has(column)) return false;
      if (facts.json.has(column)) json = true;
    }
    return json || scope.fallback().has(column);
  };

  const keysOf = (root: RootOperationNode): Set<string> | undefined => {
    const keys = new Set<string>();
    // A name a result may carry as it is or renamed: `select *` answers the SQL names.
    const addAll = (names: Iterable<string>) => {
      for (const name of names) {
        keys.add(name);
        keys.add(resultKey(name));
      }
    };

    let scope: JsonScope;
    let selections: ReadonlyArray<{ selection: OperationNode }> | undefined;
    if (SelectQueryNode.is(root)) {
      scope = scopeOf(root, [...(root.from?.froms ?? []), ...(root.joins ?? []).map((join) => join.table)]);
      selections = root.selections;
    } else if (InsertQueryNode.is(root)) {
      scope = scopeOf(root, [root.into]);
      selections = root.returning?.selections;
    } else if (UpdateQueryNode.is(root)) {
      scope = scopeOf(root, [root.table, ...(root.from?.froms ?? []), ...(root.joins ?? []).map((join) => join.table)]);
      selections = root.returning?.selections;
    } else if (DeleteQueryNode.is(root)) {
      scope = scopeOf(root, [
        ...root.from.froms,
        ...(root.joins ?? []).map((join) => join.table),
        ...(root.using?.tables ?? []),
      ]);
      selections = root.returning?.selections;
    } else if (root.kind === 'RawNode') {
      // Nothing says what a raw query selects: its rows are read by name.
      addAll(fallbackFor(root));
      return keys.size > 0 ? keys : undefined;
    } else {
      return undefined;
    }
    if (!selections) return undefined;

    const unknown = scope.opaque || [...scope.sources.values()].some((facts) => facts === null);
    for (const { selection } of selections) {
      if (SelectAllNode.is(selection)) {
        const known = [...scope.sources.values()].filter((facts): facts is JsonTable => facts !== null);
        addAll(jsonNamesAmong(known));
        if (unknown) addAll(scope.fallback());
      } else if (ReferenceNode.is(selection)) {
        const qualifier = tableNameOf(selection.table);
        if (SelectAllNode.is(selection.column)) {
          const facts = qualifier === null ? undefined : scope.sources.get(qualifier);
          addAll(facts ? facts.json.keys() : scope.fallback());
        } else if (isJson(scope, qualifier, selection.column.column.name)) {
          keys.add(resultKey(selection.column.column.name));
        }
      } else if (ColumnNode.is(selection)) {
        if (isJson(scope, null, selection.column.name)) keys.add(resultKey(selection.column.name));
      } else if (AliasNode.is(selection) && IdentifierNode.is(selection.alias)) {
        const aliased = selection.node;
        const column = ReferenceNode.is(aliased) || ColumnNode.is(aliased) ? columnNameOf(aliased) : null;
        const qualifier = ReferenceNode.is(aliased) ? tableNameOf(aliased.table) : null;
        if (column !== null && isJson(scope, qualifier, column)) keys.add(resultKey(selection.alias.name));
      }
    }
    return keys.size > 0 ? keys : undefined;
  };

  const write: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const keys = keysOf(node);
      if (keys) selected.set(queryId, keys);
      if (InsertQueryNode.is(node)) return writeInsert(node);
      if (UpdateQueryNode.is(node)) return writeUpdate(node);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  const read: KyselyPlugin = {
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result, queryId }) {
      const keys = selected.get(queryId);
      if (!keys || result.rows.length === 0) return result;
      const rows = result.rows.map((row): UnknownRow => {
        let out: UnknownRow | undefined;
        for (const key of keys) {
          const value = row[key];
          if (value === undefined || value === null) continue;
          const parsed = parseJsonValue(value);
          if (parsed !== value) (out ??= { ...row })[key] = parsed;
        }
        return out ?? row;
      });
      return { ...result, rows };
    },
  };

  return { write, read };
}

/**
 * Validate that a schema object is shaped like a record of Drizzle tables.
 *
 * Throws a descriptive error pointing at the offending key when the schema
 * is not a plain object or when any value isn't a Drizzle `Table`. This
 * catches the common foot-guns (passing a Drizzle relations helper, a plain
 * column builder, or `undefined` because of a missing import) before Kysely
 * plugins crash with an unhelpful stack deep inside their constructors.
 */
export function assertValidSchema(
  schema: unknown
): asserts schema is Record<string, SQLiteTableWithColumns<any>> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(
      `[db] Invalid schema: expected a record of Drizzle tables (e.g. { users, posts }), ` +
      `got ${Array.isArray(schema) ? 'array' : schema === null ? 'null' : typeof schema}.`
    );
  }

  for (const [key, value] of Object.entries(schema)) {
    if (!is(value, Table)) {
      const got =
        value === null ? 'null' :
        value === undefined ? 'undefined' :
        typeof value;
      throw new Error(
        `[db] Invalid schema: '${key}' is not a Drizzle table (got ${got}). ` +
        `Make sure every value is defined with table() from 'durable-db/schema'.`
      );
    }
  }
}

/**
 * Create all recommended plugins for use with Drizzle schemas.
 *
 * Includes:
 * - DrizzleDefaultsPlugin: auto-populates defaultFn/onUpdateFn values
 * - SchemaPlugin (extends CamelCasePlugin): schema-aware camelCase ↔ snake_case
 * - DateSerializePlugin: Date ↔ SQLite text serialization
 * - BooleanDeserializePlugin: boolean-mode columns read back as booleans
 * - createJsonPlugins' two: JSON-mode columns written as JSON and read back
 *   as their value — only for a schema that has such a column
 *
 * When camelCase is false, SchemaPlugin is omitted.
 */
export function createDrizzlePlugins(
  schema: Record<string, SQLiteTableWithColumns<any>>,
  camelCase = true
): KyselyPlugin[] {
  assertValidSchema(schema);

  const tables = schema as unknown as Record<string, Table>;
  const schemaPlugin = camelCase ? new SchemaPlugin(schema) : undefined;
  const json = hasJsonColumn(tables)
    ? createJsonPlugins(tables, schemaPlugin ? { resultKey: (name) => schemaPlugin.resultKey(name) } : {})
    : undefined;

  const plugins: KyselyPlugin[] = [];

  plugins.push(new DrizzleDefaultsPlugin(tables));

  // After the defaults (a `$defaultFn` value is serialized too), before the
  // names are snake_cased and before a Date inside a value is rewritten.
  if (json) {
    plugins.push(json.write);
  }

  if (schemaPlugin) {
    plugins.push(schemaPlugin);
  }

  plugins.push(new DateSerializePlugin(tables));
  plugins.push(new BooleanDeserializePlugin(tables));

  // Last: the rows' keys are the caller's by now, and what is parsed here is
  // never taken for a row whose keys are to be camelCased.
  if (json) {
    plugins.push(json.read);
  }

  return plugins;
}
