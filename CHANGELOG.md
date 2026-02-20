# @eagerpatch/durable-db

## 0.1.0

### Minor Changes

- Add `destroyDatabase()` API for clearing Durable Object data

  Users can now destructure `destroyDatabase` from `defineDatabase()` to get a function that atomically wipes the DO instance's SQLite database via `ctx.storage.deleteAll()`. This is the only way to fully clear Cloudflare billable storage metadata. After destruction, the next action call re-runs migrations and starts fresh.

  - For `per-tenant` databases: targets the current tenant
  - For `global` databases: targets the single shared instance
  - Opt-in: only generated if `destroyDatabase` is destructured
  - Generated DO classes now include a `sys(command)` method for system operations
  - `SqliteDurableObject` gains `resetMigrationState()` for post-destroy re-initialization

## 0.1.0

### Minor Changes

- Fix arktype module resolution error in consumer projects by importing `type` from `@eagerpatch/durable-db/db` instead of directly from `arktype` in the generated virtual module.

## 0.0.2

### Patch Changes

- Fix arktype module resolution error in consumer projects by importing `type` from `@eagerpatch/durable-db/db` instead of directly from `arktype` in the generated virtual module.
