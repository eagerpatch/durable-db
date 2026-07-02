import {
  Kysely,
  SqliteDialect,
  CamelCasePlugin,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type TransactionSettings,
  type KyselyPlugin
} from 'kysely';
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { DateSerializePlugin, createDrizzlePlugins } from './plugins';

// This module bridges a Cloudflare `SqlStorage` to a Kysely instance. It is
// deliberately free of any `cloudflare:workers` import — `SqlStorage` is an
// ambient global type, not a runtime value — so it can be imported under plain
// Node (e.g. the `durable-db/testing` harness), not just inside a worker.

/**
 * SQL executor function type
 */
export type SqlExecutor = (sql: string) => void;

/**
 * Options for creating a Kysely instance
 */
export interface CreateKyselyOptions {
  /** Drizzle schema for plugin configuration */
  schema?: Record<string, SQLiteTableWithColumns<any>>;
  /** Additional Kysely plugins */
  plugins?: KyselyPlugin[];
  /** Whether to use CamelCasePlugin (default: true) */
  camelCase?: boolean;
}

// workerd's SQLite build uses SQLITE_MAX_VARIABLE_NUMBER = 100 — any statement
// with more bound parameters throws "too many SQL variables". Multi-row
// inserts hit this instantly (24 rows × 7 columns = 168 params broke a real
// app), and so do large `WHERE … IN (…)` lists. When a compiled query exceeds
// the limit we inline the parameters as escaped SQL literals instead — still
// one statement, identical semantics (RETURNING, ON CONFLICT, changes() all
// behave the same).
const MAX_BOUND_PARAMETERS = 100;

/**
 * workerd has no boolean binding type and silently stringifies JS booleans
 * (storing TEXT 'true' in an INTEGER column); node:sqlite rejects them
 * outright. Normalize to SQLite's 1/0 convention before the value reaches
 * either. `undefined` → NULL for the same reason.
 */
function normalizeParameter(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

function escapeLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`[db] Cannot inline non-finite number parameter (${value})`);
    }
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (value.includes('\0')) {
      throw new Error('[db] Cannot inline a string parameter containing a NUL byte');
    }
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  throw new Error(`[db] Cannot inline SQL parameter of type ${typeof value}`);
}

/**
 * Replace each `?` placeholder in `sql` with the escaped literal of its
 * parameter. A real scanner, not a regex: '…' string literals ('' escapes),
 * "…" quoted identifiers, `--` line comments and C-style block comments are
 * skipped, so a `?` inside any of them is never touched.
 *
 * Exported for tests.
 */
export function inlineParameters(sql: string, parameters: readonly unknown[]): string {
  let out = '';
  let p = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      out += sql.slice(i, j);
      i = j - 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? sql.length : j + 2;
      out += sql.slice(i, j);
      i = j - 1;
      continue;
    }
    if (ch === '?') {
      if (p >= parameters.length) {
        throw new Error('[db] Query has more `?` placeholders than parameters while inlining');
      }
      out += escapeLiteral(parameters[p++]);
      continue;
    }
    out += ch;
  }
  if (p !== parameters.length) {
    throw new Error(
      `[db] Inlined ${p} parameter(s) but the query provided ${parameters.length} — placeholder/parameter mismatch`,
    );
  }
  return out;
}

/**
 * A Kysely driver that uses Cloudflare DO SQLite storage
 */
class CloudflareSqliteDriver implements Driver {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new CloudflareSqliteConnection(this.sql);
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    if (settings.isolationLevel) {
      throw new Error('SQLite does not support isolation levels');
    }
    await connection.executeQuery(createCompiledQuery('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(createCompiledQuery('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(createCompiledQuery('ROLLBACK'));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/**
 * Helper to create a CompiledQuery object
 */
function createCompiledQuery(sql: string, parameters: readonly unknown[] = []): CompiledQuery {
  return {
    sql,
    parameters,
    query: { kind: 'RawNode', sqlFragments: [sql], parameters: [] },
  } as CompiledQuery;
}

/**
 * A Kysely connection that wraps Cloudflare's SqlStorage
 */
class CloudflareSqliteConnection implements DatabaseConnection {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    let queryStr = compiledQuery.sql;
    let parameters: readonly unknown[] = compiledQuery.parameters.map(normalizeParameter);

    // Over workerd's 100-bound-parameter limit: inline as escaped literals.
    if (parameters.length > MAX_BOUND_PARAMETERS) {
      queryStr = inlineParameters(queryStr, parameters);
      parameters = [];
    }

    // Check if this is a SELECT/RETURNING query
    const isSelect = /^\s*(SELECT|RETURNING)/i.test(queryStr) ||
                     /\s+RETURNING\s+/i.test(queryStr);

    try {
      if (isSelect) {
        const cursor = this.sql.exec(queryStr, ...parameters as any[]);
        const rows = cursor.toArray() as R[];
        return {
          rows,
          numAffectedRows: undefined,
          insertId: undefined,
        };
      } else {
        this.sql.exec(queryStr, ...parameters as any[]);
        // For INSERT/UPDATE/DELETE, try to get affected rows
        const changesResult = this.sql.exec('SELECT changes() as changes').toArray();
        const changes = changesResult[0]?.changes as number ?? 0;

        // For INSERT, try to get last insert rowid
        const lastIdResult = this.sql.exec('SELECT last_insert_rowid() as id').toArray();
        const lastId = lastIdResult[0]?.id;

        return {
          rows: [] as R[],
          numAffectedRows: BigInt(changes),
          insertId: typeof lastId === 'number' || typeof lastId === 'bigint'
            ? BigInt(lastId)
            : undefined,
        };
      }
    } catch (error) {
      throw error;
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported in Cloudflare SQLite');
  }
}

/**
 * Create a Kysely instance from Cloudflare SqlStorage
 *
 * @param sqlStorage - The Cloudflare SqlStorage instance
 * @param options - Configuration options including schema for plugins
 */
export function createKyselyFromSql<T>(
  sqlStorage: SqlStorage,
  options: CreateKyselyOptions = {}
): Kysely<T> {
  const { schema, plugins = [], camelCase = true } = options;

  // Create a dummy dialect just for the adapter/compiler/introspector
  const sqliteDialect = new SqliteDialect({ database: null as any });

  // Build plugins array
  const allPlugins: KyselyPlugin[] = [];

  // Add schema/camelCase plugins
  if (schema) {
    // SchemaPlugin extends CamelCasePlugin, so no need for standalone CamelCasePlugin
    allPlugins.push(...createDrizzlePlugins(schema, camelCase));
  } else if (camelCase) {
    allPlugins.push(new CamelCasePlugin());
    allPlugins.push(new DateSerializePlugin());
  } else {
    allPlugins.push(new DateSerializePlugin());
  }

  // Add any custom plugins
  allPlugins.push(...plugins);

  return new Kysely<T>({
    dialect: {
      createAdapter: () => sqliteDialect.createAdapter(),
      createDriver: () => new CloudflareSqliteDriver(sqlStorage),
      createIntrospector: (db) => sqliteDialect.createIntrospector(db),
      createQueryCompiler: () => sqliteDialect.createQueryCompiler(),
    },
    plugins: allPlugins,
  });
}
