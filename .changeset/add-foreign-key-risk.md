---
'durable-db': patch
---

`db generate` warns about a foreign key added to a table that already exists. The table is rebuilt with the constraint, and on a tenant where a row references something that is not there the copy fails (`FOREIGN KEY constraint failed`) — a database whose migration fails answers no call until a fixed migration ships, and neither `db generate`, `db status` nor `db validate` (which replay on an empty database) said so. The warning names the table, the column and what it references, and what to do: remove or repair those rows in a migration before this one. A foreign key of a new table, and one the table already had, are not warned about.
