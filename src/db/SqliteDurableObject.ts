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
 * Migration definition
 *
 * Migrations can use either:
 * 1. Kysely schema builder: `up(db) { await db.schema.createTable(...).execute(); }`
 * 2. Raw SQL via executor: `up(db, exec) { exec('CREATE TABLE ...'); }`
 */
export interface Migration {
  up: (db: Kysely<any>, exec: SqlExecutor) => Promise<void>;
  down?: (db: Kysely<any>, exec: SqlExecutor) => Promise<void>;
}

/**
 * Migrations object - keys are migration names (should sort alphabetically)
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
 * @example
 * ```ts
 * import { SqliteDurableObject } from '@shoplayer/database/db';
 *
 * export class MyDatabaseDO extends SqliteDurableObject {
 *   migrations = {
 *     '001_initial': {
 *       async up(db) {
 *         await db.schema
 *           .createTable('users')
 *           .addColumn('id', 'text', col => col.primaryKey())
 *           .addColumn('name', 'text', col => col.notNull())
 *           .execute();
 *       },
 *       async down(db) {
 *         await db.schema.dropTable('users').ifExists().execute();
 *       }
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
    await this.db.schema
      .createTable('__migrations')
      .ifNotExists()
      .addColumn('name', 'text', col => col.primaryKey())
      .addColumn('applied_at', 'text', col => col.notNull())
      .execute();

    // Get already applied migrations
    const applied = await this.db
      .selectFrom('__migrations' as any)
      .select('name')
      .execute();

    const appliedSet = new Set(applied.map(m => m.name));

    // Get pending migrations (sorted by name)
    const migrationNames = Object.keys(this.migrations).sort();
    const pending = migrationNames.filter(name => !appliedSet.has(name));

    // Create SQL executor bound to this instance
    const exec = (sql: string) => this.execSql(sql);

    // Apply each pending migration
    for (const name of pending) {
      const migration = this.migrations[name];

      try {
        await migration.up(this.db, exec);

        // Record successful migration
        await this.db
          .insertInto('__migrations' as any)
          .values({
            name,
            applied_at: new Date().toISOString(),
          })
          .execute();

        console.log(`[database] Migration applied: ${name}`);
      } catch (error) {
        console.error(`[database] Migration failed: ${name}`, error);

        // Try to rollback if down() is defined
        if (migration.down) {
          try {
            await migration.down(this.db, exec);
            console.log(`[database] Migration rolled back: ${name}`);
          } catch (rollbackError) {
            console.error(`[database] Rollback failed: ${name}`, rollbackError);
          }
        }

        throw error;
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
