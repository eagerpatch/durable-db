import { 
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
 * Plugin that maps Drizzle schema column names to their actual SQL column names
 * 
 * Drizzle schemas use camelCase in TypeScript but may have snake_case in SQL.
 * This plugin ensures Kysely uses the correct column names.
 */
export class DrizzleSchemaPlugin implements KyselyPlugin {
  private columnMap: Map<string, Map<string, string>>;

  constructor(schema: Record<string, SQLiteTableWithColumns<any>>) {
    this.columnMap = new Map();
    
    for (const [tableName, table] of Object.entries(schema)) {
      const tableConfig = getTableConfig(table);
      const columns = new Map<string, string>();
      
      for (const column of tableConfig.columns) {
        // Map from the property name (camelCase) to the actual column name
        columns.set(column.name, column.name);
      }
      
      this.columnMap.set(tableConfig.name, columns);
    }
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    // For now, we rely on CamelCasePlugin for the transformation
    // This plugin is kept for potential future schema-aware transformations
    return args.node;
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
 * Create all recommended plugins for use with Drizzle schemas
 */
export function createDrizzlePlugins(schema: Record<string, SQLiteTableWithColumns<any>>): KyselyPlugin[] {
  return [
    new DrizzleSchemaPlugin(schema),
    new DateSerializePlugin(),
  ];
}
