---
"durable-db": patch
---

Fix `EvalError: Code generation from strings disallowed` (500) in production Cloudflare Workers. arktype compiles validators with `new Function` (runtime codegen), which Workers allow at startup but block during request handling — so a route's action `args` schema that compiles at request time crashed. arktype's `envHasCsp()` auto-probe mis-detects this (it runs at startup, where codegen still works). durable-db now re-exports `type` from an explicitly jitless (eval-free) arktype scope, so every `type({...})` is interpreted rather than compiled — independent of bundle init order. Dev was unaffected because its workerd allows codegen.
