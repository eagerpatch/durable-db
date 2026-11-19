---
'durable-db': patch
---

An action's queries cost TypeScript about half as much. `DrizzleToKysely` — the database an action's `db` is typed over — is worked out per column from the column alone instead of through drizzle-orm's `Kyselify`, which wrapped every column in `ColumnType<select, insert, update>` taken from the table's whole select and insert models, for Kysely to unwrap again in every query: a column whose three types agree is its plain type (a nullable one stays optional to insert), one with a default is optional to insert, a generated one is neither inserted nor updated. What Kysely selects, inserts and updates is the same — `tests/type/kysely.test.ts` holds it to `Kyselify` for every kind of column. Five queries on a table (select, insert, update, a sorted list, delete): 8 500 instantiations → 4 800.
