# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`durable-db` — a zero-configuration database abstraction for Cloudflare Durable Objects with SQLite. Uses Drizzle for schema definition, Kysely for queries, and ArkType for runtime validation. A Vite plugin handles build-time code generation (Durable Object classes, RPC stubs, migration embedding, wrangler config verification with opt-in patching).

## Commands

```bash
pnpm build          # Build with tsdown → dist/
pnpm dev            # Build in watch mode
pnpm test           # Run vitest in watch mode
pnpm test:run       # Run tests once
pnpm changeset      # Create a changeset for version bumping
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

## Monorepo Structure

pnpm workspace with `examples/*` as separate packages. The root package is the library itself. Published to npm (as `durable-db`) via changesets.

## Architecture

### Module Map

| Export path | Source | Purpose |
|---|---|---|
| `./db` | `src/db/` | `defineDatabase()` API, `SqliteDurableObject` base class, Kysely plugins |
| `./vite` | `src/vite/durableDb.ts` | Vite plugin entry (`durableDb`) |
| `./vite/modules` | `src/vite/modules/` | Plugin internals: discovery, AST parsing, code generation, wrangler patching |
| `./context` | `src/context/` | Tenant ID context (`setTenantIdResolver`, `getTenantId`) |
| `./migrations` | `src/migrations/` | Snapshot-based migration generation via drizzle-kit |
| `./registry` | `src/registry.ts` | Action name → handler registry for RPC dispatch |
| `./cli` | `src/cli/` | CLI commands (push, generate, status, reset, validate) and `db` binary |

### Core Flow

1. **User defines** Drizzle schema in `src/databases/schema.ts` and database + actions in `src/databases/*.ts`
2. **Vite plugin** discovers database files, parses them with Babel AST, extracts `defineDatabase()` calls and action exports
3. **Code generation** produces a virtual module (`virtual:durable-db/__durableObjects`) containing Durable Object classes with embedded migrations and action methods
4. **Action call transformation**: internal calls → direct handler call (no RPC), cross-DB calls → RPC via `ctx.env`
5. **RPC stubs** are generated so workers can call actions like regular async functions
6. **wrangler.jsonc** is verified to contain the Durable Object bindings. In dev, missing entries are logged with the JSON to add; production builds fail hard on missing entries (wrangler.toml projects only warn since the check can't parse toml). Auto-patching is opt-in via `patchWranglerConfig: true`

### defineDatabase() Options

- `schema`: Drizzle schema tables
- `instance`: `'per-tenant'` (default) or `'global'`
- `transport`: `'rpc'` (default) or `'websocket'`
- `browsable`: `false` (default), `true`, or `'development'` for Outerbase Studio

### Vite Plugin Options

- `databasesDir`: directory containing database files (default: `'src/databases'`)
- `migrationsDir`: directory for production migrations, relative to project root (default: `'migrations'`). Each database gets a subdirectory (e.g. `migrations/main/`)
- `contextImport` / `registryImport`: override import paths for framework integrations
- `patchWranglerConfig`: write missing DO bindings/sqlite migration entries to wrangler.jsonc (default: `false` — verify only: warn in dev, fail production builds). Only wrangler.jsonc/json supported, not wrangler.toml (toml never fails the build)

### destroyDatabase

`destroyDatabase` is an optional function returned by `defineDatabase()`. It calls `ctx.storage.deleteAll()` inside the Durable Object, which atomically wipes the entire SQLite database (including Cloudflare internal metadata that counts toward billable storage). The next action call re-runs migrations and starts fresh.

```ts
export const { action, destroyDatabase } = defineDatabase({
  schema: { users, posts },
});

// In a route handler:
await destroyDatabase(); // clears current tenant's database
```

- Opt-in: only available if explicitly destructured from `defineDatabase()`
- For `per-tenant` databases: targets the current tenant (via `getTenantId()`)
- For `global` databases: targets the single shared instance
- The Vite plugin detects `destroyDatabase` in the destructuring pattern and generates an RPC stub that calls `stub.sys("destroyDatabase")` on the DO
- Generated DO classes have a `sys(command)` method (separate from `rpc()`) that handles system operations

### Action System

Actions are defined with `action({ args, handler })`. The `args` object uses ArkType syntax for runtime validation. The `handler` receives `(db: Kysely, args, ctx)`. Actions can call other actions — the Vite plugin detects these at build time via Babel AST traversal and transforms them appropriately.

### Migration System

- Schema snapshots stored in `_snapshot.json` in the migrations directory
- Dev migrations: ephemeral, stored in `node_modules/.cache/durable-db/`
- Production migrations: `.sql` files in the Vite plugin's `migrationsDir` (default: `migrations/<dbName>/`), created via `db generate`
- Dev epoch suffixing allows resetting local databases without conflicts
- Runtime failure modes (`SqliteDurableObject`): a pending migration failing with "already exists" raises `MigrationSchemaConflictError` (storage/journal drift from renamed or regenerated migration files) with recovery guidance. A PITR restore rejected as unsupported (local workerd implements `getCurrentBookmark` but not the restore call) disables PITR for the instance at debug level instead of logging an error.
- Schema loading (`loadSchema` in `src/cli/shared.ts`) is strict: declared-but-unloadable tables (inline definitions, unresolvable imports, missing exports, build failures) throw instead of silently producing "no changes". Only databases with zero declared tables are skipped.
- Dev epoch wiring: generated stubs route every instance key through `applyDevEpoch()` from the virtual module `virtual:durable-db/__devEpoch`. In dev the Vite plugin embeds the current epoch from `state.json`; in production builds the epoch is null and the function is the identity. The dev server watches the whole dev cache dir and fully re-initializes plugin state on change, so `db reset` (epoch bump → fresh DO instances) and `db push` (new squashed dev migration → re-embedded) both work live. `--purge-local-storage` optionally deletes the orphaned instances under `.wrangler/state/v3/do` (dev server must be stopped for that).

### Database Instance Strategies

- `per-tenant` (default): separate DO instance per tenant, keyed by tenant ID
- `global`: single shared DO instance

### Schema Definition

Schemas are defined using `table()` from `durable-db/schema` (not `sqliteTable` from drizzle-orm directly). The `table()` wrapper auto-converts table names to snake_case. Column names are omitted — they are derived from the JS property key and auto-snake_cased by the migration system (`casing: 'snake_case'`).

```ts
import { table, text, integer } from 'durable-db/schema';

export const userProfiles = table('userProfiles', {
  id: text().primaryKey(),
  displayName: text().notNull(),
  priceInCents: integer().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
});
// SQL: user_profiles (display_name, price_in_cents, created_at)
```

### Kysely Plugins

- **DrizzleDefaultsPlugin**: auto-populates columns with `$defaultFn()` on INSERT and `$onUpdateFn()` on UPDATE
- **SchemaPlugin** (extends CamelCasePlugin): schema-aware camelCase ↔ snake_case for both table and column names, falls back to standard CamelCasePlugin
- **DateSerializePlugin**: handles Date serialization/deserialization for SQLite. Writes Dates as `YYYY-MM-DD HH:MM:SS`; the read path only converts values in exactly that format back to `Date` (and, when constructed with a schema, only for Drizzle date-typed columns). User-stored ISO strings in `text()` columns round-trip verbatim — date-ish data should use `integer({ mode: 'timestamp' })`.

## Key Conventions

- Database definition files live in `src/databases/`. Files named `schema.ts`, `_*.ts`, and `.d.ts` are excluded from action discovery.
- Actions can be defined inline in the database file or in separate files in the same directory. Both are transformed identically: `transformDatabaseFile` handles same-file actions (plus `destroyDatabase`), `transformActionFile` handles separate files.
- Schema tables must be defined in a schema module and imported into the database file — inline table definitions can't be loaded by the migration CLI and fail loudly.
- The Vite plugin uses Babel (not regex) for all source code analysis.
- Build output is ESM-only via tsdown.
- Tests mirror source structure under `tests/`.
