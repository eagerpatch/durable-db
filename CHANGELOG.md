# durable-db

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
