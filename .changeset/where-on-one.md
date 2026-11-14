---
'durable-db': minor
---

A `where` on a relation that leads to one row: `related('invoices', 'customer', { columns: ['name'], where: (eb) => eb('vip', '=', true) })` reads the customer only where the condition holds and answers `null` where it does not — in the same statement, like a `many`'s. It was refused, since it makes a relation that is always there (a foreign key that is never null) one that may not be; now the type says so: the row is `{ … } | null` whenever a `where` is given. `orderBy` and `limit` are still a `many`'s. For a library that decides per viewer which rows are seen (Lagerverk's graph), this keeps such a relation in the statement of the row it hangs on instead of a statement of its own.
