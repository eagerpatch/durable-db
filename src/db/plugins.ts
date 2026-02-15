import {
  CamelCasePlugin,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow
} from 'kysely';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

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

    for (const [, table] of Object.entries(schema)) {
      const tableConfig = getTableConfig(table);
      const sqlColumnNames = new Set(tableConfig.columns.map(c => c.name));

      for (const [propertyName, value] of Object.entries(table)) {
        if (
          value &&
          typeof value === 'object' &&
          'name' in value &&
          typeof value.name === 'string' &&
          sqlColumnNames.has(value.name)
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
    // SQLite CURRENT_TIMESTAMP is UTC but without timezone indicator
    // Add 'Z' to make JavaScript parse it as UTC
    return new Date(value.replace(' ', 'T') + 'Z');
  },

  /**
   * Check if a string looks like an ISO date
   */
  isDateString(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value);
  },
};

/**
 * Plugin that serializes/deserializes Date objects for SQLite
 * 
 * On query: Converts Date objects to ISO strings
 * On result: Converts ISO date strings back to Date objects
 */
export class DateSerializePlugin implements KyselyPlugin {
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
      if (typeof value === 'string' && dateSerializers.isDateString(value)) {
        result[key] = dateSerializers.deserialize(value);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }
}

/**
 * Create all recommended plugins for use with Drizzle schemas.
 *
 * When camelCase is true, includes SchemaPlugin (which extends CamelCasePlugin)
 * for schema-aware column name mapping. When false, only includes DateSerializePlugin.
 */
export function createDrizzlePlugins(
  schema: Record<string, SQLiteTableWithColumns<any>>,
  camelCase = true
): KyselyPlugin[] {
  const plugins: KyselyPlugin[] = [];

  if (camelCase) {
    plugins.push(new SchemaPlugin(schema));
  }

  plugins.push(new DateSerializePlugin());
  return plugins;
}
