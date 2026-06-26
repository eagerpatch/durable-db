import { DurableObject } from 'cloudflare:workers';
import { Kysely } from 'kysely';
import { debugMigrations } from '../utils/debug';
import {
  createKyselyFromSql,
  type CreateKyselyOptions,
  type SqlExecutor,
} from './kysely';

// The Kysely-over-SqlStorage bridge lives in ./kysely so it can be imported
// without pulling in `cloudflare:workers` (e.g. the durable-db/testing harness
// runs it under plain Node). Re-exported here to preserve the public API.
export { createKyselyFromSql };
export type { CreateKyselyOptions, SqlExecutor };

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
 * Raised when a pending migration fails with "already exists": the storage
 * holds schema objects the `__migrations` journal doesn't track. Common
 * causes: migration files were renamed or regenerated after the storage was
 * created, the storage was written by an older version of the database, or a
 * previous attempt crashed partway through a chunk without PITR. Re-running
 * can never succeed, so this carries recovery guidance instead of the raw
 * SQLITE_ERROR.
 */
export class MigrationSchemaConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationSchemaConflictError';
  }
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

        // Schedule the restore BEFORE logging that we're restoring. Some
        // runtimes (local workerd) hand out bookmarks from
        // getCurrentBookmark() but don't implement the restore call — there
        // an error-level "PITR restore failed" line reads like a second
        // failure for a backend that was never going to support it, so we
        // disable PITR for this instance and only debug-log it. A restore
        // failure on a backend that *does* claim PITR support is still
        // logged at error level, but the ORIGINAL migration error is what
        // propagates either way — that's what the user needs to fix.
        let restoreScheduled = false;
        try {
          await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
          restoreScheduled = true;
        } catch (pitrErr) {
          const pitrMessage = pitrErr instanceof Error ? pitrErr.message : String(pitrErr);
          if (/does not (?:implement|support) point-in-time recovery/i.test(pitrMessage)) {
            this.pitrAvailable = false;
            this.pitrUnavailableReason = pitrMessage;
            debugMigrations('PITR restore unsupported by this storage backend; disabling PITR (%s)', pitrMessage);
          } else {
            console.error(
              `[database] PITR restore failed (${pitrMessage}). ` +
              `Propagating the original migration error instead so you can fix the root cause.`
            );
          }
        }

        if (restoreScheduled) {
          const attempts = this.getMigrationAttempts();
          const remaining = Math.max(0, MAX_PITR_ATTEMPTS + 1 - attempts.attemptCount);
          const pendingNames = Array.from(new Set(pending.map(p => p.name))).join(', ');
          console.error(
            `[database] Migration failed (attempt ${attempts.attemptCount}/${MAX_PITR_ATTEMPTS + 1}, ` +
            `${remaining} PITR-protected retries remaining). ` +
            `Restoring to pre-migration bookmark. Pending: ${pendingNames || '(none)'}.`,
            error
          );

          // abort() throws in production — the DO tears down and restarts
          // with the restored state (counter included, since it was written
          // before the bookmark). In runtimes where abort() returns, fall
          // through to propagating the migration error.
          this.ctx.abort('Restoring to pre-migration bookmark');
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
        throw this.toSchemaConflictError(error, name, chunkIndex) ?? error;
      }
    }
  }

  /**
   * Translate an "already exists" failure on a pending migration into a
   * {@link MigrationSchemaConflictError}. A chunk is only executed when the
   * journal has no row for it, so "already exists" means storage and journal
   * disagree about what has been applied — retrying can never succeed, and
   * the raw SQLITE_ERROR doesn't tell the user how to get unstuck.
   * Returns null when the error isn't this case.
   */
  private toSchemaConflictError(
    error: unknown,
    name: string,
    chunkIndex: number
  ): MigrationSchemaConflictError | null {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) return null;

    let journalNames: string[] = [];
    try {
      journalNames = (this.sql.exec(
        'SELECT DISTINCT name FROM __migrations'
      ).toArray() as Array<{ name: string }>).map((row) => row.name);
    } catch {
      // Journal unreadable — fall through to the generic guidance.
    }

    const known = new Set(Object.keys(this.migrations));
    const untracked = journalNames.filter((n) => !known.has(n));

    const likelyCause = untracked.length > 0
      ? `The journal records migrations this build doesn't know about (${untracked.join(', ')}), ` +
        `which usually means the migration files were renamed or regenerated after this ` +
        `database's storage was created.`
      : `This usually means the storage was created by migrations under different names ` +
        `(renamed or regenerated migration files), by an older version of this database, ` +
        `or that a previous attempt crashed partway through a chunk.`;

    return new MigrationSchemaConflictError(
      `Migration "${name}" (chunk ${chunkIndex}) tried to create a schema object that ` +
      `already exists in storage, but the __migrations journal has no record of this ` +
      `migration being applied. ${likelyCause} ` +
      `To recover in local dev, run \`db reset\` to rotate to a fresh database ` +
      `(add --purge-local-storage to also delete the orphaned instance data, or wipe ` +
      `.wrangler/state yourself). In production, restore the original migration names, or ` +
      `baseline the journal by inserting rows into __migrations for the migrations whose ` +
      `schema is already present. ` +
      `Original error: ${message}`,
      { cause: error }
    );
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

