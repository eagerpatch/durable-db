---
"durable-db": minor
---

The outbox: `ctx.outbox.push(message)` in an action records a message for something outside the Durable Object — a queue, an email, a webhook — written with the action's writes (a handler that throws records none) and delivered by the object's alarm after it succeeds, at least once, retried with backoff. Where it goes is `durableDb({ outbox: { queue: 'BINDING' } })` (each message to a Queue as it is) or `durableDb({ outbox: { module: './src/outbox.ts' } })` (a module that delivers them). `createTestDatabase()` keeps what was pushed in `t.outbox` and hands it to its `outbox` option. Test actions now get a `ctx` (`env`, `instanceKey`, `outbox`) like the object's.
