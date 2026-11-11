---
'durable-db': patch
---

A JSON-mode column is stored and read as JSON. `text({ mode: 'json' })` and `blob({ mode: 'json' })` were typed as the value (`$type<T>()`) and handled as plain text: an object written to one failed to bind, and a row came back with the stored string. The value is now serialised on the way in — what `values()` and `set()` write to such a column, `JSON.stringify(value)`, a string included (so `'123'` stays a string); a blob column stores the UTF-8 bytes — and parsed on the way out, wherever a query reads the column by name: `select`, an alias, `selectAll`, `returning`, a join, and through `related()`. A raw `sql` query is matched by column name. `null` stays `null`; stored text that is no JSON is answered as it is.

A value that was stringified by hand to get around this is now encoded twice, and reads back as that string: write the value itself. Not covered, as before: what an expression writes or compares — `INSERT … SELECT`, `excluded.meta` in an upsert, a `sql` fragment, a `where` against the column — works on the stored text; so does JSON read through `jsonArrayFrom` or a JSON path. A schema without a JSON-mode column gets no extra plugin.
