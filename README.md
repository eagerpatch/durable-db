# durable-db

Zero-configuration database abstraction for Cloudflare Durable Objects with SQLite.

Define your schema with [Drizzle](https://orm.drizzle.team/), query with [Kysely](https://kysely.dev/), validate with [ArkType](https://arktype.io/)'s syntax ([`durable-db/type`](#durable-dbtype)) -- and let the Vite plugin handle the rest: Durable Object class generation, RPC stubs, migration embedding, and wrangler config verification (with opt-in auto-patching).

## Table of Contents

- [Quick Start](#quick-start)
- [Defining a Database](#defining-a-database)
- [Writing Actions](#writing-actions)
  - [`durable-db/type`](#durable-dbtype)
- [Calling Actions from Your Worker](#calling-actions-from-your-worker)
- [CLI](#cli)
  - [push](#db-push)
  - [generate](#db-generate)
  - [status](#db-status)
  - [reset](#db-reset)
  - [validate](#db-validate)
  - [Renames](#renames)
- [Migration System](#migration-system)
  - [Dev Migrations](#dev-migrations)
  - [Production Migrations](#production-migrations)
  - [Breakpoints](#breakpoints)
  - [Adding a required column](#adding-a-required-column)
  - [Epoch System](#epoch-system)
  - [Typical Workflow](#typical-workflow)
- [Vite Plugin](#vite-plugin)
- [Testing Actions](#testing-actions)
- [Outerbase Studio Integration](#outerbase-studio-integration)
- [Instance Strategies](#instance-strategies)
- [Action-to-Action Calls](#action-to-action-calls)
- [The Outbox](#the-outbox)
- [Shared Actions](#shared-actions)
- [PITR Safety](#pitr-safety)
- [Recovery Workflows](#recovery-workflows)
- [Architecture](#architecture)
- [Development](#development)

---

## Quick Start

### 1. Install

```bash
pnpm add durable-db
```

### 2. Define your schema

```ts
// src/databases/schema.ts
import { table, text, integer } from 'durable-db/schema';

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
import { defineDatabase } from 'durable-db';
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
import { durableDb } from 'durable-db/vite';

export default defineConfig({
  plugins: [
    durableDb(),
    cloudflare(),
  ],
});
```

The plugin supports Vite 5 through 8 (`vite` is a peer dependency).

### 6. Use in your worker

```ts
// src/worker.ts
import { setTenantIdResolver } from 'durable-db';
import { createUser } from './databases/actions/createUser';

// In a real app, resolve from authentication/session
setTenantIdResolver(() => 'my-tenant');

// Export the generated Durable Object classes
export * from 'virtual:durable-db/__durableObjects';

export default {
  async fetch(request: Request, env: any) {
    const user = await createUser({ name: 'Alice', email: 'alice@example.com' });
    return Response.json(user);
  },
};
```

For TypeScript support, add `durable-db/virtual` to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["durable-db/virtual"]
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
import { defineDatabase } from 'durable-db';
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
args: { name: 'string', 'age?': 'number' }  // Optional key
args: { role: "'admin' | 'user'" }           // Literal union
```

An optional key accepts `undefined`, as its inferred TypeScript type (`{ photoKey?: string }`) does: `addReview({ productId, photoKey: maybeKey })` validates whether or not there is a key, at any depth. A required key stays required, also when its type admits `undefined` (`note: 'string | undefined'` must be passed). Args compile with the `type` of `durable-db/registry` (`exactOptionalPropertyTypes: false`); the `type` exported from `durable-db` keeps ArkType's default. `args` may also be a ready `type(…)`, or any [Standard Schema](https://standardschema.dev) — a real ArkType Type, Zod, Valibot — which validates by its own rules.

### `durable-db/type`

`type` (from `durable-db`, `durable-db/db` or `durable-db/type`) is ArkType's `type()`: the same definitions, the same inferred types and editor errors — ArkType's own type-level parser, imported as types only — and the same error messages and JSON Schema, on a runtime of its own. ArkType builds its whole scope of keywords when it is imported, ~40 ms of CPU at every cold start of a worker and of every Durable Object; this one builds nothing until a definition is parsed (~2 ms to import, about ArkType's speed per validation without its JIT, which Workers refuse anyway).

```ts
import { type } from 'durable-db/type';

const Line = type({ qty: 'number.integer > 0', price: 'number' });
const Invoice = type({ customer: 'string', 'note?': 'string', lines: Line.array() });

const out = Invoice(data);          // the value, or ArkErrors
if (out instanceof type.errors) console.log(out.summary); // "lines[0].qty must be positive (was 0)"
typeof Invoice.infer;               // { customer: string; note?: string; lines: { qty: number; price: number }[] }
Invoice.toJsonSchema();             // JSON Schema (2020-12 or draft-07)
Invoice['~standard'];               // a Standard Schema, with its JSON Schema converter
```

It has ArkType's keywords (`string.email`, `string.uuid`, `number.integer`, `string.numeric.parse`, `string.date.iso.parse`, …), bounds (`'string > 0'`, `'0 < number <= 10'`, `'number % 2'`), unions, intersections, literals, regexes, arrays, tuples (`['string', 'number?']`, `['string', '...', 'number[]']`), `Record<K, V>`, object keys (`'key?'`, `'[string]'`, `'+'`, `'...'`), defaults (`'number = 0'`), tuple expressions (`'[]'`, `'|'`, `'&'`, `'=>'`, `':'`, `'|>'`, `'@'`, `'==='`, `'instanceof'`, `'keyof'`) and a Type's methods (`array`, `or`, `and`, `merge`, `pick`, `omit`, `partial`, `required`, `keyof`, `get`, `optional`, `default`, `narrow`, `pipe`, `to`, `describe`, `configure`, `brand`, `onUndeclaredKey`, `props`, `assert`, `allows`, `from`, `toJsonSchema`). ArkType's scopes, generics, `match` and `fn` are not there: a definition it does not know fails with a `ParseError` naming it, never a validator that checks something else. `tests/type/conformance.test.ts` runs every supported definition through both against the same values. A Type of `durable-db/type` nests in ArkType's own definitions and the other way round.

### The `handler` function

Receives three arguments:

| Argument | Type | Description |
|----------|------|-------------|
| `db` | `Kysely<Schema>` | Type-safe Kysely query builder bound to your Drizzle schema |
| `args` | inferred from `args` | Validated arguments |
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
import { setTenantIdResolver } from 'durable-db';
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
import { setTenantIdResolver } from 'durable-db';
import { getRequestInfo } from 'rwsdk/worker';

setTenantIdResolver(() => getRequestInfo().ctx.session!.shop);
```

The resolver is called at the moment a database operation needs the tenant ID — by which point request middleware (auth, session, etc.) has already completed.

### How it works

Behind the scenes, each action call is an RPC call to the correct Durable Object instance. The Vite plugin generates stubs that handle instance routing, argument validation, and DO communication transparently.

Calls to the **same** Durable Object instance that start before the code waits on I/O share one round trip: `Promise.all([countProducts({}), listProducts({ featuredOnly: true })])` (or sibling server components fetching at once, or two RPC procedures whose middleware awaits a different number of times before their action calls) sends both in a single RPC, and the object runs them one after another, in the order they were made — each result or error goes back to its own caller. A lone call, or calls made one after another, are plain RPCs as before. Each action's args schema is compiled on its first call and reused.

---

## CLI

The `db` CLI manages your migration lifecycle. All commands share these options:

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --databases-dir <dir>` | `src/databases` | Directory containing database definitions |
| `--database <db>` | (all) | Only this database. An unknown name exits with code 1 and lists the valid ones |
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
db push --database main
db push --rename users.bio=about       # answer a rename question (see Renames)
```

**Extra flags:**

| Flag | Description |
|------|-------------|
| `--rename <table.old=new>` | Answer a rename question without a prompt: `<table>.<old>=<new>` renames a column, `<old>=<new>` a table. Repeatable. See [Renames](#renames) |
| `--no-renames` | Answer every remaining rename question with "create" (the old column/table is dropped) |

**What it does:**

1. Discovers all database files in your databases directory
2. Parses each file for `defineDatabase()` calls
3. For each database:
   - Loads the current production snapshot (`_snapshot.json` in the migrations directory)
   - Generates a fresh snapshot from your current Drizzle schema
   - Diffs the two snapshots to produce SQL migration statements
   - If there are changes: replaces any previous dev migration with a **single squashed migration** named after a hash of its content (e.g. `dev_a1b2c3d4.sql`). `CREATE TABLE`/`CREATE INDEX` statements get `IF NOT EXISTS` added so the squashed migration can overlay tables a previous dev migration already created
   - If the same content hash already exists, nothing is rewritten — the DO recognizes the migration name and skips it

Every push diffs from the production snapshot, so a second push (add a column, restart, add another) repeats the first one's statements. The dev Durable Object journals what each dev migration ran and skips the statements of an earlier dev migration that the new one contains whole; one that redoes an earlier change in another form (the same column with another type) fails with `MigrationSchemaConflictError` and the `db reset --database <name>` to run.

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

Dev migrations are stored in `node_modules/.cache/durable-db/` and are never committed to git. They are loaded automatically by the Vite plugin in dev mode.

`push` warns (`⚠`) about what a change risks on a database that has rows — a `NOT NULL` column without a default fails on every table with rows, your dev database's included (see [Adding a required column](#adding-a-required-column)), and a dropped column or table loses its data.

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
| `--rename <table.old=new>` | Answer a rename question without a prompt (repeatable). See [Renames](#renames) |
| `--no-renames` | Answer every remaining rename question with "create" (the old column/table is dropped) |
| `--force` | Write the migration even when a statement fails on every table that has rows |

**What it does:**

1. Compares your current Drizzle schema against the production snapshot (`_snapshot.json`)
2. Generates SQL statements for the diff (asking about renames — see [Renames](#renames))
3. Checks what they do to a database that has rows (below) — before any file is written
4. Writes a timestamped `.sql` file to the configured `migrationsDir`
5. Updates the production snapshot with a new ID and `prevId` chain
6. Clears dev state for this database (the dev migrations are now superseded by the production migration)

**Unsafe statements.** Per-tenant databases migrate lazily, on each tenant's first request after a deploy — so a statement that only fails on a table with rows surfaces in production, once per tenant with data, and that tenant's database stays broken until a fixed migration ships. `db validate` cannot catch it: it replays the migrations on an empty database. So `generate`:

- **refuses** (exit code 1, nothing written) a column added `NOT NULL` without a default: `products.currency is added NOT NULL without a default — the migration fails on every table that has rows: add .default(...) or add it nullable and backfill`. `--force` writes it anyway (a table known to be empty everywhere). See [Adding a required column](#adding-a-required-column);
- **warns** (`⚠`) when a column or table is dropped (its data is lost) or a column becomes `NOT NULL` (fails where a row holds `NULL`).

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
db status --database main
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

Shows per-database: production migration count, dev migration count, whether there are uncommitted schema changes (pending SQL statements that haven't been pushed yet), and the last push timestamp. If a teammate committed new production migrations since your last push, a `⚠️ Production snapshot changed - run 'db:reset' to sync` warning appears. A database with its own epoch (after `db reset --database`) shows it.

`status` never prompts. A change drizzle-kit can only diff by asking whether a name is a rename is reported as such, never as up to date:

```
📦 main
   📝 Changes pending — needs rename resolution:
     - users: about added, bio removed
   Answer when you push/generate: in a terminal (it asks), or with --rename users.bio=about (a rename) or --no-renames (create + drop)
```

Pending SQL that would fail on a table with rows, or drop data, is listed with a `⚠️` line.

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
| `--database <db>` | Only reset this database: it alone starts fresh, every other keeps its data |
| `--purge-local-storage` | Also delete workerd's persisted DO storage under `.wrangler/`. Refused while the dev server runs |
| `--force` | With `--purge-local-storage`: purge even when a dev server appears to be running |

**Three modes:**

| Mode | What happens |
|------|-------------|
| **Full reset** (default) | Bumps the project epoch. All databases rotate to brand-new DO instances on the next request — fresh, empty SQLite with migrations re-applied. Clears all dev migrations and snapshots. Works while the dev server is running. |
| **One database** (`--database <db>`) | Gives that database its own new epoch: only its instances rotate (every tenant's), the other databases — a tenant directory, say — keep their data. Clears its dev migrations and snapshot. |
| **Keep epoch** (`--keep-epoch`) | Only clears dev migrations and snapshots. Existing DO instances keep running with their current data. |

**How fresh instances work**: in dev, every DO instance key is suffixed with its database's epoch (`<key>__dev_<epoch>`) by the generated stubs. Bumping an epoch makes `idFromName()` resolve to entirely new DO instances, so the old tables can never collide with the new schema. The Vite dev server watches the dev-state file and reloads automatically when an epoch changes — no restart needed.

**Disk space**: the previous instances' SQLite files stay orphaned under `.wrangler/state/v3/do` until you purge them. Run `db reset --purge-local-storage` with the dev server **stopped** — workerd keeps deleted storage open and every database request fails with `internal error; reference = …` until it restarts, so the command refuses while the dev server runs (the Vite plugin records the running server in `node_modules/.cache/durable-db/dev-server.json`; a server that was killed leaves a stale record, which is ignored once its process is gone). Or simply `rm -rf .wrangler` whenever you want the disk back. With `--database <db>`, only the storage directories matching that database's DO class are purged.

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
6. Warns (`⚠ not yet generated: …`) about what the schema change `db generate` has not written yet would do to a database that has rows — the checks `generate` applies (a `NOT NULL` column without a default, dropped columns and tables, names that may be renames)

The replay runs on an **empty** database, so it proves a migration is valid SQL, not that it succeeds on a table with rows. Committed migrations are not re-checked for that: validate cannot know which of them already ran where.

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

### Renames

drizzle-kit cannot tell a renamed column (or table) from a dropped one plus a new one. When a table has both a new and a vanished column — or the schema both a new and a vanished table — its diff asks:

```
Is about column in users table created or renamed from another column?
❯ + about            create column
  ~ bio › about      rename column
```

`push` and `generate` show that prompt in a terminal. Without one (CI, a piped shell, a host CLI that runs `push` in the background) they answer from the command line instead, or fail with a message naming the command and both answers:

```bash
db generate rename_bio --rename users.bio=about   # a rename: the data is kept
db generate --rename items=products                # a table rename
db generate --no-renames                           # create + drop: bio's data is lost
```

Names are the SQL names (snake_case, as in the migration files); a camelCase property name works too. An answer applies to the database(s) where it matches; one that matches no pending change is an error. The rename is written as drizzle-kit writes it (`` ALTER TABLE `users` RENAME COLUMN "bio" TO "about"; ``), so `push` and `generate` produce the same statement. Programmatically: `push({ renames, noRenames, interactive })`, `generate(ctx, { renames, noRenames, interactive, force })` — `interactive: false` never prompts (a host CLI starting a dev server wants that), and an unanswered question throws `SchemaRenameRequiredError` (its `describe(command)` is the message with your command's name).

### Embedding in your own CLI

The commands are composable Commander commands, so a host CLI can re-use them:

```ts
import { Command } from 'commander';
import { createDbCommand, registerDbCommands } from 'durable-db/cli';

// As a nested `db` group: `mycli db push`
program.addCommand(createDbCommand());

// Or flat on your own command: `mycli push`
// (this is exactly what the standalone `db` binary does)
registerDbCommands(program);
```

Messages that suggest a command (a rename answer, for one) name it as the user typed it: `mycli db generate --rename …`.

### Programmatic API

All CLI functions are also available for integration into other tools:

```ts
import * as db from 'durable-db/cli';

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
- **Location**: `node_modules/.cache/durable-db/databases/<dbName>/migrations/`
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

Concurrent first calls to a Durable Object share one migration run: requests that arrive while it migrates wait for it instead of applying the same statements again.

### Adding a required column

SQLite rejects `ALTER TABLE … ADD … NOT NULL` without a default on a table that has rows (`Cannot add a NOT NULL column with default value NULL`), and every tenant's database migrates on its own, after the deploy. So `db generate` refuses such a column (see [Unsafe statements](#db-generate)). Either:

- give it a default: `currency: text().notNull().default('SEK')` — the existing rows get it; or
- add it nullable (`currency: text()`), deploy, backfill every tenant (a job over your tenants, say), then make it `.notNull()` in a later migration.

The same holds for renames: answering a rename question with "create" (or `--no-renames`) adds the new column — `NOT NULL` without a default fails the same way — and drops the old one with its data.

### Epoch System

In development, each database instance key gets an epoch suffix to enable clean resets:

| Environment | Instance key |
|-------------|-------------|
| Production | `example-tenant` |
| Development | `example-tenant__dev_m1a2b3c` |

When you run `db reset` (without `--keep-epoch`), a new project epoch is generated. This causes all subsequent DO accesses to create fresh instances, effectively giving you a clean database without data from previous iterations. `db reset --database <db>` gives that database an epoch of its own instead, so only its instances rotate; the next full reset moves every database back to the (new) project epoch.

Epochs are base36-encoded timestamps stored in `node_modules/.cache/durable-db/state.json` — the project's as `epoch`, a database's own as `databases.<name>.epoch`.

**How the epoch reaches the worker**: the Vite plugin serves a virtual module (`virtual:durable-db/__devEpoch`) exporting `applyDevEpoch(key, dbName)`, and every generated stub routes its instance key through it with its database's name. In dev the plugin embeds the epochs from `state.json`; in production builds the epoch is `null` and `applyDevEpoch` is the identity function, so production keys are never suffixed. The dev server watches durable-db's dev cache directory and reloads on change, so both `db reset` (new epoch → fresh instances) and `db push` (new dev migration → re-embedded into the DO module) take effect on the next request without restarting.

### Dev State Structure

```
node_modules/.cache/durable-db/
  state.json                          # Global state (epoch, per-db epochs and push info)
  dev-server.json                     # The running dev server (pid), while one runs
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
      "lastPush": "2024-03-15T10:30:00.000Z"
    },
    "analytics": {
      "epoch": "m1a9x2k"
    }
  }
}
```

A database's `epoch` is set by `db reset --database <name>`; without it the project `epoch` applies.

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

`db generate` writes the statements your dev database already applied through `db push` as a production migration. A dev database that applied them records that migration as applied instead of running it again (which would fail with `duplicate column name` / `already exists`), so the dev data survives the hand-off — no reset needed.

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
import { durableDb } from 'durable-db/vite';

durableDb({
  databasesDir: 'src/databases',   // Where database files live
  migrationsDir: 'migrations',     // Where production migrations live
});
```

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databasesDir` | `string` | `'src/databases'` | Directory containing database definition files |
| `migrationsDir` | `string` | `'migrations'` | Directory for production migrations, relative to project root. Each database gets a subdirectory (e.g. `migrations/main/`) |
| `contextImport` | `string` | `'durable-db/context'` | Import path for the context module (for framework integrations) |
| `registryImport` | `string` | `'durable-db/registry'` | Import path for the action registry module (for framework integrations) |
| `patchWranglerConfig` | `boolean` | `false` | Reconcile `wrangler.jsonc` with the discovered databases automatically, in the plugin's `config` hook: add bindings and `new_sqlite_classes` migrations, remove durable-db's own stale bindings, write `renamed_classes` for a mount change. Off by default — the plugin only verifies the config and logs the exact JSON to add. Only `wrangler.jsonc`/`wrangler.json` are supported (not `wrangler.toml`) |

### What the plugin does

1. **Discovery**: Finds all `defineDatabase()` files in your databases directory (excludes `schema.ts`, `_*.ts`, `.d.ts`)
2. **AST Parsing**: Uses Babel to extract database config and action definitions (no regexes). Only modules that can define a database or actions (they mention `defineDatabase`, or import an `action` factory) are parsed — a syntax error in any other module is reported by the compiler that owns it, not by durable-db
3. **Migration Loading**: Loads production migrations from disk; in dev mode also loads dev migrations from cache
4. **Code Generation**: Produces a virtual module (`virtual:durable-db/__durableObjects`) containing Durable Object classes with embedded migrations and RPC dispatch methods, plus a `virtual:durable-db/__devEpoch` module that suffixes DO instance keys with the dev epoch (identity in production builds)
5. **Action Transform**: Replaces `action()` call-sites with RPC stubs + `registerAction()` calls so actions can be called like regular functions from your worker. This applies to actions in separate files *and* actions defined in the database file itself
6. **Wrangler Verification**: Checks that `wrangler.jsonc` contains the required Durable Object bindings and SQLite migration entries and no binding or class of a database that is gone, and logs the exact JSON to add (or remove) when something is off. With `patchWranglerConfig: true`, reconciles it for you instead
7. **HMR**: Watches database files and invalidates the virtual module on change

### Wrangler config: verify vs. patch

The plugin needs each database's Durable Object binding and a `new_sqlite_classes` migration entry in your wrangler config.

**Default (verify-only)**: your config is never modified. On startup the plugin checks for missing entries and logs the exact JSON to add, e.g.:

```
[durable-db] wrangler.jsonc is missing Durable Object config for your database(s). Add this:
{
  "durable_objects": { "bindings": [{ "name": "MAIN_DATABASE_DO", "class_name": "MainDatabaseDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MainDatabaseDO"] }]
}
Or let the plugin write it for you: durableDb({ patchWranglerConfig: true })
```

A production build fails when the config does not match, with an error naming what is missing and what is stale. A removed database's class left in the migrations is not a failure (see the tombstones below).

**Opt-in (auto-patch)**: pass `durableDb({ patchWranglerConfig: true })` and the plugin reconciles the config with the discovered databases, editing the file in place: comments, formatting and line endings stay as you wrote them, only the entries it adds or removes change.

- A new database gets its binding and a `new_sqlite_classes` migration.
- durable-db's own bindings (`<X>_DATABASE_DO` → `<X>DatabaseDO`) whose class is no longer a discovered database are removed. Other bindings, and bindings with a `script_name`, are never touched.
- A database of a mounted source (a `databasesDir` entry with a `prefix`) whose class name changed — its mount changed, or it moved into a mounted source, its file name unchanged — gets a `renamed_classes` migration, so Cloudflare moves its deployed data to the new class on deploy. That data carries its `__migrations` journal, so the old migrations directory moves with it (`migrations/reviews-feedback/` → `migrations/feedback-feedback/`). If the new directory already has migrations (say `db generate` ran under the new mount first), or several directories belong to the old class, nothing is written for that database and the plugin stops with the two ways out: `rm -r` the new directory and `mv` the old one to keep the data, or add the `deleted_classes` migration to drop it. A database moved out of a mount, or two databases of the app (`product-catalog.ts` replacing `catalog.ts`), are never paired. Local dev storage is kept per class name, so in dev a renamed database starts empty.
- A removed database's class is never deleted for you (that deletes its data): a note gives the exact `deleted_classes` migration to add, or says to drop the class from its `new_sqlite_classes` entry if it was never deployed.

**Removing a database** (or an extension that brought one): as long as the migrations declare its class live — created, or the target of a `renamed_classes`, and not deleted or renamed away since — the generated module keeps exporting a **tombstone** of that class (`RemovedDatabaseDurableObject` from `durable-db/db`). The worker still has to export every class its migrations declare: `@cloudflare/vite-plugin` wraps each one (the dev server fails with `Class extends value undefined` without it), and Cloudflare refuses a deploy that drops a class with data. The tombstone never touches its storage; `fetch` answers `410 Gone` and the stubs' calls reject with a `RemovedDatabaseError` naming the `deleted_classes` migration that deletes it. So dev starts, deploys pass and no data is lost: re-adding the database brings its data back. To delete the class and all its data for good, add that `deleted_classes` migration yourself — the tombstone goes with it. This applies with or without `patchWranglerConfig`; without it, remove the database's binding by hand (a production build fails on a stale binding).

It does this in its `config` hook, before `@cloudflare/vite-plugin` reads the file (durable-db is `enforce: 'pre'`): the Cloudflare plugin builds `dist/<worker>/wrangler.json` from the config it read and restarts a dev server when the file changes later, so a later patch would ship a build without the new binding and restart the first dev start. A change is logged:

```
durable-db updated wrangler.jsonc (Durable Objects: +AUDIT_DATABASE_DO → AuditDatabaseDO; migration v2: AuditDatabaseDO)
```

A CLI that wants the file settled before it starts Vite (to deploy it, say) can run the same step itself:

```ts
import { syncWranglerConfig } from 'durable-db/vite';

const { modified, changes, conflicts } = syncWranglerConfig({
  projectRoot: process.cwd(),
  databasesDir: 'src/databases', // the plugin's defaults
  migrationsDir: 'migrations',
});
```

It returns what changed (`addedBindings`, `removedBindings`, `newClasses`, `renamedClasses`, `movedMigrations`), the classes left for a hand-written `deleted_classes` (`deletedClasses`) and the renames it refused (`conflicts` — the plugin stops on them).

While a database file does not parse, nothing is written (a partial set of databases would read as databases removed).

> ⚠️ Only `wrangler.jsonc` / `wrangler.json` are supported. If your project uses `wrangler.toml`, the plugin can't verify or patch it — it will print the required config and you add the TOML equivalent yourself.

### Generated Class Naming

For each `defineDatabase()` call, the plugin generates a class based on the filename:

| Filename | Class Name | Binding Name |
|----------|-----------|-------------|
| `main.ts` | `MainDatabaseDO` | `MAIN_DATABASE_DO` |
| `analytics.ts` | `AnalyticsDatabaseDO` | `ANALYTICS_DATABASE_DO` |
| `user-data.ts` | `UserDataDatabaseDO` | `USER_DATA_DATABASE_DO` |

Export the generated classes from your worker entry point:

```ts
export * from 'virtual:durable-db/__durableObjects';
```

### Action Transformation

The plugin transforms each `action()` definition into two things:

1. **A registry registration** (handler + ArkType validator) -- runs inside the DO
2. **An RPC stub function** (exported under the same name) -- runs in your worker

The stub function:
- Validates args with ArkType
- Checks if we're already inside the same DO (via AsyncLocalStorage) for a fast direct-call path
- Computes the instance key (`getTenantId()` or `"global"`) and routes it through `applyDevEpoch(key, dbName)` (its database's dev-epoch suffix in dev, identity in production — see [Epoch System](#epoch-system))
- Otherwise, resolves the DO instance via `env.BINDING.idFromName(instanceKey)` and calls `stub.rpc()`

---

## Testing Actions

`durable-db/testing` runs actions against a real in-memory SQLite (Node's `node:sqlite`) in plain vitest — no worker pool, no Vite plugin:

```ts
import { createTestDatabase } from 'durable-db/testing';
import { users } from '../src/databases/schema';
import { createUser } from '../src/databases/actions/createUser';
import { signUp } from '../src/routes/signUp';

const t = await createTestDatabase({ schema: { users }, tenantId: 'acme' });

await t.run(createUser, { name: 'Ann', email: 'ann@example.com' }); // validates args like production
await createUser({ name: 'Bo', email: 'bo@example.com' });          // a direct call runs here too
await signUp(request);                                               // so does code that calls actions

t.destroy();
```

While a test database is live, an action called directly — from a page, a procedure, a job under test — runs against the newest live test database created with every table of the action's database.

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
import { studio } from 'durable-db/db';

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

## The Outbox

An action runs inside its Durable Object, in the middle of its writes: it should not send an email, call a webhook or enqueue a job itself — that would happen even if the action then failed, and its code would have to be in the object. It records a message instead, and something outside acts on it after the action has succeeded:

```ts
export const signUp = action({
  args: { email: 'string.email' },
  handler: async (db, { email }, ctx) => {
    const user = await db.insertInto('users').values({ id: crypto.randomUUID(), email }).returningAll().executeTakeFirstOrThrow();
    ctx.outbox.push({ type: 'welcome-email', userId: user.id });
    return user;
  },
});
```

Where the messages go is configured once, in the plugin:

```ts
durableDb({ outbox: { queue: 'EVENTS' } })            // each message to the Queue binding EVENTS, as it is
durableDb({ outbox: { module: './src/outbox.ts' } })  // a module whose default export delivers them
```

```ts
// src/outbox.ts — a function, or an object with `deliver`
import type { OutboxEnvelope } from 'durable-db/db';

export default async function deliver(envelopes: OutboxEnvelope[], { env }: { env: Env }) {
  for (const { message, tenantId } of envelopes) await env.WEBHOOKS.send({ ...message, tenant: tenantId });
}
```

- **With the action's writes.** The messages are written to the object's `__outbox` table when the handler resolves, in the same synchronous block as its last writes — the Durable Object commits them together — and the alarm that delivers them is set with them. A handler that throws records none. An action called from another action of the same database shares its outbox.
- **At least once.** The alarm hands the oldest messages (up to 100 per delivery) to the sink and deletes what was delivered; a delivery that throws stays in the table, with its error, and is retried with backoff (5 s, doubling, at most 5 minutes). A message may arrive twice — make what consumes it idempotent.
- **Envelopes.** The sink gets `{ message, instanceKey, tenantId, recordedAt }`: `tenantId` is a per-tenant instance's tenant (null for a global database).
- **JSON.** A message is a JSON value, checked when it is pushed.
- **Typed.** `push()` takes any JSON value until you declare the message: `declare global { interface DurableDbOutbox { message: { type: 'welcome-email'; userId: string } } }`.
- **Without a sink** `ctx.outbox.push()` throws, naming the option. The generated classes use the alarm for the outbox; a hand-written subclass with an alarm of its own calls `super.alarm()`.
- **Tests.** `createTestDatabase()` keeps what successful actions pushed in `t.outbox`, and its `outbox` option delivers them as the sink would.

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

## Shared Actions

For a library that works on any schema — a query executor, an exporter — an action can be registered once and run in **every** database. It is opt-in: nothing changes for an app that never calls it.

```ts
import { registerSharedAction } from 'durable-db/registry';

registerSharedAction('export:rows', {
  validator: (args) => args as { table: string },
  handler: async (db, args, ctx) => db.selectFrom(args.table).selectAll().execute(),
});
```

`stub.rpc('export:rows', { table: 'users' })` then runs it in whichever Durable Object is called, with that database's `db` and the action context. The module that registers it has to be loaded in the Durable Object's isolate (anything the worker's entry imports is). A database's own action of the same name wins, so give a shared action a name no export can have (`"lib:name"`).

`virtual:durable-db/__databases` lists what the plugin discovered — `databases: [{ name, bindingName, className, instance, schema }]`, the tables being the schema module's own objects — for a library that needs to know which database a table belongs to. It is generated only when something imports it.

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

In development, migrations run against ephemeral state cached under `node_modules/.cache/durable-db/`. Use whichever matches your situation:

- **Reset one tenant's data while keeping schema**: call `destroyDatabase()` from a route. This runs `ctx.storage.deleteAll()` on the current tenant's DO and re-runs migrations on the next call.
- **Reset _every_ tenant's data for one database**: run `pnpm db reset --database main` — the dev server can keep running. That database's instance keys get a new `__dev_<epoch>` suffix, so every tenant rotates to a brand-new DO with empty SQLite on the next request; the other databases keep their data.
- **Reset every database**: `pnpm db reset`. Add `--purge-local-storage` (dev server stopped — the command refuses otherwise) when you also want the orphaned instances' files deleted from `.wrangler/`.
- **Drop everything and re-derive migrations from the schema**: `rm -rf node_modules/.cache/durable-db` and restart `pnpm dev`. The plugin regenerates dev migrations from the current schema.

### "already exists" / "duplicate column name" in dev

A pending migration fails with `MigrationSchemaConflictError` when the storage already holds what it creates and the `__migrations` journal doesn't know it: migration files renamed or regenerated after the storage was created, or storage written by an older version. (The usual dev loop — `db push`, then `db generate` — is handled: see [Typical Workflow](#typical-workflow).) The error names the database; `db reset --database <name>` gives it fresh instances.

### A column reads back as its own name

Queries quote identifiers with backticks. SQLite reads a double-quoted identifier that names no column as a string literal — a column missing from the database (a schema change not yet migrated) would select its own name and filter on a constant — while a backticked one fails with `no such column`.

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
| `./vite` | `src/vite/durableDb.ts` | Vite plugin (`durableDb`) |
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
    snapshot.ts     # Drizzle schema -> snapshot diffing (rename answers applied first)
    renames.ts      # Rename questions: detection, --rename answers, create + drop
    risks.ts        # What a change does to a table with rows (NOT NULL adds, drops)
    generator.ts    # Migration file reading/writing
  registry.ts       # Action registration and RPC dispatch
  vite/
    durableDb.ts             # Vite plugin entry
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
