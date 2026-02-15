import { DurableObject } from 'cloudflare:workers';
import { BrowsableHandler } from '@outerbase/browsable-durable-object';
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

/**
 * Maximum number of PITR restore attempts before giving up
 */
const MAX_PITR_ATTEMPTS = 3;

/**
 * Migration attempt info returned by getMigrationAttempts()
 */
export interface MigrationAttemptInfo {
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
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
 * When running on Cloudflare with PITR (Point-in-Time Recovery) support,
 * migrations are protected with automatic snapshots. If a migration fails,
 * the DO is restored to the pre-migration state and retried on next access.
 * After {@link MAX_PITR_ATTEMPTS} consecutive failures, PITR is skipped and
 * the error propagates so the developer can fix the migration and redeploy.
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

  /** Whether this DO exposes a browsable SQL endpoint. Override in subclass. */
  browsable: boolean = false;

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

  /**
   * Cached result of PITR availability check (null = not yet checked)
   */
  private pitrAvailable: boolean | null = null;

  /**
   * Lazy-initialized BrowsableHandler for Outerbase Studio integration
   */
  private browsableHandler: BrowsableHandler | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = createKyselyFromSql(this.sql);
  }

  /**
   * Check if PITR is available on this DO's storage.
   * Result is cached after the first call.
   */
  private async checkPitrAvailable(): Promise<boolean> {
    if (this.pitrAvailable !== null) return this.pitrAvailable;
    try {
      await this.ctx.storage.getCurrentBookmark();
      this.pitrAvailable = true;
    } catch {
      this.pitrAvailable = false;
    }
    return this.pitrAvailable;
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
   * Run pending migrations with PITR safety.
   *
   * Two-write strategy for retry guard:
   * 1. WRITE 1: Increment retry counter in __migration_attempts
   * 2. Take PITR bookmark (captures state including the counter)
   * 3. WRITE 2: Apply the actual migrations
   * On failure → restore to bookmark → counter value survives
   * After MAX_PITR_ATTEMPTS, stop restoring and let the error propagate
   */
  private async runMigrations(): Promise<void> {
    // Create tracking tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (name, chunk_index)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __migration_attempts (
        id TEXT PRIMARY KEY DEFAULT 'current',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT
      )
    `);

    // Ensure the attempts row exists
    this.sql.exec(`
      INSERT OR IGNORE INTO __migration_attempts (id, attempt_count) VALUES ('current', 0)
    `);

    // Collect pending migrations
    const pending = this.collectPendingMigrations();
    if (pending.length === 0) {
      return; // Nothing to do
    }

    const hasPitr = await this.checkPitrAvailable();

    let bookmark: string | undefined;

    if (hasPitr) {
      // WRITE 1: Increment the attempt counter BEFORE taking the bookmark
      this.sql.exec(`
        UPDATE __migration_attempts
        SET attempt_count = attempt_count + 1,
            last_attempt_at = ?
        WHERE id = 'current'
      `, new Date().toISOString());

      // Check the attempt count
      const rows = this.sql.exec(
        'SELECT attempt_count FROM __migration_attempts WHERE id = ?', 'current'
      ).toArray() as Array<{ attempt_count: number }>;
      const attemptCount = rows[0]?.attempt_count ?? 0;

      if (attemptCount > MAX_PITR_ATTEMPTS) {
        // Too many retries — skip PITR, let error propagate naturally
        console.error(
          `[database] Migration has failed ${attemptCount} times. ` +
          `PITR restore disabled — fix the migration and redeploy.`
        );
      } else {
        // Take bookmark AFTER the counter write (so counter survives restore)
        bookmark = await this.ctx.storage.getCurrentBookmark();
        console.log(
          `[database] PITR bookmark taken (attempt ${attemptCount}/${MAX_PITR_ATTEMPTS})`
        );
      }
    }

    // WRITE 2: Apply migrations
    try {
      this.applyMigrations(pending);

      // Success — reset the attempt counter
      this.sql.exec(`
        UPDATE __migration_attempts
        SET attempt_count = 0, last_error = NULL
        WHERE id = 'current'
      `);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (bookmark) {
        // Record the error before restoring
        this.sql.exec(`
          UPDATE __migration_attempts SET last_error = ? WHERE id = 'current'
        `, errorMessage);

        console.error(
          `[database] Migration failed, restoring to pre-migration bookmark.`,
          error
        );

        // Schedule restore and abort — the DO will restart with the counter
        // already incremented (since we wrote it before the bookmark)
        await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
        this.ctx.abort('Restoring to pre-migration bookmark');
      }

      // No PITR available or attempts exhausted — propagate error
      throw error;
    }
  }

  /**
   * Collect pending migration chunks that haven't been applied yet.
   */
  private collectPendingMigrations(): Array<{
    name: string;
    chunkIndex: number;
    statements: string[];
  }> {
    const applied = this.sql.exec(
      'SELECT name, chunk_index FROM __migrations'
    ).toArray() as Array<{ name: string; chunk_index: number }>;

    const appliedMap = new Map<string, Set<number>>();
    for (const row of applied) {
      if (!appliedMap.has(row.name)) {
        appliedMap.set(row.name, new Set());
      }
      appliedMap.get(row.name)!.add(row.chunk_index);
    }

    const pending: Array<{ name: string; chunkIndex: number; statements: string[] }> = [];
    const migrationNames = Object.keys(this.migrations).sort();

    for (const name of migrationNames) {
      const migration = this.migrations[name];
      const appliedChunks = appliedMap.get(name) ?? new Set<number>();

      for (let chunkIndex = 0; chunkIndex < migration.chunks.length; chunkIndex++) {
        if (!appliedChunks.has(chunkIndex)) {
          pending.push({ name, chunkIndex, statements: migration.chunks[chunkIndex] });
        }
      }
    }

    return pending;
  }

  /**
   * Apply a list of pending migration chunks.
   */
  private applyMigrations(
    pending: Array<{ name: string; chunkIndex: number; statements: string[] }>
  ): void {
    for (const { name, chunkIndex, statements } of pending) {
      try {
        for (const statement of statements) {
          if (statement.trim()) {
            this.sql.exec(statement);
          }
        }

        this.sql.exec(
          'INSERT INTO __migrations (name, chunk_index, applied_at) VALUES (?, ?, ?)',
          name,
          chunkIndex,
          new Date().toISOString()
        );

        console.log(`[database] Migration chunk applied: ${name}[${chunkIndex}]`);
      } catch (error) {
        console.error(`[database] Migration chunk failed: ${name}[${chunkIndex}]`, error);
        throw error;
      }
    }
  }

  /**
   * Manually restore the DO to a specific PITR bookmark.
   * The DO will restart on next access with the restored state.
   */
  async restoreToBookmark(bookmark: string): Promise<void> {
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.abort('Restoring to pre-migration bookmark');
  }

  /**
   * Get the current PITR bookmark for diagnostic purposes.
   * Returns null if PITR is not available.
   */
  async getMigrationBookmark(): Promise<string | null> {
    const hasPitr = await this.checkPitrAvailable();
    if (!hasPitr) return null;
    return this.ctx.storage.getCurrentBookmark();
  }

  /**
   * Get migration attempt diagnostics.
   * Returns the current retry counter and last error info.
   */
  getMigrationAttempts(): MigrationAttemptInfo {
    try {
      const rows = this.sql.exec(
        'SELECT attempt_count, last_attempt_at, last_error FROM __migration_attempts WHERE id = ?',
        'current'
      ).toArray() as Array<{ attempt_count: number; last_attempt_at: string | null; last_error: string | null }>;

      if (rows.length === 0) {
        return { attemptCount: 0, lastAttemptAt: null, lastError: null };
      }

      return {
        attemptCount: rows[0].attempt_count,
        lastAttemptAt: rows[0].last_attempt_at,
        lastError: rows[0].last_error,
      };
    } catch {
      // Table doesn't exist yet (no migrations have run)
      return { attemptCount: 0, lastAttemptAt: null, lastError: null };
    }
  }

  /**
   * Override fetch to ensure migrations run before any request.
   * When browsable is enabled, delegates to BrowsableHandler for SQL endpoints.
   */
  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrations();

    if (this.browsable) {
      if (!this.browsableHandler) {
        this.browsableHandler = new BrowsableHandler(this.sql);
      }
      const response = await this.browsableHandler.fetch(request);
      if (response.status !== 404) {
        return response;
      }
    }

    return new Response('OK');
  }
}
