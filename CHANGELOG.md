# durable-db

## 0.4.0

### Minor Changes

- 3b2da5c: The plugin's `transform` only Babel-parses modules that can define a database or actions (they mention
  `defineDatabase`, or import an `action` factory): a syntax error in a page is reported by the compiler that owns
  it, not as `[plugin:durable-db]`.
  
  Dev epochs are per database. `db reset --database <name>` gives that database its own epoch
  (`state.json` → `databases[name].epoch`), so only its instances start fresh — a tenant directory and every other
  database keep their data; a full reset sets a new project epoch for all. `applyDevEpoch(key, dbName)`: generated
  stubs pass their database's name. Inside a global database's Durable Object, `getTenantId()` no longer returns
  `'global'` in dev.
  
  `--database` is on every command (`push`, `generate`, `status`, `reset`, `validate`), and an unknown name exits
  with code 1 listing the valid ones (`UnknownDatabaseError`) instead of "No databases found." or resetting
  everything.
  
  Renames without a terminal: drizzle-kit's "created or renamed?" questions can be answered on the command line —
  `push`/`generate --rename <table>.<old>=<new>` (a column; `<old>=<new>` a table; repeatable) and `--no-renames`
  (create + drop) — or programmatically (`renames`, `noRenames`, `interactive: false`). Without a TTY and without
  answers, the commands fail with `SchemaRenameRequiredError`, naming the command and both answers, instead of
  drizzle-kit's bare "Interactive prompts require a TTY terminal". `db status` never prompts and reports such a
  change as "Changes pending — needs rename resolution" instead of "Schema is up to date".
  
  `db generate` refuses a column added `NOT NULL` without a default (exit 1, nothing written): the migration fails
  on every table that has rows, so every tenant with data would break after the deploy — add `.default(...)`, or
  add it nullable and backfill. `--force` writes it anyway. It warns about dropped columns and tables and columns
  made NOT NULL; `push` and `status` show the same warnings, and `db validate` reports them for the change not yet
  generated (its replay runs on an empty database).
  
  `db reset --purge-local-storage` refuses while the project's dev server runs (the plugin records it in
  `node_modules/.cache/durable-db/dev-server.json`; `--force` overrides): deleting workerd's storage under it broke
  every database request until a restart.
