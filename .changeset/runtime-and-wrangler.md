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
  the dev migrations involved and the `db reset --database <name>` to run.
- **Queries quote identifiers with backticks.** SQLite, workerd's build included, reads a double-quoted
  identifier that names no column as a string literal. A column missing from the database (a schema
  change not yet migrated) used to select its own name, and a `WHERE` on it compared two constants. It
  now fails with "no such column". Raw `sql` you write yourself is unchanged.
- **The wrangler config is reconciled, not only appended to.** With `patchWranglerConfig: true`:
  - durable-db's own bindings (`<X>_DATABASE_DO` → `<X>DatabaseDO`) whose class is no longer a
    discovered database are removed. workerd refuses to start with a binding to a class the worker does
    not export.
  - A database whose class name changed unambiguously (an extension's mount changed, or a database moved
    into or out of a mounted source) gets a `renamed_classes` migration, so its data moves with it.
    Before, it got a new class and the data was orphaned.
  - A removed database's class is never deleted for you, because that deletes its data. A warning gives
    the exact `deleted_classes` migration to add, or says to drop the class from its
    `new_sqlite_classes` entry if it was never deployed.
  - Bindings of other names, and bindings to other workers' classes (`script_name`), are never touched.

  `checkWranglerConfig()` reports such stale bindings and classes (`staleBindings`, `staleClasses`), so a
  production build fails on them when patching is off. `PatchResult` gains `addedBindings`,
  `removedBindings`, `newClasses`, `renamedClasses` and `deletedClasses`.
- **wrangler.jsonc edits keep the file as you wrote it.** Comments, formatting, the indentation style,
  line endings and the trailing newline all survive. Only the entries added or removed change, and one-line
  arrays stay on one line. No `wrangler.jsonc.backup` is written any more. The config is parsed as
  JSONC, so trailing commas are fine. This adds `jsonc-parser` as a dependency.
- **Optional action args accept `undefined`.** `'photoKey?': 'string'` infers `{ photoKey?: string }`,
  which accepts `photoKey: undefined`, but validation used to reject it ("photoKey must be a string (was
  undefined)"). Undefined-valued keys of a plain-object args value are now dropped before validation, in
  the RPC stub and the Durable Object alike, whether `args` is an object or a `type(…)`. A required key
  passed as `undefined` still fails.
- **Code that calls actions can be tested in Node.** An action called directly outside the build (a page,
  procedure or job under test) now runs against the test database `createTestDatabase()` created for
  its database's tables (the newest live one). `destroyDatabase()` empties that database. Without a test
  database, the error says how to set one up and no longer points at a Vite config or dumps ArkType
  internals.
- The `vite` peer range includes Vite 8.
