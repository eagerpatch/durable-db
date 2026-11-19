---
'durable-db': patch
---

Nothing durable-db does prints what it also throws or what nobody asked for. A schema that does not build (`buildAndLoadSchema()`: `db generate`, `db push`, `db validate`, a dev push) is thrown with esbuild's reason in the message, and esbuild no longer prints its own report of it first (`logLevel: 'silent'`). `durable-db/testing` loads `node:sqlite` without Node 22's "SQLite is an experimental feature" notice, which every test file of an app that opens a test database printed; every other warning goes through. The loader is exported as `loadSqlite()` for a test that opens a database of its own.

A migration that a foreign key fails on a database with rows says both repairs: add the rows the others reference (`INSERT INTO … SELECT DISTINCT …`) or remove the ones that reference nothing — a ledger keeps its booked lines and adds the account they name.