- 3b2da5c: Runtime and wrangler config fixes found by building an app on durable-db through a framework.
  
  - **Concurrent first calls share one migration run.** `ensureMigrations()` memoises the run in flight
    instead of guarding it with a boolean. A new tenant's first calls arriving together (server
    components, a client component's RPC call on mount, React StrictMode's double effect) used to apply
    the same `CREATE TABLE`s twice, and one of them failed with `MigrationSchemaConflictError`.
  - **`db push` then `db generate` no longer breaks the dev database.** In dev, a Durable Object journals
    the statements its dev migrations (`_dev_…`) apply. A pending production migration whose statements
    those dev migrations already ran is recorded as applied without being executed. Before, it ran again
    and failed with "duplicate column name" on every request until `db reset` wiped every dev database.
    Production storage never holds the journal, so production behaviour is unchanged. A "duplicate column
    name" failure now raises `MigrationSchemaConflictError` as "already exists" does. Its message names
    the dev migrations involved and the `db reset --database <name>` to run; the generated Durable Object
    sets `databaseName`, so the name is the one `db` commands know (`orderItems`, not `order-items`).
  - **A second `db push` no longer breaks the dev database either.** `db push` diffs from the production
    snapshot, so after add a column → restart → add another, the new dev migration repeats the first
    one's `ALTER`s. A pending dev migration now skips the statements of an earlier dev migration it
    contains whole. One that redoes an earlier change in another form (a column whose type changed again)
    still runs and raises `MigrationSchemaConflictError`, now saying so.
  - **Queries quote identifiers with backticks.** SQLite, workerd's build included, reads a double-quoted
    identifier that names no column as a string literal. A column missing from the database (a schema
    change not yet migrated) used to select its own name, and a `WHERE` on it compared two constants. It
    now fails with "no such column". Raw `sql` you write yourself is unchanged.
  - **The wrangler config is reconciled, not only appended to.** With `patchWranglerConfig: true`:
    - durable-db's own bindings (`<X>_DATABASE_DO` → `<X>DatabaseDO`) whose class is no longer a
      discovered database are removed. workerd refuses to start with a binding to a class the worker does
      not export.
    - A database of a mounted source whose class name changed unambiguously (the source's mount changed,
      or the database moved into a mounted source; its file name unchanged) gets a `renamed_classes`
      migration, so its deployed data moves with it. Before, it got a new class and the data was orphaned.
      The renamed Durable Object keeps the old storage and its `__migrations` journal, so the old
      database's migrations directory moves with it (`migrations/reviews-feedback/` →
      `migrations/feedback-feedback/`). When it cannot — the new directory already has migrations, or more
      than one directory belongs to the old class — nothing is written for that database: a warning gives
      the commands to keep the data or the `deleted_classes` migration to drop it, and the plugin stops
      until one is done. A database moved out of a mount, or two databases of the app, are never paired:
      `ProductCatalogDatabaseDO` → `CatalogDatabaseDO` reads the same as replacing product-catalog.ts with
      catalog.ts. Local dev storage is kept per class name, so in dev a renamed database starts empty.
    - A removed database's class is never deleted for you, because that deletes its data. A warning gives
      the exact `deleted_classes` migration to add, or says to drop the class from its
      `new_sqlite_classes` entry if it was never deployed.
    - Bindings of other names, and bindings to other workers' classes (`script_name`), are never touched.
  
    `checkWranglerConfig()` reports such stale bindings and classes (`staleBindings`, `staleClasses`,
    `renamedClasses` with the `mv` for their `migrationsMoves`, `conflicts`), so a production build fails on
    them when patching is off, with an error that names what is missing and what is stale
    (`describeWranglerCheck()`). A rename target is no longer reported as a missing class too, and the
    suggested migration takes the next free tag. `PatchResult` gains `addedBindings`, `removedBindings`,
    `newClasses`, `migrationTag`, `renamedClasses`, `movedMigrations`, `conflicts` and `deletedClasses`.
  - **wrangler.jsonc is patched before anything reads it.** With `patchWranglerConfig: true` the plugin
    reconciles the file in its `config` hook, before `@cloudflare/vite-plugin` reads it. Patched lazily, a
    build emitted the `wrangler.json` it had read before the patch — a database added since the last build
    shipped unbound, without its migration — and the first dev start restarted mid-start (no URLs printed, an
    unhandled rejection logged). A refused rename stops the plugin right there. A change is logged in one line
    (`durable-db updated wrangler.jsonc (Durable Objects: +AUDIT_DATABASE_DO → AuditDatabaseDO; migration v2:
    …)`, removals and renames included); nothing is written while a database file does not parse. Later, the
    plugin reconciles again only when the set of databases changes (one added or remounted while the dev
    server runs). `syncWranglerConfig({ projectRoot, databasesDir, migrationsDir })` from `durable-db/vite`
    runs the same step for CLIs that want the file settled before Vite starts; it returns the `PatchResult`
    (`conflicts` included) with the databases, the files that did not parse and the summary's `changes`.
  - **wrangler.jsonc edits keep the file as you wrote it.** Comments, formatting, the indentation style,
    line endings and the trailing newline all survive. Only the entries added or removed change, and one-line
    arrays stay on one line. No `wrangler.jsonc.backup` is written any more. The config is parsed as
    JSONC, so trailing commas are fine. This adds `jsonc-parser` as a dependency.
  - **Optional action args accept `undefined`.** `'photoKey?': 'string'` infers `{ photoKey?: string }`,
    which accepts `photoKey: undefined`, but validation used to reject it ("photoKey must be a string (was
    undefined)"). Action args now compile in an ArkType scope with `exactOptionalPropertyTypes: false`, in
    the RPC stub and the Durable Object alike: an optional key at any depth admits `undefined`, a required
    key stays required (also `'note': 'string | undefined'`, as in TypeScript), and the args Type stays a
    plain object Type (`.props`, `.toJsonSchema()`). `durable-db/registry`'s `type` is that scope's; the
    `type` exported from `durable-db` is unchanged. An `args` given as a ready `type(…)` keeps the rules of
    the scope that made it.
  - **Code that calls actions can be tested in Node.** An action called directly outside the build (a page,
    procedure or job under test) now runs against the test database `createTestDatabase()` created for
    its database's tables (the newest live one). `destroyDatabase()` empties that database. Without a test
    database, the error says how to set one up and no longer points at a Vite config or dumps ArkType
    internals.
  - The `vite` peer range includes Vite 8.

