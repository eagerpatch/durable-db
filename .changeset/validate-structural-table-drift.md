---
"durable-db": patch
---

fix: `validate` no longer reports false schema drift for tables altered with `ALTER TABLE ... ADD COLUMN`

The drift check compared raw `sqlite_master` CREATE text between the migration-replay database and the from-scratch schema database. SQLite rewrites a table's stored CREATE statement when a column is added via ALTER (the column is spliced in before the closing paren, always last), so any generated column-add migration could never text-match the fresh CREATE — every such migration failed validation and blocked deploys.

Tables are now compared structurally via PRAGMA introspection (`pragma_table_info`, `pragma_index_list`/`pragma_index_info` for UNIQUE constraints, `pragma_foreign_key_list`), which reflects what SQLite actually enforces regardless of how the table was built. Column order is intentionally ignored. Indexes, views, and triggers are still compared textually. Known gap: CHECK constraints, column collations, and WITHOUT ROWID/STRICT options are not exposed by PRAGMAs and are no longer part of the comparison.
