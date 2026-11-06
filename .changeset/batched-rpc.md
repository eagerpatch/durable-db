---
"durable-db": minor
---

Calls to the same Durable Object instance that start in the same turn — `Promise.all([a(), b()])`, sibling server components fetching at once — now share one RPC (`rpcBatch`, a new method of the generated Durable Objects). The object runs them one after another, in the order they were made, and returns each result or error to its own caller. A lone call is still a plain `rpc`. The compiled call site also stops building the action's args schema on every call: it is compiled once per isolate (`cachedArgsSchema`).
