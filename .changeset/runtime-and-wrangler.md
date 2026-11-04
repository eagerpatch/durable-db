---
'durable-db': minor
---

Runtime and wrangler config fixes found by building an app on durable-db through a framework.

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
