---
"durable-db": minor
---

An action is one transaction of its Durable Object. Its writes, the messages it pushed to the outbox and the alarm that delivers them are committed together when the handler resolves, and none of them when it throws — until now a statement that failed part-way kept the ones before it, and a handler that pushed and then threw kept its writes. While an action runs its object takes no other call, so two actions never interleave at an `await` (a read and a write of a balance, `max(number) + 1`, the calls that waited on one migration run). Measured in local workerd: about 0.07 ms a call.

- `ctx.transaction(async () => { … })` runs a part of an action that may fail on its own: its writes and messages are rolled back when it throws, and the action goes on. An action of the same database called from another runs as such a part.
- Kysely's `db.transaction()` is refused, naming `ctx.transaction()` (a Durable Object refuses SQL's `BEGIN` anyway).
- A call from an action back into an object waiting on it (`billing → ledger → billing`) is refused at once with an `ActionCycleError` naming the chain, instead of waiting 30 s for itself and resetting the object. `batchedRpc()` takes the target's name as a fifth argument (the transform passes it).
- The test harness runs actions the same way: `BEGIN … COMMIT` per run, one run at a time per test database, savepoints for parts, the same refusals. `t.runHandler(handler, args)` runs an already validated handler that way.
- `SqliteDurableObject.runWithOutbox()` is now `runAction()`.
