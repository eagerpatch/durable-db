---
'durable-db': minor
---

`related()` for a library: `createRelated(schema)` is exported (`durable-db`, `durable-db/db`) — the builder `defineDatabase()` hands out as `related`, for code that is handed a schema and not the database file. For a schema whose tables TypeScript knows it is typed the same; for one known only at runtime (`AnySchema`) it is `AnyRelated`: strings, checked when called — the table, the relation, its columns, the order, a blob column refused. `RelatedSpec` (what a `RelatedExpression` is made from) and the `AnyRelated` / `AnySchema` types are exported with it. A nested relation must be built for the same schema object as the one it is nested in.

`.as(name)` answers a relation under another name — `related('invoices', 'customer', ['name']).as('buyer')` — at the top of a query and inside `with`, typed, so one relation can be read twice in a query (`.as('invoices')`, `.as('latest')`). It returns a new expression. A relation at the top of a query is now answered under exactly the name it was given, whatever the naming plugin would make of it (`line_items` stays `line_items`); a relation's own name was already that.
