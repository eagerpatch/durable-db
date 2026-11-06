---
"durable-db": minor
---

`durable-db/type`: ArkType's `type()` — the same definitions, inferred types, error messages and JSON Schema — on a runtime of its own that builds nothing at import. ArkType initialised its whole scope of keywords when imported, ~40 ms of CPU at every cold start of a worker and of every Durable Object; importing this takes ~2 ms, and a validation is about as fast as ArkType's without its JIT. `type` from `durable-db` and `durable-db/db` and every action's `args` use it; arktype is now only a source of types (no runtime import). A ready ArkType Type, or any Standard Schema, still works as `args`. ArkType's scopes, generics, `match` and `fn` are not supported: a definition the runtime does not know fails with a `ParseError` naming it.
