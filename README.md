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
- [Recovery Workflows](#recovery-workflows)
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
import { table, text, integer } from '@eagerpatch/durable-db/schema';

export const users = table('users', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});
```

Column names are derived from JS property keys and auto-converted to snake_case (e.g. `createdAt` → `created_at`). Table names passed to `table()` are also auto-snake_cased.

**Date columns**: use `integer({ mode: 'timestamp' })` and pass `Date` values — they round-trip as `Date` objects automatically. Plain `text()` columns always round-trip verbatim: if you store an ISO string (`new Date().toISOString()`), you get the exact same string back, never a `Date`.

> ⚠️ All tables referenced in `defineDatabase({ schema })` must be **exported from the schema module** and imported into the database file. Tables defined inline in the database file (or not exported) cannot be loaded by the migration CLI — `db push`/`db generate` will fail with an explicit error rather than silently generating empty migrations.

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
        createdAt: new Date(),
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
import { setTenantIdResolver } from '@eagerpatch/durable-db/context';
import { createUser } from './databases/actions/createUser';

// In a real app, resolve from authentication/session
setTenantIdResolver(() => 'my-tenant');

// Export the generated Durable Object classes
export * from 'virtual:eagerpatch/durable-db/__durableObjects';

export default {
  async fetch(request: Request, env: any) {
    const user = await createUser({ name: 'Alice', email: 'alice@example.com' });
    return Response.json(user);
  },
};
```

For TypeScript support, add `@eagerpatch/durable-db/virtual` to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@eagerpatch/durable-db/virtual"]
  }
}
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
  main.ts              # defineDatabase() call (may also contain action() definitions)
  schema.ts            # Drizzle schema (excluded from action discovery)
  actions/
    createUser.ts      # import { action } from '../main'
    getUser.ts
    listUsers.ts
```

Both styles are fully supported: the Vite plugin transforms `action()` definitions in the database file itself exactly like those in separate files — they're registered with the DO and rewritten into RPC stubs.

Files named `schema.ts`, `_*.ts`, and `.d.ts` are excluded from action discovery.

---

## Calling Actions from Your Worker

For `per-tenant` databases, actions need a tenant ID to know which Durable Object instance to use. Call `setTenantIdResolver()` once at startup to provide it:

```ts
import { setTenantIdResolver } from '@eagerpatch/durable-db/context';
import { createUser } from './databases/actions/createUser';
import { listUsers } from './databases/actions/listUsers';

// In a real app, resolve from authentication/session
setTenantIdResolver(() => 'example-tenant');

export default {
  async fetch(request: Request, env: any) {
    if (request.method === 'POST') {
      const body = await request.json();
      const user = await createUser({ name: body.name, email: body.email });
      return Response.json(user);
    }

    const users = await listUsers({ limit: 10, offset: 0 });
    return Response.json(users);
  },
};
```

### Framework integration

If your framework has request-scoped context (e.g. RWSDK's `getRequestInfo()`), use the resolver to bridge the two:

```ts
import { setTenantIdResolver } from '@eagerpatch/durable-db/context';
import { getRequestInfo } from 'rwsdk/worker';

setTenantIdResolver(() => getRequestInfo().ctx.session!.shop);
```

The resolver is called at the moment a database operation needs the tenant ID — by which point request middleware (auth, session, etc.) has already completed.

### How it works

Behind the scenes, each action call is an RPC call to the correct Durable Object instance. The Vite plugin generates stubs that handle instance routing, argument validation, and DO communication transparently.

---

## CLI

The `db` CLI manages your migration lifecycle. All commands share these options:

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --databases-dir <dir>` | `src/databases` | Directory containing database definitions |
| `-v, --verbose` | `false` | Show detailed output |

**Schema loading is strict.** When a database declares tables in `defineDatabase({ schema })`, every command that loads the schema (`push`, `generate`, `status`, `validate`) fails with exit code 1 — instead of reporting "no changes" — if:

- the tables are defined inline in the database file instead of a schema module
- the schema import can't be resolved
- the schema module fails to build
- any declared table is missing from the schema module's exports

