# @eagerpatch/durable-db

Zero-configuration database abstraction for Cloudflare Durable Objects with SQLite.

Define your schema with [Drizzle](https://orm.drizzle.team/), query with [Kysely](https://kysely.dev/), validate with [ArkType](https://arktype.io/) -- and let the Vite plugin handle the rest: Durable Object class generation, RPC stubs, migration embedding, and wrangler config patching.

## Table of Contents

- [Quick Start](#quick-start)
- [Defining a Database](#defining-a-database)
- [Writing Actions](#writing-actions)
- [Calling Actions from Your Worker](#calling-actions-from-your-worker)
- [CLI](#cli)
  - [push](#db-push)
  - [generate](#db-generate)
  - [status](#db-status)
  - [reset](#db-reset)
  - [validate](#db-validate)
- [Migration System](#migration-system)
  - [Dev Migrations](#dev-migrations)
  - [Production Migrations](#production-migrations)
  - [Breakpoints](#breakpoints)
  - [Epoch System](#epoch-system)
  - [Typical Workflow](#typical-workflow)
- [Vite Plugin](#vite-plugin)
- [Outerbase Studio Integration](#outerbase-studio-integration)
- [Instance Strategies](#instance-strategies)
- [Action-to-Action Calls](#action-to-action-calls)
- [PITR Safety](#pitr-safety)
- [Architecture](#architecture)
- [Development](#development)

---

## Quick Start

### 1. Install

```bash
pnpm add @eagerpatch/durable-db
```

### 2. Define your schema

```ts
// src/databases/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

### 3. Define your database

```ts
// src/databases/main.ts
import { defineDatabase } from '@eagerpatch/durable-db/db';
import { users } from './schema';

export const { action } = defineDatabase({
  schema: { users },
});
```

### 4. Write actions

```ts
// src/databases/actions/createUser.ts
import { action } from '../main';

export const createUser = action({
  args: {
    name: 'string',
    email: 'string.email',
  },
  handler: async (db, args) => {
    return db
      .insertInto('users')
      .values({
        id: crypto.randomUUID(),
        name: args.name,
        email: args.email,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
});
```

### 5. Add the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { databasePlugin } from '@eagerpatch/durable-db/vite';

export default defineConfig({
  plugins: [
    databasePlugin(),
    cloudflare(),
  ],
});
```

### 6. Use in your worker

```ts
// src/worker.ts
import { runWithTenantId } from '@eagerpatch/durable-db/context';
import { createUser } from './databases/actions/createUser';

// Export the generated Durable Object class
export { MainDatabaseDO } from 'virtual:eagerpatch/databases/__durableObjects';

export default {
  async fetch(request: Request, env: any) {
    return runWithTenantId('my-tenant', async () => {
      const user = await createUser({ name: 'Alice', email: 'alice@example.com' });
      return Response.json(user);
    });
  },
};
```

### 7. Push schema and run

```bash
db push    # Create dev migrations from your schema
pnpm dev             # Start the dev server
```

---

## Defining a Database

Call `defineDatabase()` with a config object. The Vite plugin parses this at build time to generate a Durable Object class.

```ts
import { defineDatabase } from '@eagerpatch/durable-db/db';
import { users, posts } from './schema';

export const { action } = defineDatabase({
  schema: { users, posts },
  instance: 'per-tenant',     // or 'global' (default: 'per-tenant')
  transport: 'rpc',           // or 'websocket' (default: 'rpc')
  browsable: 'development',   // Outerbase Studio integration (default: false)
});
```

The destructured `action` function is your factory for creating database actions.

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `object` | `{}` | Drizzle schema tables |
| `instance` | `'per-tenant' \| 'global'` | `'per-tenant'` | Instance strategy (see [Instance Strategies](#instance-strategies)) |
| `transport` | `'rpc' \| 'websocket'` | `'rpc'` | Transport for action stubs. WebSocket uses Cloudflare's 20:1 message billing ratio for cheaper high-volume calls |
| `browsable` | `boolean \| 'development'` | `false` | Enable Outerbase SQL browsing (see [Outerbase Studio](#outerbase-studio-integration)) |

---

## Writing Actions

Actions are type-safe database operations with runtime argument validation.

```ts
import { action } from '../main';

export const getUser = action({
  args: { userId: 'string' },
  handler: async (db, args, ctx) => {
    return db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', args.userId)
      .executeTakeFirst();
  },
});
```

### The `args` object

Uses [ArkType](https://arktype.io/) syntax for runtime validation:

```ts
args: { name: 'string' }                    // Required string
args: { email: 'string.email' }             // Email validation
args: { limit: 'number > 0' }               // Positive number
args: { offset: 'number >= 0' }             // Non-negative number
args: { tags: 'string[]' }                  // Array of strings
args: { name: 'string', age: 'number?' }    // Optional field
args: { role: "'admin' | 'user'" }           // Literal union
```

### The `handler` function

Receives three arguments:

| Argument | Type | Description |
|----------|------|-------------|
| `db` | `Kysely<Schema>` | Type-safe Kysely query builder bound to your Drizzle schema |
| `args` | inferred from `args` | Validated arguments (ArkType ensures correctness at runtime) |
| `ctx` | `ActionContext` | Context with `env` (Cloudflare bindings) and `instanceKey` |

### File organization

Actions can live inline in the database file or in separate files:

```
src/databases/
  main.ts              # defineDatabase() call
  schema.ts            # Drizzle schema (excluded from action discovery)
  actions/
    createUser.ts      # import { action } from '../main'
    getUser.ts
    listUsers.ts
```

Files named `schema.ts`, `_*.ts`, and `.d.ts` are excluded from action discovery.

---

## Calling Actions from Your Worker

Database actions need a tenant ID to know which Durable Object instance to use. There are two ways to provide it:

### Standalone mode: `runWithTenantId()`

Wrap your request handler in `runWithTenantId()` to provide the tenant ID:

```ts
import { runWithTenantId } from '@eagerpatch/durable-db/context';
import { createUser } from './databases/actions/createUser';
import { listUsers } from './databases/actions/listUsers';

export default {
  async fetch(request: Request, env: any) {
    return runWithTenantId('example-tenant', async () => {
      if (request.method === 'POST') {
        const body = await request.json();
        const user = await createUser({ name: body.name, email: body.email });
        return Response.json(user);
      }

      const users = await listUsers({ limit: 10, offset: 0 });
      return Response.json(users);
    });
  },
};
```

### Framework integration: `setTenantIdResolver()`

If your framework already has its own request-scoped context (e.g. RWSDK's `getRequestInfo()`), use `setTenantIdResolver()` to bridge the two context systems instead of wrapping every request:

```ts
import { setTenantIdResolver } from '@eagerpatch/durable-db/context';
import { getRequestInfo } from 'rwsdk/worker';

setTenantIdResolver(() => getRequestInfo().ctx.session!.shop);
```

The resolver is called at the moment a database operation needs the tenant ID — by which point request middleware (auth, session, etc.) has already completed. This avoids a second AsyncLocalStorage layer when the framework already provides one.

When both are available, `runWithTenantId()` (ALS) takes priority over the resolver.

### How it works

Behind the scenes, each action call is an RPC call to the correct Durable Object instance. The Vite plugin generates stubs that handle instance routing, argument validation, and DO communication transparently.

---

## CLI

The `db` CLI manages your migration lifecycle. All commands share these options:

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --databases-dir <dir>` | `src/databases` | Directory containing database definitions |
| `-v, --verbose` | `false` | Show detailed output |

### `db push`

Push schema changes to dev migrations. This is the command you run most often during development.

```bash
db push
db push --verbose
db push --databases-dir ./src/db
```

**What it does:**

1. Discovers all database files in your databases directory
2. Parses each file for `defineDatabase()` calls
3. For each database:
   - Loads the current production snapshot (`_snapshot.json` in the migrations directory)
   - Checks if the production snapshot has changed since the last push (e.g. a teammate committed a migration) -- if so, **automatically resets dev state** for that database
   - Loads the dev snapshot (falls back to the production snapshot if none exists yet)
   - Generates a fresh snapshot from your current Drizzle schema
   - Diffs the two snapshots to produce SQL migration statements
   - If there are changes: writes an incremental dev migration file (e.g. `0001_dev.sql`) and updates the dev snapshot

**Output example:**

```
[db:push] main: 0001_dev (3 statements)
[db:push] analytics: no changes
```

If a production snapshot change is detected:

```
[db:push] Production snapshot changed for main -- dev state reset
[db:push] main: 0001_dev (1 statement)
```

Dev migrations are stored in `node_modules/.cache/@eagerpatch/durable-db/` and are never committed to git. They are loaded automatically by the Vite plugin in dev mode.

### `db generate`

Generate a production migration from your current schema changes. Run this when you're ready to commit.

```bash
db generate
db generate add_user_bio
db generate --database main
db generate --database main add_posts_table
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[name]` | Optional suffix appended to the timestamp-based migration name |

**Extra flags:**

| Flag | Description |
|------|-------------|
| `--database <db>` | Only generate for this specific database |

**What it does:**

1. Compares your current Drizzle schema against the production snapshot (`_snapshot.json`)
2. Generates SQL statements for the diff
3. Writes a timestamped `.sql` file to the configured `migrationsDir`
4. Updates the production snapshot with a new ID and `prevId` chain
5. Clears dev state for this database (the dev migrations are now superseded by the production migration)

**Output example:**

```
[db:generate] main: 20240315123045_add_user_bio (2 statements)
  -> migrations/main/20240315123045_add_user_bio.sql
```

**Migration file naming:**

- Without name argument: `20240315123045.sql`
- With name argument: `20240315123045_add_user_bio.sql`

### `db status`

Show the current migration status for all databases without making any changes.

```bash
db status
db status --verbose
```

**Output example:**

```
Dev Epoch: m1a2b3c

main
  Production migrations: 3
  Dev migrations: 2
  Uncommitted changes: 1 statement(s)
  Pending SQL:
    ALTER TABLE users ADD COLUMN bio TEXT
  Last push: 2024-03-15T10:30:00.000Z

analytics
  Production migrations: 1
  Dev migrations: 0
  Schema is up to date
```

Shows per-database: production migration count, dev migration count, whether there are uncommitted schema changes (pending SQL statements that haven't been pushed yet), and the last push timestamp.

### `db reset`

Reset dev state and (optionally) create fresh database instances.

```bash
db reset
db reset --keep-epoch
db reset --database main
db reset --database main --keep-epoch
```

**Extra flags:**

| Flag | Description |
|------|-------------|
| `--keep-epoch` | Only clear dev migrations; keep the same DO instances |
| `--database <db>` | Only reset this specific database |

**Two modes:**

| Mode | What happens |
|------|-------------|
| **Full reset** (default) | Bumps the epoch. All local DO instances start fresh on next access. Clears all dev migrations and snapshots. |
| **Keep epoch** (`--keep-epoch`) | Only clears dev migrations and snapshots. Existing DO instances keep running with their current data. |

**Output example:**

```
[db:reset] New epoch: m1a2b3c -> n4d5e6f
[db:reset] main: reset
[db:reset] analytics: reset
```

### `db validate`

Dry-run all migrations against a local in-memory SQLite database to catch errors before deployment.

```bash
db validate
db validate --database main
db validate --no-dev
db validate --verbose
```

**Extra flags:**

| Flag | Description |
|------|-------------|
| `--database <db>` | Only validate this specific database |
| `--no-dev` | Skip dev migrations, only validate production migrations |

**What it does:**

1. Creates an in-memory SQLite database using `libsql`
2. Applies all migrations sequentially (production + dev, unless `--no-dev`)
3. Builds the expected schema separately from the Drizzle definition
4. Compares the migrated schema against the expected schema to detect drift
5. Reports SQL errors, foreign key violations, or schema mismatches

**Output example (success):**

```
[db:validate] main: 5 migrations applied (3 prod, 2 dev)
[db:validate] main: schema matches
[db:validate] All validations passed
```

**Output example (failure):**

```
[db:validate] main: error in migration 20240315123045_bad
  near "INVALID": syntax error
[db:validate] Validation failed
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | All validations passed |
| `1` | Validation errors found |

### Programmatic API

All CLI functions are also available for integration into other tools:

```ts
import * as db from '@eagerpatch/durable-db/cli';

const pushResults = await db.push({ verbose: true });
const statusResults = await db.status();
const generateResults = await db.generate({}, { name: 'add_bio' });
const resetResult = await db.reset({}, { keepEpoch: false });
const validateResults = await db.validate({}, { includeDev: true });
```

---

## Migration System

### Dev Migrations

Dev migrations are ephemeral migration files used during development for fast iteration.

- **Created by**: `db push` or the Vite plugin's `autoMigrations` feature
- **Location**: `node_modules/.cache/@eagerpatch/durable-db/databases/<dbName>/migrations/`
- **Naming**: Sequential -- `0001_dev.sql`, `0002_dev.sql`, etc.
- **Lifecycle**: Cleared when you run `db generate` (consolidated into production) or `db reset`
- **Never committed to git**

The Vite plugin automatically loads dev migrations in dev mode and appends them after production migrations when generating the DO class.

### Production Migrations

Production migrations are the canonical migrations committed to your repository.

- **Created by**: `db generate`
- **Location**: The `migrationsDir` configured in the Vite plugin (e.g. `migrations/main/`)
- **Naming**: Timestamp-based -- `20240315123045.sql` or `20240315123045_description.sql`
- **Lifecycle**: Permanent, committed to git, deployed to production
- **Snapshot**: Each `generate` also updates `_snapshot.json` in the migrations directory (tracks schema state with `id`/`prevId` chain)

### Breakpoints

Long migrations can be split into chunks using the `--> breakpoint` marker:

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);

--> breakpoint

CREATE INDEX idx_users_name ON users(name);

--> breakpoint

CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT REFERENCES users(id));
```

Each chunk is tracked independently in the `__migrations` table. If a Durable Object restarts mid-migration, it resumes from the last completed chunk rather than re-running from the start.

### Epoch System

In development, each database instance key gets an epoch suffix to enable clean resets:

| Environment | Instance key |
|-------------|-------------|
| Production | `example-tenant` |
| Development | `example-tenant__dev_m1a2b3c` |

When you run `db reset` (without `--keep-epoch`), a new epoch is generated. This causes all subsequent DO accesses to create fresh instances, effectively giving you a clean database without data from previous iterations.

The epoch is a base36-encoded timestamp stored in `node_modules/.cache/@eagerpatch/durable-db/state.json`.

### Dev State Structure

```
node_modules/.cache/@eagerpatch/durable-db/
  state.json                          # Global state (epoch, per-db counters)
  databases/
    main/
      _snapshot.json                  # Dev snapshot (schema state)
      migrations/
        0001_dev.sql
        0002_dev.sql
    analytics/
      _snapshot.json
      migrations/
        0001_dev.sql
```

The `state.json` file tracks:

```json
{
  "epoch": "m1a2b3c",
  "databases": {
    "main": {
      "prodSnapshotHash": "abc123...",
      "lastPush": "2024-03-15T10:30:00.000Z",
      "devMigrationCount": 2
    }
  }
}
```

### Typical Workflow

**During development:**

```bash
# 1. Edit your Drizzle schema
# 2. Push changes to dev migrations
db push

# 3. Run the dev server -- migrations apply automatically on DO access
pnpm dev

# 4. Iterate: edit schema -> push -> refresh browser
# 5. If you need a clean slate:
db reset
```

**Ready to deploy:**

```bash
# 1. Generate a production migration
db generate add_user_profiles

# 2. Validate before deploying
db validate

# 3. Commit the migration file and updated snapshot
git add migrations/
git commit -m "Add user profiles migration"

# 4. Deploy
```

**Team collaboration:**

When a teammate commits a production migration, `db push` automatically detects the snapshot hash change and resets your dev state for that database. Your next push rebuilds dev migrations cleanly on top of the new production baseline.

---

## Vite Plugin

```ts
import { databasePlugin } from '@eagerpatch/durable-db/vite';

databasePlugin({
  databasesDir: 'src/databases',   // Where database files live
  migrationsDir: 'migrations',     // Where production migrations live
  autoMigrations: 'development',   // Auto-run push in dev mode
});
```

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databasesDir` | `string` | `'src/databases'` | Directory containing database definition files |
| `migrationsDir` | `string` | `'migrations'` | Directory for production migrations, relative to project root. Each database gets a subdirectory (e.g. `migrations/main/`) |
| `autoMigrations` | `boolean \| 'development'` | `'development'` | Auto-push schema changes on dev server start. Set to `true` to also auto-generate in build mode, or `false` to disable |
| `contextImport` | `string` | `'@eagerpatch/durable-db/context'` | Import path for the context module (for framework integrations) |
| `registryImport` | `string` | `'@eagerpatch/durable-db/registry'` | Import path for the action registry module (for framework integrations) |

### What the plugin does

1. **Discovery**: Finds all `defineDatabase()` files in your databases directory (excludes `schema.ts`, `_*.ts`, `.d.ts`)
2. **AST Parsing**: Uses Babel to extract database config and action definitions (no regexes)
3. **Migration Loading**: Loads production migrations from disk; in dev mode also loads dev migrations from cache
4. **Code Generation**: Produces a virtual module (`virtual:eagerpatch/databases/__durableObjects`) containing Durable Object classes with embedded migrations and RPC dispatch methods
5. **Action Transform**: Replaces `action()` call-sites with RPC stubs + `registerAction()` calls so actions can be called like regular functions from your worker
6. **Wrangler Patching**: Automatically updates `wrangler.jsonc` with Durable Object bindings and SQLite migration entries
7. **HMR**: Watches database files and invalidates the virtual module on change

### Generated Class Naming

For each `defineDatabase()` call, the plugin generates a class based on the filename:

| Filename | Class Name | Binding Name |
|----------|-----------|-------------|
| `main.ts` | `MainDatabaseDO` | `MAIN_DATABASE_DO` |
| `analytics.ts` | `AnalyticsDatabaseDO` | `ANALYTICS_DATABASE_DO` |
| `user-data.ts` | `UserDataDatabaseDO` | `USER_DATA_DATABASE_DO` |

Export the generated class from your worker entry point:

```ts
export { MainDatabaseDO } from 'virtual:eagerpatch/databases/__durableObjects';
```

### Action Transformation

The plugin transforms each `action()` definition into two things:

1. **A registry registration** (handler + ArkType validator) -- runs inside the DO
2. **An RPC stub function** (exported under the same name) -- runs in your worker

The stub function:
- Validates args with ArkType
- Checks if we're already inside the same DO (via AsyncLocalStorage) for a fast direct-call path
- Otherwise, resolves the DO instance via `env.BINDING.idFromName(instanceKey)` and calls `stub.rpc()`

---

## Outerbase Studio Integration

[Outerbase Studio](https://github.com/outerbase/browsable-durable-object) provides a web UI and SQL endpoint for inspecting SQLite tables inside Durable Objects.

### Configuration

Add `browsable` to your `defineDatabase()` config:

```ts
export const { action } = defineDatabase({
  schema: { users, posts },
  browsable: 'development', // Enable in dev mode only
});
```

### Options

| Value | Behavior |
|-------|----------|
| `false` | Disabled (default) |
| `true` | Always enabled (dev and production) |
| `'development'` | Enabled only when running `vite dev` / `vite serve` |

### How it works

When `browsable` is enabled, the Vite plugin wraps the generated Durable Object class with Outerbase's `Browsable()` decorator. This adds:

- A `fetch()` handler that serves `/query/raw` for direct SQL access
- A `__studio()` RPC method used by the Outerbase Studio web UI

The `'development'` value is resolved at build time: the Vite plugin checks `config.command === 'serve'` and only applies the decorator when running in dev mode.

Migrations are guaranteed to run before any browsable request — the generated class overrides both `fetch()` and `__studio()` to call `ensureMigrations()` first.

### Adding the Studio UI

To serve the Outerbase Studio web interface, add a route in your worker that calls the `studio()` helper:

```ts
import { studio } from '@outerbase/browsable-durable-object';

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    if (url.pathname === '/studio') {
      return studio(request, env.MAIN_DATABASE_DO);
    }

    // ... rest of your routes
  },
};
```

Then visit `/studio` in your browser. You'll be prompted to enter a DO instance name (e.g. your tenant ID), and Outerbase Studio will open with full SQL access to that instance.

### Querying a Durable Object directly

You can also query a DO's SQL endpoint directly without the Studio UI:

```bash
curl -X POST http://your-do-endpoint/query/raw \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT * FROM users LIMIT 10"}'
```

### Security

The browsable endpoint has **no built-in authentication**. For production use (`browsable: true`), add your own authentication middleware or restrict access at the network level.

Using `browsable: 'development'` is recommended -- it enables the endpoint only during local development and excludes it from production builds entirely.

---

## Instance Strategies

### `per-tenant` (default)

Each tenant gets its own Durable Object instance, keyed by the tenant ID provided via `runWithTenantId()` or `setTenantIdResolver()`.

```ts
defineDatabase({
  schema: { users },
  instance: 'per-tenant',
});
```

### `global`

A single shared Durable Object instance for all requests, keyed by the string `'global'`.

```ts
defineDatabase({
  schema: { settings },
  instance: 'global',
});
```

---

## Action-to-Action Calls

Actions can call other actions. The Vite plugin detects these calls at build time and routes them correctly.

```ts
// actions/createUser.ts
import { action } from '../main';
import { getUserByEmail } from './getUserByEmail';

export const createUser = action({
  args: { name: 'string', email: 'string.email' },
  handler: async (db, args) => {
    // This calls another action in the same database
    const existing = await getUserByEmail({ email: args.email });
    if (existing) throw new Error('User already exists');

    return db.insertInto('users').values({
      id: crypto.randomUUID(),
      name: args.name,
      email: args.email,
      created_at: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
  },
});
```

### Routing behavior

- **Same database**: The call uses a direct fast path via AsyncLocalStorage (no RPC overhead). The registry detects that we're already inside the target DO and calls the handler directly.
- **Cross database**: The call routes through RPC to the other database's Durable Object, using the appropriate instance key based on the target database's strategy.

---

## PITR Safety

On Cloudflare with Point-in-Time Recovery (PITR) enabled, migrations are protected with automatic snapshots.

### How it works

1. Before running migrations, the DO increments a retry counter and takes a PITR bookmark
2. Migrations are applied (this is the second write, after the counter increment)
3. On success: the retry counter is reset to 0
4. On failure: the DO schedules a restore to the pre-migration bookmark and aborts
5. On next access, the DO restarts with the counter already incremented (the counter write was before the bookmark)
6. After 3 consecutive failures, PITR restore is skipped and the error propagates so the developer can fix the migration and redeploy

This prevents broken migrations from permanently corrupting data while giving developers a clear signal to fix the issue.

### Diagnostic methods

The `SqliteDurableObject` base class provides methods for inspecting migration state:

- `getMigrationAttempts()` -- Returns `{ attemptCount, lastAttemptAt, lastError }`
- `getMigrationBookmark()` -- Returns the current PITR bookmark string, or `null` if PITR is unavailable
- `restoreToBookmark(bookmark)` -- Manually trigger a PITR restore

---

## Architecture

### Module Map

| Export path | Source | Purpose |
|---|---|---|
| `./db` | `src/db/` | `defineDatabase()`, `SqliteDurableObject`, Kysely plugins |
| `./vite` | `src/vite/databasePlugin.ts` | Vite plugin (`databasePlugin`) |
| `./vite/modules` | `src/vite/modules/` | Plugin internals: discovery, AST parsing, code generation, wrangler patching |
| `./context` | `src/context/` | Tenant ID context (`runWithTenantId`, `getTenantId`, `setTenantIdResolver`) |
| `./migrations` | `src/migrations/` | Snapshot-based migration generation via drizzle-kit |
| `./registry` | `src/registry.ts` | Action registry and RPC dispatch (`registerAction`, `getAction`, `callAction`) |
| `./cli` | `src/cli/` | CLI commands (`push`, `generate`, `status`, `reset`, `validate`) and `db` binary |

### Request Flow

```
Worker fetch()
  -> runWithTenantId() or setTenantIdResolver()  // Provide tenant ID
    -> createUser({ name, email })               // Looks like a normal function call
      -> ArkType validates args
      -> getTenantId()                           // ALS store → resolver → throw
      -> Check AsyncLocalStorage for DO-local short path
      -> If same DO: direct handler call (no RPC)
      -> If cross-DO: env.BINDING.idFromName(instanceKey) -> stub.rpc()
        -> DO.rpc(method, args, rpcContext)
          -> ensureMigrations()                  // Run pending migrations if any
          -> getAction(dbName, method)           // Look up handler in registry
          -> Validate args with ArkType
          -> runWithDoContext(...)                // Set up AsyncLocalStorage
            -> handler(db, validatedArgs, ctx)   // Your action code runs here
```

### Kysely Plugins

The library includes plugins for transparent data mapping between JavaScript and SQLite:

- **CamelCasePlugin**: Converts `camelCase` JS property names to `snake_case` SQL column names and back
- **SchemaPlugin**: Schema-aware version of CamelCasePlugin that uses Drizzle metadata for precise column mapping (handles non-standard mappings)
- **DateSerializePlugin**: Converts `Date` objects to ISO strings (`YYYY-MM-DD HH:MM:SS`) for SQLite storage, and parses them back on read

---

## Development

```bash
pnpm install      # Install dependencies
pnpm build        # Build with tsdown -> dist/
pnpm dev          # Build in watch mode
pnpm test         # Run vitest in watch mode
pnpm test:run     # Run tests once
```

Run a single test file:

```bash
npx vitest run tests/db/defineDatabase.test.ts
```

Run the example apps:

```bash
cd examples/simple && pnpm dev
cd examples/rwsdk && pnpm dev
```

### Project Structure

```
src/
  cli/              # CLI commands and state management
    bin.ts          # Binary entry point (commander)
    push.ts         # Push command implementation
    generate.ts     # Generate command implementation
    status.ts       # Status command implementation
    reset.ts        # Reset command implementation
    validate.ts     # Validate command implementation
    state.ts        # Dev state persistence (epoch, snapshots, counters)
  context/          # AsyncLocalStorage-based request context
  db/               # Core database abstractions
    SqliteDurableObject.ts   # Base DO class with migrations + PITR
    defineDatabase.ts        # defineDatabase() API
    plugins.ts               # Kysely plugins (CamelCase, Date, Schema)
    types.ts                 # TypeScript type definitions
  migrations/       # Snapshot-based migration generation
    snapshot.ts     # Drizzle schema -> snapshot diffing
    generator.ts    # Migration file reading/writing
  registry.ts       # Action registration and RPC dispatch
  vite/
    databasePlugin.ts        # Vite plugin entry
    modules/
      discovery.ts           # Database file discovery
      parser.ts              # Babel AST parsing
      generator.ts           # DO class and stub code generation
      wrangler.ts            # wrangler.jsonc auto-patching
tests/              # Mirrors src/ structure
examples/
  simple/           # Basic Cloudflare Worker example
  rwsdk/            # Multi-tenant analytics API with RWSDK + WebSocket transport
```
