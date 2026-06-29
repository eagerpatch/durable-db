---
"durable-db": patch
---

Strip the Cloudflare RPC `Symbol.dispose` from cross-DB action results.

Action results returned over the Durable Object RPC boundary carry a top-level
`Symbol.dispose` that Cloudflare attaches for explicit resource management. React
Server Components refuse to serialize symbol-keyed props ("Objects with symbol
properties like Symbol.dispose are not supported"), so returning an action result
from a `"use server"` function — or passing it straight to a client component —
threw at runtime. `callAction` now `structuredClone`s the RPC result, dropping all
symbol keys while preserving value types (Date/Map/Set/etc., unlike a JSON
round-trip). The same-DB direct-call and WebSocket transport paths already returned
plain values and are unchanged.
