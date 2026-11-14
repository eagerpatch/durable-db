---
'durable-db': minor
---

A rename that is one needs no answer. A table that lost exactly one column and gained exactly one declared the same way — type, nullability, default, everything but the name — was renamed, and so was a table that is gone while a new one has its columns: `push` and `generate` now write the `RENAME` without asking, in a terminal or not, and the data is kept (`obviousRenames()`). Before, each such change stopped a push without a terminal (`SchemaRenameRequiredError`) and asked in one, on every push and again on generate — and the wrong answer dropped the column's data. `--no-renames` still says "create and drop"; two candidates, or a column that changed in more than its name, are still a question. `db status` shows the rename as the pending statement, and `db validate` reports it as a rename instead of a possible data loss.
