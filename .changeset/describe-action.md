---
"durable-db": minor
---

`describeAction(action)`, for libraries: what an action is, read from the function an app exports — `{ database, name, args }`, `args` being its compiled schema (`.toJsonSchema()`), so a library can map actions to an API of its own without the app repeating their arguments. The build registers the compiled schema and the call site with each action (`registerAction(…, { validator, handler, args, stub })`); nothing else changes, and nothing reads them unless a module asks.
