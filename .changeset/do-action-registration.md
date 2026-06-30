---
"durable-db": patch
---

Register all actions in the Durable Object's isolate at startup. The action registry is a module singleton populated when an action file loads, but the generated DO module didn't import action files — so it relied on the request path having loaded them. That holds in dev (one shared isolate) and via in-app navigation, but a Durable Object is a separate, persistent isolate in production: a freshly deep-linked route whose action the DO never loaded threw `Unknown action "X" (was it imported?)`. The generated DO module now side-effect-imports every action-defining file (discovered recursively under the databases dir), so all actions register at DO startup regardless of entry route.
