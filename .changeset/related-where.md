---
'durable-db': minor
---

A relation's `where`: `related('invoices', 'invoiceLines', { columns, where: (eb) => eb('quantity', '>', 0) })` reads the rows of a `many` that meet a condition — on the related table, written with Kysely's expression builder and typed from the schema (`RelatedWhere<Schema, '<table>'>` for one kept in a variable). It is part of the relation's own subquery, so the query is still one statement, it applies before `orderBy` and `limit`, inside `with` and under `.as()` (the same relation twice, filtered two ways), and its values are bound parameters. A column is named alone or after its table; another table is read in a subquery (`eb.exists(eb.selectFrom(…))`), which names the related row after its table. Refused when `related()` is called: a `where` on a relation that leads to one row, one that is no function or answers no condition, and a column of another table outside a subquery.
