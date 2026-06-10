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
import { DateSerializePlugin, createDrizzlePlugins } from './plugins';
import { debugMigrations } from '../utils/debug';

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
 * Consolidated migration status returned by getMigrationStatus().
 * Combines attempt diagnostics with the DO's current pending/applied
 * state so operators can answer "what's going on with this DO?" in a
 * single call.
 */
export interface MigrationStatus {
  /** Attempt counter from __migration_attempts. */
  attempts: MigrationAttemptInfo;
  /** Names of migrations that exist in code but haven't been applied. */
  pending: string[];
  /** Names of migrations that have been applied (at least one chunk). */
  applied: string[];
  /** Whether the underlying storage supports PITR bookmarks. */
  pitrAvailable: boolean;
  /**
   * Reason PITR is unavailable, populated from the error thrown by
   * `getCurrentBookmark()` on first check. Null when PITR is available
   * or hasn't been checked yet.
   */
  pitrUnavailableReason: string | null;
  /**
   * Remaining PITR-protected retries before PITR is disabled. Clamped to
   * 0; always 0 when pitrAvailable is false.
   */
  pitrAttemptsRemaining: number;
}

/**
 * Truncate a SQL statement for logging. Collapses whitespace so multi-line
 * statements render on one log line.
 */
function formatStatementForLog(statement: string, max = 120): string {
  const collapsed = statement.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
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
 * import { SqliteDurableObject } from 'durable-db/db';
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

  /**
   * Cached result of PITR availability check (null = not yet checked)
   */
  private pitrAvailable: boolean | null = null;

  /**
   * Reason PITR was determined unavailable, if known. Null when PITR is
   * available or hasn't been checked yet. Surfaced via getMigrationStatus()
   * so operators can distinguish "not supported by the runtime" from
   * "unexpected error at detection time".
   */
  private pitrUnavailableReason: string | null = null;

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
      this.pitrUnavailableReason = null;
    } catch (e) {
      this.pitrAvailable = false;
      this.pitrUnavailableReason = e instanceof Error ? e.message : String(e);
      debugMigrations('PITR unavailable: %s', this.pitrUnavailableReason);
    }
    return this.pitrAvailable;
  }

  /**
   * Reset the in-memory migration flag so that the next operation
   * will re-run migrations. Used after `ctx.storage.deleteAll()` to
   * ensure a fresh start.
   */
  protected resetMigrationState(): void {
    this.migrationsApplied = false;
    debugMigrations('Migration state reset; migrations will re-run on next access');
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
        const lastError = this.readLastMigrationError();
        const pendingNames = pending.map(p => p.name);
        const uniquePending = Array.from(new Set(pendingNames));
        console.error(
          `[database] Migration has failed ${attemptCount} times. ` +
          `PITR restore disabled — fix the migration and redeploy. ` +
          `Pending: ${uniquePending.join(', ') || '(none)'}. ` +
          `Last error: ${lastError ?? '(unknown)'}`
        );
      } else {
        // Take bookmark AFTER the counter write (so counter survives restore)
        bookmark = await this.ctx.storage.getCurrentBookmark();
        debugMigrations('PITR bookmark taken (attempt %d/%d)', attemptCount, MAX_PITR_ATTEMPTS);
      }
    }

    // WRITE 2: Apply migrations
    const startedAt = Date.now();
    try {
      this.applyMigrations(pending);

      // Success — reset the attempt counter
      this.sql.exec(`
        UPDATE __migration_attempts
        SET attempt_count = 0, last_error = NULL
        WHERE id = 'current'
      `);

      const uniqueNames = Array.from(new Set(pending.map(p => p.name)));
      const elapsed = Date.now() - startedAt;
      console.log(
        `[database] Applied ${pending.length} migration chunk(s) ` +
        `across ${uniqueNames.length} migration(s) in ${elapsed}ms: ${uniqueNames.join(', ')}` +
        (hasPitr ? '' : ' (PITR unavailable — migrations ran unprotected)')
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (bookmark) {
        // Record the error before restoring
        this.sql.exec(`
          UPDATE __migration_attempts SET last_error = ? WHERE id = 'current'
        `, errorMessage);

        const attempts = this.getMigrationAttempts();
        const remaining = Math.max(0, MAX_PITR_ATTEMPTS + 1 - attempts.attemptCount);
        const pendingNames = Array.from(new Set(pending.map(p => p.name))).join(', ');
        console.error(
          `[database] Migration failed (attempt ${attempts.attemptCount}/${MAX_PITR_ATTEMPTS + 1}, ` +
          `${remaining} PITR-protected retries remaining). ` +
          `Restoring to pre-migration bookmark. Pending: ${pendingNames || '(none)'}.`,
          error
        );

        // Schedule restore and abort — the DO will restart with the counter
        // already incremented (since we wrote it before the bookmark).
        //
        // If the restore call itself fails (some runtimes advertise PITR via
        // getCurrentBookmark() but fail the actual restore) we must still
        // surface the ORIGINAL migration error, not the PITR failure. That's
        // what the user needs to fix; the PITR layer is just getting in the
        // way of the real diagnostic.
        try {
          await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
          this.ctx.abort('Restoring to pre-migration bookmark');
        } catch (pitrErr) {
          const pitrMessage = pitrErr instanceof Error ? pitrErr.message : String(pitrErr);
          // If abort() threw (expected in production), re-throw so the DO
          // tears down as intended. We detect this heuristically by the
          // presence of our abort reason in the message — abort errors
          // carry the reason we passed in.
          if (pitrMessage.includes('Restoring to pre-migration bookmark')) {
            throw pitrErr;
          }
          console.error(
            `[database] PITR restore failed (${pitrMessage}). ` +
            `Propagating the original migration error instead so you can fix the root cause.`
          );
          // fall through to `throw error` below
        }
      }

      // No PITR available, attempts exhausted, or PITR restore itself failed —
      // propagate the original migration error (the real root cause).
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
      // Track which statement is executing so the catch can report it.
      // A chunk may contain many statements and the raised error doesn't
      // carry a statement index of its own.
      let currentIndex = -1;
      let currentStatement: string | null = null;
      try {
        for (let i = 0; i < statements.length; i++) {
          const statement = statements[i];
          if (!statement.trim()) continue;
          currentIndex = i;
          currentStatement = statement;
          this.sql.exec(statement);
        }

        currentIndex = -1;
        currentStatement = null;

        this.sql.exec(
          'INSERT INTO __migrations (name, chunk_index, applied_at) VALUES (?, ?, ?)',
          name,
          chunkIndex,
          new Date().toISOString()
        );

        debugMigrations('Migration chunk applied: %s[%d]', name, chunkIndex);
      } catch (error) {
        const location = currentStatement !== null
          ? ` stmt ${currentIndex}: ${formatStatementForLog(currentStatement)}`
          : ' (while recording chunk as applied)';
        console.error(
          `[database] Migration chunk failed: ${name}[${chunkIndex}]${location}`,
          error
        );
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
   * Read the last recorded migration error, or null if unavailable.
   * Used for enriching PITR-exhausted log output.
   */
  private readLastMigrationError(): string | null {
    try {
      return this.getMigrationAttempts().lastError;
    } catch {
      return null;
    }
  }

  /**
   * Get a consolidated snapshot of migration state: attempts, pending and
   * applied migration names, and PITR availability. Useful for building
   * admin/debug endpoints without exposing internal SQL.
   */
  async getMigrationStatus(): Promise<MigrationStatus> {
    const attempts = this.getMigrationAttempts();
    const pitrAvailable = await this.checkPitrAvailable();
    const pitrAttemptsRemaining = pitrAvailable
      ? Math.max(0, MAX_PITR_ATTEMPTS + 1 - attempts.attemptCount)
      : 0;

    const appliedSet = new Set<string>();
    try {
      const rows = this.sql.exec(
        'SELECT DISTINCT name FROM __migrations'
      ).toArray() as Array<{ name: string }>;
      for (const row of rows) appliedSet.add(row.name);
    } catch {
      // __migrations table doesn't exist yet (first run) — treat as empty
    }

    const migrationNames = Object.keys(this.migrations).sort();
    const applied: string[] = [];
    const pending: string[] = [];
    for (const name of migrationNames) {
      if (appliedSet.has(name)) {
        applied.push(name);
      } else {
        pending.push(name);
      }
    }

    return {
      attempts,
      pending,
      applied,
      pitrAvailable,
      pitrUnavailableReason: pitrAvailable ? null : this.pitrUnavailableReason,
      pitrAttemptsRemaining,
    };
  }

  /**
   * Override fetch to ensure migrations run before any request.
   * Handles WebSocket upgrade requests for websocket transport.
   * Subclasses (e.g. Browsable-wrapped DOs) should call ensureMigrations()
   * before delegating to super.fetch().
   */
  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrations();

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('OK');
  }

  /**
   * Handle incoming WebSocket messages.
   * Subclasses (generated DO classes) override this to dispatch actions.
   */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  /**
   * Handle WebSocket close. Echoes close back to the client.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }

  /**
   * Handle WebSocket error. Closes with error code.
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, 'Unexpected error');
  }
}

