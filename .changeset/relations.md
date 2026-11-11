---
"durable-db": minor
---

Relations, from the foreign keys a schema declares: `.references(() => customers.id)` on a column is now typed with its target (an overload on Drizzle's column builder, through `durable-db/schema`), and `defineDatabase()` returns `related` and `relations` next to `action`. `related(table, relation, columns | { columns, with, orderBy, limit })` is a selection for `select()` / `returning()`: the related row (`one`) or rows (`many`) under the relation's name, typed, nested to any depth through `with`, in the same SQL query (a correlated JSON subquery; dates and booleans revived like any column). Both directions are named from the one declaration — `invoices.customer`, `customers.invoices`, `<key>As<Forward>` when a table points at the same target twice. `relations` / `relationsOf(schema)` is the same registry at runtime and `Relations<Schema>` its type, for a library that maps a schema to an API.

Nothing changes for a schema or a query that does not use them: the extra Kysely plugins only act on a query that selects a `related()`. Not covered yet: a self or mutual reference is in the registry but not in the types (TypeScript needs `(): AnySQLiteColumn` there), composite foreign keys, an aliased outer table, `camelCase: false`, a `where` on a relation.
