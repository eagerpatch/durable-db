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
6. **wrangler.jsonc** is verified to contain the Durable Object bindings and no stale ones. In dev, missing or stale entries are logged with the JSON to add or remove; production builds fail hard on them (wrangler.toml projects only warn since the check can't parse toml). Reconciliation is opt-in via `patchWranglerConfig: true` and runs in the plugin's `config` hook (`syncWranglerConfig` in `src/vite/modules/syncWrangler.ts`, also exported from `durable-db/vite`), before `@cloudflare/vite-plugin`'s `config` hook reads the file — that plugin emits the build's `wrangler.json` from its copy and restarts a dev server on a later change, so patching lazily (load/transform) shipped stale bindings and restarted the first dev start. `syncWranglerConfig` discovers the databases (with their `migrationsDir`, which a rename moves) and writes nothing while a database file does not parse (a partial set reads as databases removed); `reconcileWranglerConfig` patches and logs one summary line built from the `PatchResult` (`durable-db updated wrangler.jsonc (…)`); an app without databases is left alone unless its config still binds durable-db classes. A refused rename (`conflicts`) throws (`stopOnRenameConflicts`), in the hook already. `initialize()` reconciles again only when the set of databases differs from the one last reconciled (`wranglerReconciledFor`): a database added or remounted while the dev server runs, or the plugin driven without the hook. `patchWranglerConfig()` (`src/vite/modules/wrangler.ts`, in-place JSONC edits, comments and layout kept) adds bindings and `new_sqlite_classes`, removes durable-db's own bindings of databases that are gone, writes `renamed_classes` for a mounted database whose class changed (exact file stem, unique pairing, never for unprefixed databases) and moves its migrations directory with it, refuses when the migrations cannot follow, and never writes `deleted_classes` (a note gives the entry; not a build failure). Tombstones: every class of durable-db's naming the migrations still declare live (`declaredClasses`: created or a `renamed_classes` target, not deleted or renamed away) but no discovered database defines is exported by the generated module as `class <X>DatabaseDO extends RemovedDatabaseDurableObject` (`tombstoneClasses()` in `wrangler.ts`, read at load, after the `config` hook; `src/db/RemovedDatabaseDurableObject.ts`): storage untouched, `fetch` → 410, `rpc`/`sys` reject with `RemovedDatabaseError` naming the `deleted_classes` entry. @cloudflare/vite-plugin wraps every class the config names (workerd: `Class extends value undefined` otherwise) and a deploy that drops a class with data fails, so a removed database (or extension) must not take its class with it

### defineDatabase() Options

- `schema`: Drizzle schema tables
- `instance`: `'per-tenant'` (default) or `'global'`
- `transport`: `'rpc'` (default) or `'websocket'`
- `browsable`: `false` (default), `true`, or `'development'` for Outerbase Studio

### Vite Plugin Options

- `databasesDir`: directory containing database files (default: `'src/databases'`)
- `migrationsDir`: directory for production migrations, relative to project root (default: `'migrations'`). Each database gets a subdirectory (e.g. `migrations/main/`)
- `contextImport` / `registryImport`: override import paths for framework integrations
- `patchWranglerConfig`: reconcile wrangler.jsonc with the discovered databases, in the `config` hook (default: `false` — verify only: warn in dev, fail production builds). Only wrangler.jsonc/json supported, not wrangler.toml (toml never fails the build)

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

Actions are defined with `action({ args, handler })`. The `args` object uses ArkType syntax for runtime validation, compiled with `actionArgsType` (`src/db/actionArgs.ts`, exported as `durable-db/registry`'s `type`): a jitless scope with `exactOptionalPropertyTypes: false`, so an optional key accepts `undefined` as its inferred type does. The `handler` receives `(db: Kysely, args, ctx)`. Actions can call other actions — the Vite plugin detects these at build time via Babel AST traversal and transforms them appropriately.

### Migration System

- Schema snapshots stored in `_snapshot.json` in the migrations directory
- Dev migrations: ephemeral, stored in `node_modules/.cache/durable-db/`
- Production migrations: `.sql` files in the Vite plugin's `migrationsDir` (default: `migrations/<dbName>/`), created via `db generate`
- Dev epoch suffixing allows resetting local databases without conflicts
- Dev statement journal (`__dev_migration_statements`, dev storage only): a pending dev migration skips the statements of an earlier dev migration it contains whole (`db push` re-squashes from the production snapshot), and a pending production migration whose statements dev migrations already ran is recorded, not executed (`db push` then `db generate`).
- Runtime failure modes (`SqliteDurableObject`): a pending migration failing with "already exists" or "duplicate column name" raises `MigrationSchemaConflictError` (storage/journal drift from renamed or regenerated migration files) with recovery guidance naming `db reset --database <databaseName>` (the generated DO sets `databaseName`). A PITR restore rejected as unsupported (local workerd implements `getCurrentBookmark` but not the restore call) disables PITR for the instance at debug level instead of logging an error. Concurrent first calls share one migration run (`ensureMigrations` keeps the in-flight promise).
- Queries quote identifiers with backticks (`BacktickSqliteQueryCompiler`): SQLite reads a double-quoted identifier that names no column as a string literal, so a column missing from the database would read back as its own name.
- Testing (`durable-db/testing`): `createTestDatabase()` also publishes a live test database, so code under test that calls an action directly runs it there.
- Schema loading (`loadSchema` in `src/cli/shared.ts`) is strict: declared-but-unloadable tables (inline definitions, unresolvable imports, missing exports, build failures) throw instead of silently producing "no changes". Only databases with zero declared tables are skipped.
- Dev epoch wiring: generated stubs route every instance key through `applyDevEpoch(key, dbName)` from the virtual module `virtual:durable-db/__devEpoch`. Epochs are per database: `state.json` has the project `epoch` and `databases[name].epoch` (set by `db reset --database <name>`, which bumps only that one; a full reset sets a new project epoch and drops the per-database ones; `generate` keeps them — `forgetDatabaseDevState`). In dev the Vite plugin embeds both (`devEpoch`, `devEpochs`); in production builds the epoch is null and the function is the identity. The key format stays `<key>__dev_<epoch>` (`getTenantId()` inside a DO strips it, `global__dev_*` has no tenant). The dev server watches the whole dev cache dir and fully re-initializes plugin state on change, so `db reset` (epoch bump → fresh DO instances) and `db push` (new squashed dev migration → re-embedded) both work live. `--purge-local-storage` optionally deletes the orphaned instances under `.wrangler/state/v3/do`; it refuses while the dev server runs (`--force` overrides): `configureServer` writes `dev-server.json` (pid + token) into the dev cache dir and removes its own on close; a lock whose pid is dead is ignored. The cache watcher ignores the lock and the late-reported creation of the cache dir itself.
- `--database <name>` on every command (push, generate, status, reset, validate) goes through `selectDatabases()` (`src/cli/shared.ts`): an unknown name throws `UnknownDatabaseError` listing the valid names (exit 1) — never "No databases found." / a reset of a name that isn't there.
- Renames: drizzle-kit's diff asks "created or renamed?" (TTY prompts) whenever a table has both a new and a vanished column (or the schema a new and a vanished table); its API takes no answers. `generateMigrationStatements(from, to, { renames, noRenames, interactive })` (`src/migrations/snapshot.ts` + `renames.ts`) resolves before drizzle-kit sees it: `--rename t.old=new` / `old=new` answers are applied to the previous snapshot (references follow) and emitted as drizzle-kit's own `ALTER TABLE … RENAME` statements; `--no-renames` splits the diff into drops then additions (`withoutRemoved`), neither of which asks; otherwise, without a TTY (or `interactive: false`), `SchemaRenameRequiredError` names the questions and both answers (`describe(command)` — the CLI passes the command path as typed, e.g. `lagerverk db generate`). `status` never prompts and reports "needs rename resolution". push/generate diff every database first (`diffDatabases`) so a refusal writes nothing; an answer that matches no pending change is an error.
- Risks (`src/migrations/risks.ts`, `analyzeMigrationRisks` over the snapshots, renames read back from the statements so interactive answers count): a column added NOT NULL without a default fails on every table with rows — `generate` refuses it (`UnsafeMigrationError`, `--force` writes it); dropped columns/tables and columns made NOT NULL are warnings. `push` and `status` show them, `validate` reports them for the pending (not yet generated) change only — its replay runs on an empty database and can't know which committed migrations ran where.

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
- **DateSerializePlugin**: handles Date serialization/deserialization for SQLite. Writes Dates as `YYYY-MM-DD HH:MM:SS`; the read path only converts values in exactly that format back to `Date` (and, when constructed with a schema, only for Drizzle date-typed columns). User-stored ISO strings in `text()` columns round-trip verbatim — date-ish data should use `integer({ mode: 'timestamp' })`. Binary values (`ArrayBuffer`/views) pass through untouched: a blob parameter is bound as a blob (a Durable Object answers one as an `ArrayBuffer`).
- **BooleanDeserializePlugin**: boolean-mode columns come back as booleans (by column name across the schema).
- **JSON plugins** (`createJsonPlugins`, added by `createDrizzlePlugins` only when the schema has a JSON-mode column; `write` before SchemaPlugin, `read` last): a value written to a `text({ mode: 'json' })`/`blob({ mode: 'json' })` column through `values()`/`set()` is stored as `JSON.stringify(value)` (strings too; `null`/`undefined` untouched; a blob column stores the UTF-8 bytes), and those columns are parsed in result rows — resolved per selection (table and alias aware: `select`, `selectAll`, `returning`, joins), by name across the schema for a raw `sql` query; unparseable text is answered as it is. Not covered (the caller's own encoding): INSERT … SELECT, expression values (`excluded.x`, `sql` fragments), `where` comparisons, MERGE. Through a relation a text JSON column is parsed in `related.ts`'s `revive()`; blob columns are refused there.
- **Relations** (`src/db/relations.ts`, `src/db/related.ts`): a foreign key declared on a column is a relation; `defineDatabase()` returns `related` (= `createRelated(schema)`, also exported for a library that holds a schema: typed for known tables, `AnyRelated` — strings, checked at runtime — for an `AnySchema`) and `relations`. A `RelatedExpression` is built from a `RelatedSpec` (`alias` = the key it is answered under: the relation's name until `.as(name)`, which returns a new expression); two plugins around the chain (`capture` first, `results` last) revive dates, booleans and JSON inside the answer, and a top-level relation is answered under exactly its alias as written. A `many` takes `where: (eb) => Expression<SqlBool>` (0.11): called once in `specOf()` with a bare `expressionBuilder()`, kept as its operation node and embedded in the correlated subquery by `render()` after `Qualify` (an `OperationNodeTransformer`) moved its columns — bare, or named after the related table — to the alias the related rows go by (`_r<depth>`, `_s<depth>` when ordered or cut); a subquery of the condition that reads the related table under its own name keeps that name, a column of another table outside a subquery is refused, and so is a `where` on a `one`.

## Key Conventions

- Database definition files live in `src/databases/`. Files named `schema.ts`, `_*.ts`, and `.d.ts` are excluded from action discovery.
- Actions can be defined inline in the database file or in separate files in the same directory. Both are transformed identically: `transformDatabaseFile` handles same-file actions (plus `destroyDatabase`), `transformActionFile` handles separate files.
- Schema tables must be defined in a schema module and imported into the database file — inline table definitions can't be loaded by the migration CLI and fail loudly. `schema` is read at build time (`extractSchema` in `src/vite/modules/parser.ts`), in two forms: the tables listed (`schema: { users, posts }`, also as a `const` of the database file → `DatabaseInfo.schemaTableNames`) or ONE const the schema module exports (`import { schema } from './schema'`; a default export too; `as const`/`satisfies` seen through → `DatabaseInfo.schemaExport`, with `schemaTableNames` empty). `declaresSchema(db)` answers "has one" for both; anything else warns at build time and the database gets no schema. With `schemaExport` the generated modules import that export (`__schema_<db>`) and hand the object itself to `defineDatabase`/the DO class, and the CLI reads the tables off it (`loadSchemaTables` in `src/cli/shared.ts`, used by push/generate/status/validate).
- The Vite plugin uses Babel (not regex) for all source code analysis. `transform` first applies a cheap superset check (`mayDefineDatabaseCode`: mentions `defineDatabase`/`destroyDatabase`, or has an import declaration with an `action` specifier in any clause form — `import main, { action }`, `type`, comments, line breaks; it must admit everything the parser takes an action factory from) so unrelated modules are never Babel-parsed — a syntax error in a page is reported by the compiler that owns it, not as `[plugin:durable-db]`.
- `vite` is a peer dependency, 5 through 8.
- Build output is ESM-only via tsdown.
- Tests mirror source structure under `tests/`.
