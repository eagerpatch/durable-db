---
'durable-db': patch
---

Better failure modes for dev and deploy:

- A pending migration that fails with "already exists" (storage holds tables the `__migrations` journal doesn't track — typically renamed/regenerated migration files) now raises `MigrationSchemaConflictError` with recovery guidance (`db reset` in dev, baseline the journal in production) instead of a raw SQLITE_ERROR.
- When the storage backend rejects a PITR restore as unsupported (local workerd hands out bookmarks but doesn't implement restore), PITR is disabled for that instance and the miss is logged at debug level — no more error-level "PITR restore failed" line that reads like a second failure.
- The Vite plugin no longer crashes the dev server on the first run of a fresh project: its own bootstrap write of the dev epoch no longer bounces through the cache watcher as a full reload, and reload sends skip hot channels whose transport isn't connected yet (e.g. @cloudflare/vite-plugin before its module-runner WebSocket exists).
- Production builds now fail when wrangler.jsonc is missing Durable Object bindings for discovered databases and `patchWranglerConfig` is off — previously the build succeeded and the deploy shipped a worker with no DO bindings. Dev still warns, and wrangler.toml projects still warn (the check can't parse toml).