A database with no `schema` declared at all is still skipped silently — that's a valid (if unusual) configuration.

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
   - Generates a fresh snapshot from your current Drizzle schema
   - Diffs the two snapshots to produce SQL migration statements
   - If there are changes: replaces any previous dev migration with a **single squashed migration** named after a hash of its content (e.g. `dev_a1b2c3d4.sql`). `CREATE TABLE`/`CREATE INDEX` statements get `IF NOT EXISTS` added so the squashed migration can overlay tables a previous dev migration already created
   - If the same content hash already exists, nothing is rewritten — the DO recognizes the migration name and skips it

**Output example:**

```
✓ main: dev_a1b2c3d4 (3 statements)
· analytics: no changes
```

When nothing changed anywhere:

```
· main: no changes
· analytics: no changes

All databases are up to date.
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
✓ main: 20240315123045_add_user_bio
  → migrations/main/20240315123045_add_user_bio.sql
  2 statement(s)
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

📦 main
   Production migrations: 3
   Dev migrations: 1
   📝 Uncommitted changes: 1 statement(s)
   Pending SQL:
     - ALTER TABLE users ADD COLUMN bio TEXT
   Last push: 2024-03-15T10:30:00.000Z

📦 analytics
   Production migrations: 1
   Dev migrations: 0
   ✓ Schema is up to date
```

