---
'durable-db': minor
---

Migrations are replayed on a database that has rows. `db validate` replayed them on an empty one, which proves the SQL and nothing about data — and a tenant's database migrates on its own, after the deploy: a column made `NOT NULL` where a row holds `NULL`, a foreign key added where a row references nothing, a unique index over rows that repeat, a rebuild that takes rows along all passed validation and failed (or lost data) in production, once per tenant. Now `db generate` and `db validate` replay each migration a second time on a database filled with rows the schema before it allows — every nullable column `NULL` in a row, the same values in two rows where nothing says unique, values no other table has where no foreign key says otherwise — and run it as a Durable Object does: foreign keys on and staying on (`PRAGMA foreign_keys=OFF` does nothing there), each chunk in a transaction, the rows that reference a rebuilt table kept through its `DROP`.

- `db generate` refuses a migration that fails there or takes rows or values along (`MigrationFailsOnRowsError`: the SQLite error, the statement, what to do), writing nothing. `--force` writes it — to be repaired by hand — and does not accept it.
- `db validate` reports the same for every production migration as an error (`ValidateError.rows`, `migrationsValid: false`), for a dev migration as a warning (`rowsWarnings`). `--no-rows` skips it.
- The fix is in the migration: an `UPDATE` or a `DELETE` before the statement that needs the rows to fit. What cannot happen — a migration that already ran everywhere — is accepted with `db validate --accept`, which records it in `_accepted.json` next to the snapshot, by migration and finding.
- Programmatically: `replayWithRows()`, `sift()`, `accept()`, `readAccepted()`, `writeAccepted()` in `durable-db/cli`'s `validate`/`generate`; `validate({ rows, accept })`.

An app whose committed migrations fail on rows gets errors from `db validate` after upgrading: repair what has not shipped, and `db validate --accept` the rest once.
