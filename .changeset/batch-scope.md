---
'durable-db': minor
---

Calls are batched within one invocation, never across two: `batchScope()`. Since 0.6.0 the calls to one Durable Object that started in the same turn waited in one list per object for the whole isolate, so two requests that reached the same object at the same time shared a batch — the RPC was sent by one of them, and the other's call was settled from a request context that was not its own. The Workers runtime refuses that ("A promise was resolved or rejected from a different request context"), and the request was left hanging until it was cancelled: two concurrent requests of one tenant were enough for a 500.

A batch now belongs to a scope. Wrap what the platform invokes — `fetch: (request, env, ctx) => batchScope(() => app.fetch(request, env, ctx))`, and a `queue` or `scheduled` handler the same way — and the calls that invocation starts on one object before it waits on I/O travel in one RPC, as before. Outside a scope every call is its own RPC: a worker that does not open one is correct and unbatched. `batchScope` is exported from `durable-db/registry`, where the compiled call sites get their `batchedRpc`; the scopes live in one store per isolate, whichever copy of the package opens them.
