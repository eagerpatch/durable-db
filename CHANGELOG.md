# durable-db

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
