import {
  CamelCasePlugin,
  ColumnNode,
  ColumnUpdateNode,
  InsertQueryNode,
  PrimitiveValueListNode,
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
 *
 * When camelCase is false, SchemaPlugin is omitted.
 */
export function createDrizzlePlugins(
  schema: Record<string, SQLiteTableWithColumns<any>>,
  camelCase = true
): KyselyPlugin[] {
  assertValidSchema(schema);

  const plugins: KyselyPlugin[] = [];

  plugins.push(new DrizzleDefaultsPlugin(schema as unknown as Record<string, Table>));

  if (camelCase) {
    plugins.push(new SchemaPlugin(schema));
  }

  plugins.push(new DateSerializePlugin(schema as unknown as Record<string, Table>));
  plugins.push(new BooleanDeserializePlugin(schema as unknown as Record<string, Table>));
  return plugins;
}