## 0.3.0

### Minor Changes

- b268df4: Babel 8 (parser, traverse, generator, types), drizzle-orm 0.45 / drizzle-kit 0.31, and the workers
  tests run on `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`). The Vite plugin's
  transform hook returns what Vite's `TransformResult` takes.

## 0.2.2

### Patch Changes

- 8c3e0fe: The declarations keep arktype external again. tsdown 0.23 inlined arktype's type graph into the
  `.d.ts` along with the bundled runtime, which lost the ambient `type()` DSL typing in consumers
  (`'string' is not allowed here`). The build now runs two passes: JavaScript with arktype bundled,
  declarations importing from the consumer's `arktype`.

## 0.2.1

### Patch Changes

- 9c16993: Dependency refresh: vitest 5, vite 8, TypeScript 7 (the build runs on tsdown 0.23; `downlevelIteration`
  is gone from tsconfig), @cloudflare/workers-types 5, kysely 0.29, arktype 2.2, changesets 3,
  @types/node 26. Babel stays on 7 and drizzle-orm on 0.38 for now.

## 0.2.0

### Minor Changes

- ff8157d: Databases from several directories: `databasesDir` (plugin option, CLI discovery) takes a list of
  `{ dir, prefix? }` sources besides a single directory. A source's prefix is prepended to every
  database name found there (`invoicing-main` → `InvoicingMainDatabaseDO`, `INVOICING_MAIN_DATABASE_DO`,
  `migrations/invoicing-main/`), so a host framework can mount a module's databases next to the app's
  own. `createDbCommand(defaults)` / `registerDbCommands(program, defaults)` take the sources the `-d`
  flag otherwise names. Directories in a list that do not exist are skipped silently; absolute
  directories are accepted.

## 0.1.13

### Patch Changes

- 03a93d0: commander 15: a host CLI on commander 15 can mount `createDbCommand()` without its top-level help
  throwing (`sub.helpGroup is not a function` — commander 15's help calls a method commander 13's
  Command lacks).

## 0.1.12

### Patch Changes

- 21a3e6b: getTenantId() now falls back to the Durable Object context when no resolver is configured: inside a DO the instance key IS the tenant (minus the dev `__dev_<epoch>` suffix), so action handlers can read the tenant without the worker-side setTenantIdResolver — which the DO execution context never runs. The registry publishes its DoContext store getter on globalThis so the fallback works even when a bundler produces two copies of the package in one worker.

## 0.1.11

### Patch Changes

- 512cc62: fix: `validate` no longer reports false schema drift for tables altered with `ALTER TABLE ... ADD COLUMN`

  The drift check compared raw `sqlite_master` CREATE text between the migration-replay database and the from-scratch schema database. SQLite rewrites a table's stored CREATE statement when a column is added via ALTER (the column is spliced in before the closing paren, always last), so any generated column-add migration could never text-match the fresh CREATE — every such migration failed validation and blocked deploys.

  Tables are now compared structurally via PRAGMA introspection (`pragma_table_info`, `pragma_index_list`/`pragma_index_info` for UNIQUE constraints, `pragma_foreign_key_list`), which reflects what SQLite actually enforces regardless of how the table was built. Column order is intentionally ignored. Indexes, views, and triggers are still compared textually. Known gap: CHECK constraints, column collations, and WITHOUT ROWID/STRICT options are not exposed by PRAGMAs and are no longer part of the comparison.

## 0.1.10

### Patch Changes

- Migration chunks now commit atomically with their journal row (`storage.transactionSync`).

  Previously each chunk's statements and the `__migrations` journal insert ran as separate writes. A crash — or a dev server killed mid-boot — between a `CREATE TABLE` and the journal insert left the schema applied but unrecorded: storage that throws `MigrationSchemaConflictError` ("table already exists ... journal has no record") on every subsequent boot. Production is shielded by the PITR bookmark restore, but local dev has no PITR, so the only way out was `db reset --purge-local-storage`.

  With `transactionSync`, a failed or interrupted chunk rolls back completely — either the whole chunk plus its journal row lands, or nothing does. Mocked/test storages without `transactionSync` fall back to the old inline execution.

