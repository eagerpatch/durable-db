---
"durable-db": patch
---

A migration that rebuilds a table no longer acts on the rows that reference it. SQLite cannot alter most of a table in place, so `db generate` writes a rebuild — `CREATE TABLE __new_t`, copy, `DROP TABLE t`, `ALTER TABLE __new_t RENAME TO t` — with `PRAGMA foreign_keys=OFF` around it. In a Durable Object that pragma does nothing: foreign keys are enforced and stay enforced. So the `DROP` ran every referencing table's `ON DELETE`: `cascade` deleted the rows, `set null` emptied their column, `restrict` and `no action` failed the migration. Changing a column of `customers` could silently delete a tenant's `invoices`.

The runtime now stands in for the pragma. Before a table is dropped that the same chunk puts back with a `RENAME TO`, the rows of the tables that reference it (and of those that reference them) are moved aside, and put back once the rename has run — then checked with `PRAGMA foreign_key_check`, so a rebuild that leaves out rows others still reference fails the migration, which rolls back, instead of leaving orphans. A `DROP TABLE` of a referenced table that nothing replaces runs at the end of its chunk, after the referencing tables were rebuilt without the reference. A table that is dropped and created anew keeps its meaning: its rows go, and what they take with them. A chunk without a `DROP TABLE` runs exactly as before.

Not covered, and unchanged: a rebuild whose `DROP` and `RENAME` are in different chunks (a hand-placed `--> breakpoint` between them), and one that renames the old table away instead of dropping it. Rebuilds woven into each other (`DROP a`, `DROP b`, then the renames) fail with a message that says so. The rows are copied twice, so a rebuild of a table costs in proportion to the rows that reference it.
