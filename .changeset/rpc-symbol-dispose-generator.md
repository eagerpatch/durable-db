---
"durable-db": patch
---

Strip the Cloudflare RPC `Symbol.dispose` from action results in the **generated
page→DO stub** too.

0.1.4 stripped it in `callAction` (the action-to-action cross-DB path), but the
common case — an app page / `"use server"` function calling an action, which goes
through the Vite-plugin-**generated** action proxy (`stub.rpc(...)`) — still
returned the symbol-keyed RPC object, so passing the result to a client component
still threw "Objects with symbol properties like Symbol.dispose are not supported".
The generated proxy's out-of-DO path now returns `stub.rpc(...).then(structuredClone)`,
yielding a plain clone (symbol keys dropped, Date/Map/Set preserved). Verified
end-to-end in a ShopLayer app.
