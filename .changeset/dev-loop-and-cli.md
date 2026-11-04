---
'durable-db': minor
---

The Vite plugin patches wrangler.jsonc in its `config` hook (with `patchWranglerConfig: true`), before
`@cloudflare/vite-plugin` reads the file. Patched lazily, a build emitted the `wrangler.json` it had read
before the patch — a database added since the last build shipped unbound, without its migration — and the
first dev start restarted mid-start (no URLs printed, an unhandled rejection logged). A change is now logged
(`durable-db updated wrangler.jsonc (Durable Objects: +AUDIT_DATABASE_DO → AuditDatabaseDO; migration v2: …)`);
nothing is written while a database file does not parse. `syncWranglerConfig({ projectRoot, databasesDir })`
from `durable-db/vite` runs the same step for CLIs that want the file settled before Vite starts.

The plugin's `transform` only Babel-parses modules that can define a database or actions (they mention
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