## 0.1.9

### Patch Changes

- The generated Durable Object now carries the database's Drizzle schema and builds its Kysely with the full schema-aware plugin chain.

  Previously the DO used the base class's schema-less Kysely (`createKyselyFromSql(sql)` with only CamelCase + heuristic date handling), so the schema-aware plugins — `DrizzleDefaultsPlugin` (defaultFn/onUpdateFn), `SchemaPlugin` (exact column-name mapping), schema-gated date deserialization, and the new `BooleanDeserializePlugin` — never ran on the production action path. Most visibly: `integer({ mode: 'boolean' })` columns read back as raw storage values instead of booleans.

  The Vite plugin now emits an aliased import of the schema tables into the generated module and a `schema = { … }` class property; `SqliteDurableObject` builds `db` lazily (subclass field initializers run after the constructor) with the schema when present. Subclassing without a schema keeps the old behavior.

## 0.1.8

### Patch Changes

- Two Kysely-over-SqlStorage driver fixes, both found in the field and both invisible to the node-based unit suites:

  - **Statements with more than 100 bound parameters no longer throw `too many SQL variables`.** workerd's SQLite is compiled with `SQLITE_MAX_VARIABLE_NUMBER = 100`, so a modest multi-row insert (24 rows × 7 columns = 168 params) or a large `WHERE … IN (…)` list blew up. Past the limit, the driver now inlines parameters as escaped SQL literals (a real scanner that never touches `?` inside string literals, quoted identifiers, or comments) — still a single statement with identical semantics.
  - **Boolean columns round-trip as booleans.** workerd has no boolean binding type and silently stringified JS `true` into TEXT `'true'` (which then failed `'boolean'` arg validation downstream, and made a stored `'false'` truthy). The driver now normalizes boolean bindings to SQLite's 1/0 (and `undefined` → NULL), and a new schema-aware `BooleanDeserializePlugin` maps `integer({ mode: 'boolean' })` columns back to real booleans on read — including legacy TEXT `'true'`/`'false'` rows written by the old driver.

  Covered by a new workerd E2E suite (`tests/workers/kysely-e2e.test.ts`) that runs the production plugin chain against a real DO SqlStorage.

## 0.1.7

### Patch Changes

- 02bf9f2: Register all actions in the Durable Object's isolate at startup. The action registry is a module singleton populated when an action file loads, but the generated DO module didn't import action files — so it relied on the request path having loaded them. That holds in dev (one shared isolate) and via in-app navigation, but a Durable Object is a separate, persistent isolate in production: a freshly deep-linked route whose action the DO never loaded threw `Unknown action "X" (was it imported?)`. The generated DO module now side-effect-imports every action-defining file (discovered recursively under the databases dir), so all actions register at DO startup regardless of entry route.
- 02bf9f2: Fix `EvalError: Code generation from strings disallowed` (500) in production Cloudflare Workers. arktype compiles validators with `new Function` (runtime codegen), which Workers allow at startup but block during request handling — so a route's action `args` schema that compiles at request time crashed. arktype's `envHasCsp()` auto-probe mis-detects this (it runs at startup, where codegen still works). durable-db now re-exports `type` from an explicitly jitless (eval-free) arktype scope, so every `type({...})` is interpreted rather than compiled — independent of bundle init order. Dev was unaffected because its workerd allows codegen.

## 0.1.6

### Patch Changes

- 052c049: vite: keep Drizzle base classes through Rolldown (Vite 8) production tree-shaking. `drizzle-orm` ships `sideEffects:false`, and Rolldown fails to count a cyclic `class Sub extends Base` as a use of `Base` — so it deletes the apparently-unused base-class module entirely while keeping the `extends` reference, crashing the worker at boot with e.g. `TypedQueryBuilder is not defined`. `databasePlugin()` now tags `drizzle-orm` modules side-effectful (a plugin hook's `moduleSideEffects` outranks the package's `sideEffects` field), forcing Rolldown to retain them. Fixes the bug at the source for any durable-db + Vite 8 consumer.

## 0.1.5

### Patch Changes

