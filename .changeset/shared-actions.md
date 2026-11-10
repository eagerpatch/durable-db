---
"durable-db": minor
---

Shared actions, for libraries: `registerSharedAction(name, { validator, handler })` (`durable-db/registry`) registers an action every database has — `stub.rpc(name, args)` runs it in whichever Durable Object is called, with that database's `db` and the action context; a database's own action of the same name wins. `virtual:durable-db/__databases` lists the discovered databases with their tables (`{ name, bindingName, className, instance, schema }`) for a library that maps a table to its database. Both are opt-in: nothing is registered or generated unless a module asks.