Shows per-database: production migration count, dev migration count, whether there are uncommitted schema changes (pending SQL statements that haven't been pushed yet), and the last push timestamp. If a teammate committed new production migrations since your last push, a `⚠️ Production snapshot changed - run 'db:reset' to sync` warning appears.

### `db reset`

Reset dev state and create fresh database instances via an epoch bump.

```bash
db reset
db reset --keep-epoch
db reset --database main
db reset --database main --keep-epoch
db reset --purge-local-storage
```

**Extra flags:**

| Flag | Description |
|------|-------------|
| `--keep-epoch` | Only clear dev migrations; keep the same DO instances |
| `--database <db>` | Only reset this specific database |
| `--purge-local-storage` | Also delete workerd's persisted DO storage under `.wrangler/` (requires the dev server to be stopped) |

**Two modes:**

| Mode | What happens |
|------|-------------|
| **Full reset** (default) | Bumps the epoch. All databases rotate to brand-new DO instances on the next request — fresh, empty SQLite with migrations re-applied. Clears all dev migrations and snapshots. Works while the dev server is running. |
| **Keep epoch** (`--keep-epoch`) | Only clears dev migrations and snapshots. Existing DO instances keep running with their current data. |

**How fresh instances work**: in dev, every DO instance key is suffixed with the current epoch (`<key>__dev_<epoch>`) by the generated stubs. Bumping the epoch makes `idFromName()` resolve to entirely new DO instances, so the old tables can never collide with the new schema. The Vite dev server watches the dev-state file and reloads automatically when the epoch changes — no restart needed.

**Disk space**: the previous instances' SQLite files stay orphaned under `.wrangler/state/v3/do` until you purge them. Run `db reset --purge-local-storage` (with the dev server **stopped** — workerd keeps deleted storage open and breaks with `internal error; reference = …` until restart) or simply `rm -rf .wrangler` whenever you want the disk back. With `--database <db>`, only the storage directories matching that database's DO class are purged.

**Output example:**

```
✓ New epoch: n4d5e6f — databases start fresh on the next request
✓ Reset databases: main, analytics
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
✓ main: 5 migration(s) (includes dev migrations)
  Schema matches ✓
```

**Output example (failure):**

```
✗ main: 5 migration(s)
  ✗ 20240315123045_bad[0]: near "INVALID": syntax error
```

Schema drift (migrations ran cleanly but produce a different schema than your Drizzle definition) is reported as:

```
  ⚠ Schema drift detected:
    [missing] table users: column bio
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
const resetResult = await db.reset({}, { keepEpoch: false, purgeLocalStorage: false });
const validateResults = await db.validate({ noDev: false });
```

---

## Migration System

### Dev Migrations

Dev migrations are ephemeral migration files used during development for fast iteration.

- **Created by**: `db push`
- **Location**: `node_modules/.cache/@eagerpatch/durable-db/databases/<dbName>/migrations/`
- **Naming**: Content-hash based -- a single squashed `dev_<hash>.sql` that is replaced (not appended to) on every push with changes. The deterministic name lets the DO skip migrations it has already applied
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

**How the epoch reaches the worker**: the Vite plugin serves a virtual module (`virtual:eagerpatch/durable-db/__devEpoch`) exporting `applyDevEpoch(key)`, and every generated stub routes its instance key through it. In dev the plugin embeds the current epoch from `state.json`; in production builds the epoch is `null` and `applyDevEpoch` is the identity function, so production keys are never suffixed. The dev server watches durable-db's dev cache directory and reloads on change, so both `db reset` (new epoch → fresh instances) and `db push` (new dev migration → re-embedded into the DO module) take effect on the next request without restarting.

### Dev State Structure

```
node_modules/.cache/@eagerpatch/durable-db/
  state.json                          # Global state (epoch, per-db push info)
  databases/
    main/
      _snapshot.json                  # Dev snapshot (schema state)
      migrations/
        dev_a1b2c3d4.sql              # Single squashed dev migration (content-hash name)
    analytics/
      _snapshot.json
      migrations/
        dev_e5f6a7b8.sql
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
# 5. If you need a clean slate (works while the dev server is running):
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

`db push` always diffs against the *current* production snapshot, so after pulling a teammate's migration your next push rebuilds the squashed dev migration on top of the new baseline automatically. If your local DO instances already applied an outdated dev migration, run `db reset` to rotate to fresh instances — `db status` warns with `⚠️ Production snapshot changed` when this applies.

---

## Vite Plugin

```ts
import { databasePlugin } from '@eagerpatch/durable-db/vite';

databasePlugin({
  databasesDir: 'src/databases',   // Where database files live
  migrationsDir: 'migrations',     // Where production migrations live
});
```

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databasesDir` | `string` | `'src/databases'` | Directory containing database definition files |
| `migrationsDir` | `string` | `'migrations'` | Directory for production migrations, relative to project root. Each database gets a subdirectory (e.g. `migrations/main/`) |
| `contextImport` | `string` | `'@eagerpatch/durable-db/context'` | Import path for the context module (for framework integrations) |
| `registryImport` | `string` | `'@eagerpatch/durable-db/registry'` | Import path for the action registry module (for framework integrations) |

### What the plugin does

1. **Discovery**: Finds all `defineDatabase()` files in your databases directory (excludes `schema.ts`, `_*.ts`, `.d.ts`)
2. **AST Parsing**: Uses Babel to extract database config and action definitions (no regexes)
3. **Migration Loading**: Loads production migrations from disk; in dev mode also loads dev migrations from cache
4. **Code Generation**: Produces a virtual module (`virtual:eagerpatch/durable-db/__durableObjects`) containing Durable Object classes with embedded migrations and RPC dispatch methods, plus a `virtual:eagerpatch/durable-db/__devEpoch` module that suffixes DO instance keys with the dev epoch (identity in production builds)
5. **Action Transform**: Replaces `action()` call-sites with RPC stubs + `registerAction()` calls so actions can be called like regular functions from your worker. This applies to actions in separate files *and* actions defined in the database file itself
6. **Wrangler Patching**: Automatically updates `wrangler.jsonc` with Durable Object bindings and SQLite migration entries
7. **HMR**: Watches database files and invalidates the virtual module on change

### Generated Class Naming

For each `defineDatabase()` call, the plugin generates a class based on the filename:

| Filename | Class Name | Binding Name |
|----------|-----------|-------------|
| `main.ts` | `MainDatabaseDO` | `MAIN_DATABASE_DO` |
| `analytics.ts` | `AnalyticsDatabaseDO` | `ANALYTICS_DATABASE_DO` |
| `user-data.ts` | `UserDataDatabaseDO` | `USER_DATA_DATABASE_DO` |

Export the generated classes from your worker entry point:

```ts
export * from 'virtual:eagerpatch/durable-db/__durableObjects';
```

### Action Transformation

The plugin transforms each `action()` definition into two things:

1. **A registry registration** (handler + ArkType validator) -- runs inside the DO
2. **An RPC stub function** (exported under the same name) -- runs in your worker

The stub function:
- Validates args with ArkType
- Checks if we're already inside the same DO (via AsyncLocalStorage) for a fast direct-call path
- Computes the instance key (`getTenantId()` or `"global"`) and routes it through `applyDevEpoch()` (dev-epoch suffix in dev, identity in production — see [Epoch System](#epoch-system))
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
import { studio } from '@eagerpatch/durable-db/db';

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

Each tenant gets its own Durable Object instance, keyed by the tenant ID provided via `setTenantIdResolver()`.

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
      createdAt: new Date(),
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

## Recovery Workflows

This section covers what to do when things go wrong. The goal is to give you a clear playbook for the common failure modes instead of guessing.

### Migration keeps failing past the PITR cap

After 3 consecutive failed migration attempts, PITR restore is skipped and the error surfaces on every request. The DO will log:

```
[database] Migration has failed 3 times. PITR restore disabled -- fix the migration and redeploy.
```

**Do this:**

1. Inspect current state with `getMigrationStatus()` on the DO -- it returns `{ attempts, pending, applied, pitrAvailable, pitrAttemptsRemaining }`, so you can see exactly which migration is stuck and how many PITR retries are left. (`getMigrationAttempts()` still exists if you only need the attempts counter.)
2. Fix the offending `.sql` file in `migrations/<db>/`. Typical culprits: non-nullable column added without a default, a `DROP COLUMN` on a table with data, an index name collision.
3. Redeploy. The next request will attempt the (now fixed) migration against the pre-migration state -- no manual reset needed.
4. If you're certain the DO is already in a bad state (e.g. a migration was half-applied before the bookmark logic landed), call `restoreToBookmark(bookmark)` manually from a worker route with a known-good bookmark, then redeploy.

**Don't** try to delete or rewrite a migration that's already been applied in production -- it'll be skipped on machines that already ran it and break machines that haven't. Always forward-fix with a new migration.

### Local dev: start from scratch

In development, migrations run against ephemeral state cached under `node_modules/.cache/@eagerpatch/durable-db/`. Use whichever matches your situation:

- **Reset one tenant's data while keeping schema**: call `destroyDatabase()` from a route. This runs `ctx.storage.deleteAll()` on the current tenant's DO and re-runs migrations on the next call.
- **Reset _every_ tenant's data for a database**: run `pnpm db reset` (or `pnpm db reset --database main`) — the dev server can keep running. Instance keys get a new `__dev_<epoch>` suffix, so every tenant rotates to a brand-new DO with empty SQLite on the next request. Add `--purge-local-storage` (dev server stopped) when you also want the orphaned instances' files deleted from `.wrangler/`.
- **Drop everything and re-derive migrations from the schema**: `rm -rf node_modules/.cache/@eagerpatch/durable-db` and restart `pnpm dev`. The plugin regenerates dev migrations from the current schema.

### Snapshot corruption (`_snapshot.json`)

The `_snapshot.json` file in each `migrations/<db>/` directory is the source of truth for what schema the migration history represents. If it's been hand-edited, merged badly, or lost:

1. `pnpm db validate` -- this will compare your live schema against what the snapshot claims and flag drift.
2. If only the snapshot is missing but the `.sql` files are correct, delete `_snapshot.json` and run `pnpm db generate`. It will reconstruct the snapshot by replaying migration history.
3. If both `_snapshot.json` and an SQL file are out of sync: check `git log -- migrations/<db>/` for the last known-good revision and restore from there. Never regenerate by hand -- let `db generate` produce the diff.

### "Action not registered" / "Missing binding" at runtime

These errors now include the list of available actions/bindings so you can see what _is_ wired up. Typical causes:

- **Action not registered**: the action file didn't match the Vite plugin's discovery rules (see the [Vite Plugin](#vite-plugin) section). Files named `schema.ts`, `_*.ts`, or `*.d.ts` are excluded.
- **Missing binding**: the target database `.ts` file isn't in `databasesDir`, or the wrangler config wasn't patched (check `wrangler.jsonc` for a `durable_objects.bindings` entry). A full Vite restart regenerates bindings.

### WebSocket transport hangs

Pending requests time out after 30s by default and reject with `WebSocket request '<action>' timed out after 30000ms`. If you're seeing timeouts:

- Confirm the target DO's action handler actually returns (look for unawaited promises or an uncaught exception in logs).
- If the action is legitimately slow, pass `new WebSocketTransport(stub, { requestTimeoutMs: 60_000 })` when constructing manually, or switch that database to `transport: 'rpc'` which has no intrinsic timeout beyond the platform's request limit.

---

## Architecture

### Module Map

| Export path | Source | Purpose |
|---|---|---|
| `./db` | `src/db/` | `defineDatabase()`, `SqliteDurableObject`, Kysely plugins |
| `./vite` | `src/vite/databasePlugin.ts` | Vite plugin (`databasePlugin`) |
| `./vite/modules` | `src/vite/modules/` | Plugin internals: discovery, AST parsing, code generation, wrangler patching |
| `./context` | `src/context/` | Tenant ID context (`setTenantIdResolver`, `getTenantId`) |
| `./migrations` | `src/migrations/` | Snapshot-based migration generation via drizzle-kit |
| `./registry` | `src/registry.ts` | Action registry and RPC dispatch (`registerAction`, `getAction`, `callAction`) |
| `./schema` | `src/schema.ts` | Schema builders: `table()` (auto-snake_case wrapper around Drizzle's `sqliteTable`), `text`, `integer`, etc. |
| `./cli` | `src/cli/` | CLI commands (`push`, `generate`, `status`, `reset`, `validate`) and `db` binary |

### Request Flow

```
setTenantIdResolver(...)                         // Configure once at startup

Worker fetch()
  -> createUser({ name, email })                 // Looks like a normal function call
    -> ArkType validates args
    -> getTenantId()                             // Calls resolver → throw if unset
    -> Check DO context for direct-call short path
    -> If same DO: direct handler call (no RPC)
    -> If cross-DO: env.BINDING.idFromName(instanceKey) -> stub.rpc()
      -> DO.rpc(method, args, rpcContext)
        -> ensureMigrations()                    // Run pending migrations if any
        -> getAction(dbName, method)             // Look up handler in registry
        -> Validate args with ArkType
        -> runWithDoContext(...)                  // Set up DO-local context
          -> handler(db, validatedArgs, ctx)     // Your action code runs here
```

### Kysely Plugins

The library includes plugins for transparent data mapping between JavaScript and SQLite:

- **DrizzleDefaultsPlugin**: Auto-populates columns with Drizzle's `$defaultFn()` on INSERT (e.g. auto-generated IDs, `createdAt` timestamps) and `$onUpdateFn()` on UPDATE (e.g. `updatedAt` timestamps). Columns that are explicitly provided in the query are not overridden.
- **SchemaPlugin**: Schema-aware extension of Kysely's `CamelCasePlugin`. Maps camelCase JS property names to snake_case SQL names for both tables and columns using Drizzle schema metadata. Falls back to standard CamelCasePlugin behavior for names not in the schema.
- **DateSerializePlugin**: Converts `Date` objects to `YYYY-MM-DD HH:MM:SS` strings for SQLite storage, and parses them back into `Date` objects on read. The read path is deliberately conservative: only values in exactly the format the write path produces (also what SQLite's `CURRENT_TIMESTAMP` emits) are converted, and — when constructed with a schema — only for columns Drizzle declares as date-typed (e.g. `integer({ mode: 'timestamp' })`). User-stored strings in `text()` columns (ISO strings with a `T` separator, timezone, or milliseconds) round-trip verbatim.

All three plugins are automatically configured when using `createDrizzlePlugins(schema)`.

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
  context/          # Tenant ID resolver context
  db/               # Core database abstractions
    SqliteDurableObject.ts   # Base DO class with migrations + PITR
    defineDatabase.ts        # defineDatabase() API
    plugins.ts               # Kysely plugins (DrizzleDefaults, Schema, DateSerialize)
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
