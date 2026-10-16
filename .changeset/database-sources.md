---
'durable-db': minor
---

Databases from several directories: `databasesDir` (plugin option, CLI discovery) takes a list of
`{ dir, prefix? }` sources besides a single directory. A source's prefix is prepended to every
database name found there (`invoicing-main` → `InvoicingMainDatabaseDO`, `INVOICING_MAIN_DATABASE_DO`,
`migrations/invoicing-main/`), so a host framework can mount a module's databases next to the app's
own. `createDbCommand(defaults)` / `registerDbCommands(program, defaults)` take the sources the `-d`
flag otherwise names. Directories in a list that do not exist are skipped silently; absolute
directories are accepted.