- 597c275: Strip the Cloudflare RPC `Symbol.dispose` from action results in the **generated
  page→DO stub** too.

  0.1.4 stripped it in `callAction` (the action-to-action cross-DB path), but the
  common case — an app page / `"use server"` function calling an action, which goes
  through the Vite-plugin-**generated** action proxy (`stub.rpc(...)`) — still
  returned the symbol-keyed RPC object, so passing the result to a client component
  still threw "Objects with symbol properties like Symbol.dispose are not supported".
  The generated proxy's out-of-DO path now returns `stub.rpc(...).then(structuredClone)`,
  yielding a plain clone (symbol keys dropped, Date/Map/Set preserved). Verified
  end-to-end in a ShopLayer app.

## 0.1.4

### Patch Changes

- fd6a6c5: Strip the Cloudflare RPC `Symbol.dispose` from cross-DB action results.

  Action results returned over the Durable Object RPC boundary carry a top-level
  `Symbol.dispose` that Cloudflare attaches for explicit resource management. React
  Server Components refuse to serialize symbol-keyed props ("Objects with symbol
  properties like Symbol.dispose are not supported"), so returning an action result
  from a `"use server"` function — or passing it straight to a client component —
  threw at runtime. `callAction` now `structuredClone`s the RPC result, dropping all
  symbol keys while preserving value types (Date/Map/Set/etc., unlike a JSON
  round-trip). The same-DB direct-call and WebSocket transport paths already returned
  plain values and are unchanged.

## 0.1.3

### Patch Changes

- c1f1c85: Replace the `debug` dependency with a tiny internal logger. `debug`'s entry is a
  runtime-conditional `module.exports = require(isBrowser ? './browser' : './node')`,
  which Rolldown can't statically interop. Under Vite 8 the `database:vite/cli/migrations`
  namespaces get pulled into the worker runtime via `context`, and the worker
  module-runner evaluates that CJS with no `module` in scope → crash at boot
  ("module is not defined"). The internal logger keeps the same `createDebug(namespace)`
  API and `DEBUG`-env gating, with zero dependencies.

## 0.1.2

### Patch Changes

- Alias the injected `type` import so it never collides with an app's own `type`
  import. The action transform injects `import { …, type } from "durable-db/registry"`
  into the user's file; if the app already does `import { type } from '…'` (e.g.
  arktype's `type` re-exported by a framework), the two top-level `type` bindings are a
  duplicate declaration. Rollup tolerated it, but rolldown (Vite 8+) rejects it with
  `Identifier 'type' has already been declared`. The injected `type` is now imported
  under an internal alias (`__ddType`) and the generated validators reference that,
  so the transform still routes to durable-db's own arktype instance with no clash.

## 0.1.1

### Patch Changes

- Resolve Vite path aliases (e.g. `@/databases/schema`) in `src/databases/`
  imports, not just relative paths. The schema-import resolver and the action()
  call-site transform now resolve non-relative specifiers through the project's
  Vite `resolve.alias` config (the single source of truth — it already includes
  aliases wired in from tsconfig `paths` by frameworks like rwsdk). The Vite
  plugin reads the resolved config / uses Vite's own resolver; the CLI loads the
  Vite config to obtain the aliases. Relative imports are unchanged (fast path),
  and resolution falls back to relative-only if no Vite config is available.

## 0.1.0

### Minor Changes

- 9c49545: Add a `durable-db/testing` harness for unit-testing database actions.

  `createTestDatabase({ schema })` spins up a real in-memory SQLite (Node's
  built-in `node:sqlite`) wired through the same Kysely plugin chain as
  production, then runs `action()` handlers against it with `run(action, args)` —
  args are validated with the action's arktype schema, exactly like production.
  This lets apps test their persistence layer in plain `vitest` (node env) with no
  worker pool.

  Internally, the Kysely-over-`SqlStorage` bridge (`createKyselyFromSql`) was split
  out of `SqliteDurableObject.ts` into `src/db/kysely.ts` so it can be imported
  without pulling in the `cloudflare:workers` runtime import. Public API is
  unchanged (`createKyselyFromSql`, `CreateKyselyOptions`, `SqlExecutor` are still
  re-exported from `durable-db/db`).

## 0.0.3

### Patch Changes

- 96a3ed0: Better failure modes for dev and deploy:

  - A pending migration that fails with "already exists" (storage holds tables the `__migrations` journal doesn't track — typically renamed/regenerated migration files) now raises `MigrationSchemaConflictError` with recovery guidance (`db reset` in dev, baseline the journal in production) instead of a raw SQLITE_ERROR.
  - When the storage backend rejects a PITR restore as unsupported (local workerd hands out bookmarks but doesn't implement restore), PITR is disabled for that instance and the miss is logged at debug level — no more error-level "PITR restore failed" line that reads like a second failure.
  - The Vite plugin no longer crashes the dev server on the first run of a fresh project: its own bootstrap write of the dev epoch no longer bounces through the cache watcher as a full reload, and reload sends skip hot channels whose transport isn't connected yet (e.g. @cloudflare/vite-plugin before its module-runner WebSocket exists).
  - Production builds now fail when wrangler.jsonc is missing Durable Object bindings for discovered databases and `patchWranglerConfig` is off — previously the build succeeded and the deploy shipped a worker with no DO bindings. Dev still warns, and wrangler.toml projects still warn (the check can't parse toml).

## 0.0.2

### Patch Changes

- a70a8b2: Fix four bugs found while dogfooding, plus live dev-state reloading:

  - **Same-file actions work**: `action()` definitions in the same file as `defineDatabase()` are now transformed into RPC stubs like separate action files, instead of throwing "Action called without transformation" at runtime.
  - **Schema loading fails loudly**: `db push`/`generate`/`status`/`validate` now error (exit 1) when declared schema tables can't be loaded — inline table definitions, unresolvable schema imports, build failures, or missing exports — instead of silently reporting "no changes".
  - **Text date columns round-trip verbatim**: `text()` columns holding ISO date strings no longer come back as `null` over the action RPC. `DateSerializePlugin` only deserializes the exact `YYYY-MM-DD HH:MM:SS` format its write path produces, never double-appends timezone markers, and is schema-aware via `createDrizzlePlugins` (only Drizzle date-typed columns convert to `Date`).
  - **`db reset` actually gives fresh databases**: the dev epoch is now baked into generated stubs via the `virtual:durable-db/__devEpoch` module (`applyDevEpoch(key)`, identity in production builds). A reset's epoch bump rotates every database to a brand-new DO instance on the next request — no storage deletion, dev server can keep running. New opt-in `db reset --purge-local-storage` deletes the orphaned instances under `.wrangler/state/v3/do`.
  - **Live CLI integration**: the Vite dev server watches durable-db's dev cache, so `db reset` and `db push` take effect immediately (epoch + embedded dev migrations reload) without restarting.

  - **Flat `db` binary**: the standalone CLI is now `db push`/`db reset`/… instead of the accidental `db db push`. The commands remain reusable in host CLIs: `createDbCommand()` mounts them as a nested `db` group, and the new `registerDbCommands(program)` registers them flat on any Commander command.

  - **Wrangler patching is opt-in**: the plugin no longer writes to `wrangler.jsonc` by default. It verifies the config and logs the exact JSON to add when Durable Object bindings or sqlite migration entries are missing; pass `durableDb({ patchWranglerConfig: true })` to restore automatic patching.

  The package also moved and got renamed surfaces:

  - **Published to npm as `durable-db`** (previously `@eagerpatch/durable-db` on GitHub Packages). All import specifiers drop the scope: `durable-db`, `durable-db/vite`, `durable-db/schema`, ….
  - **Plugin renamed**: `import { durableDb } from 'durable-db/vite'` (the `databasePlugin` name remains as a deprecated alias).
  - **Virtual modules renamed**: `virtual:durable-db/__durableObjects` and `virtual:durable-db/__devEpoch` (the old `virtual:eagerpatch/…` ids still resolve).
  - **Root exports**: `defineDatabase`, `setTenantIdResolver`, `getTenantId`, and the schema builders are importable straight from `durable-db`; the `/db`, `/context`, and `/schema` subpaths still work.
  - The dev cache moved to `node_modules/.cache/durable-db` (the old `@eagerpatch` cache is simply abandoned — run `db push` once after upgrading).

  Note: in development, DO instance keys are now suffixed with `__dev_<epoch>`; production keys are unchanged. `getInstanceKey`/`getDevInstanceKeySuffix` from `./context` are deprecated in favor of the virtual module.
