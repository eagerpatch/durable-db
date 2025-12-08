import { DurableObject } from 'cloudflare:workers';
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
import { DateSerializePlugin, createDrizzlePlugins } from './plugins.js';

/**
 * SQL executor function type
 */
export type SqlExecutor = (sql: string) => void;

/**
 * Migration definition - SQL statements with optional breakpoints
 * 
 * Each migration is an array of "chunks" - groups of statements separated by breakpoints.
 * Each chunk is executed as a unit. This allows long migrations to be split into
 * smaller pieces that can survive DO restarts.
 */
export interface Migration {
  /** SQL statement chunks (split by breakpoints) */
  chunks: string[][];
}

/**
 * Migrations object - keys are migration names (should sort alphabetically by timestamp)
 */
export type Migrations = Record<string, Migration>;

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
    const { sql: queryStr, parameters } = compiledQuery;

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

  // Add CamelCasePlugin if enabled (converts JS camelCase to SQL snake_case)
  if (camelCase) {
    allPlugins.push(new CamelCasePlugin());
  }

  // Add Drizzle plugins if schema is provided
  if (schema) {
    allPlugins.push(...createDrizzlePlugins(schema));
  } else {
    // Add DateSerializePlugin even without schema
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

/**
 * Base class for SQLite Durable Objects with migration support
 *
 * Extend this class and set the `migrations` property to define your schema.
 * Migrations run automatically when the DO is first accessed.
 * 
 * Migrations are SQL-based with breakpoint support for long-running migrations.
 * Breakpoints allow migrations to be resumed if the DO restarts mid-migration.
 *
 * @example
 * ```ts
 * import { SqliteDurableObject } from '@shoplayer/database/db';
 *
 * export class MyDatabaseDO extends SqliteDurableObject {
 *   migrations = {
 *     '20240101000000_initial': {
 *       chunks: [
 *         // First chunk - create users table
 *         ['CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)'],
 *         // Second chunk (after breakpoint) - create posts table
 *         ['CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT REFERENCES users(id))'],
 *       ]
 *     }
 *   };
 * }
 * ```
 */
export abstract class SqliteDurableObject<Env = unknown> extends DurableObject<Env> {
  /**
   * Override this with your migrations object
   */
  abstract migrations: Migrations;

  /**
   * The Kysely database instance - available after migrations run
   */
  protected db!: Kysely<any>;

  /**
   * Raw SQLite storage access
   */
  protected sql: SqlStorage;

  /**
   * Whether migrations have been run for this instance
   */
  private migrationsApplied = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = createKyselyFromSql(this.sql);
  }

  /**
   * Ensure migrations are applied before any operation
   */
  protected async ensureMigrations(): Promise<void> {
    if (this.migrationsApplied) {
      return;
    }

    await this.runMigrations();
    this.migrationsApplied = true;
  }

  /**
   * Execute raw SQL statement
   * Used by migrations for direct SQL execution
   */
  protected execSql(sql: string): void {
    this.sql.exec(sql);
  }

  /**
   * Run pending migrations
   */
  private async runMigrations(): Promise<void> {
    // Create migrations tracking table if it doesn't exist
    // Tracks both the migration name and the chunk index for resumability
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (name, chunk_index)
      )
    `);

    // Get already applied migrations and their chunks
    const applied = this.sql.exec('SELECT name, chunk_index FROM __migrations').toArray() as Array<{ name: string; chunk_index: number }>;
    
    // Build a map of migration -> set of applied chunk indices
    const appliedMap = new Map<string, Set<number>>();
    for (const row of applied) {
      if (!appliedMap.has(row.name)) {
        appliedMap.set(row.name, new Set());
      }
      appliedMap.get(row.name)!.add(row.chunk_index);
    }

    // Get pending migrations (sorted by name - should be timestamp-prefixed)
    const migrationNames = Object.keys(this.migrations).sort();

    // Apply each migration
    for (const name of migrationNames) {
      const migration = this.migrations[name];
      const appliedChunks = appliedMap.get(name) ?? new Set<number>();

      // Apply each chunk that hasn't been applied yet
      for (let chunkIndex = 0; chunkIndex < migration.chunks.length; chunkIndex++) {
        if (appliedChunks.has(chunkIndex)) {
          continue; // Already applied
        }

        const chunk = migration.chunks[chunkIndex];
        
        try {
          // Execute each statement in the chunk
          for (const statement of chunk) {
            if (statement.trim()) {
              this.sql.exec(statement);
            }
          }

          // Record successful chunk application
          this.sql.exec(
            'INSERT INTO __migrations (name, chunk_index, applied_at) VALUES (?, ?, ?)',
            name,
            chunkIndex,
            new Date().toISOString()
          );

          console.log(`[database] Migration chunk applied: ${name}[${chunkIndex}]`);
        } catch (error) {
          console.error(`[database] Migration chunk failed: ${name}[${chunkIndex}]`, error);
          // Forward-only: no rollback, just fail
          throw error;
        }
      }
    }
  }

  /**
   * Override fetch to ensure migrations run before any request
   */
  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrations();
    return new Response('OK');
  }
}
