---
"durable-db": minor
---

Add a `durable-db/testing` harness for unit-testing database actions.

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
