---
'durable-db': patch
---

A running dev server no longer reloads when another process reads the schemas. The schema loader writes its bundled schema (`_schema_temp_<timestamp>.mjs`) into `node_modules/.cache/durable-db` to import it, and the dev plugin's watcher on that directory took the file for a change of dev state: `db status`, `db validate`, `db generate` — or a host's own check that loads the schemas — beside a running dev server reloaded the whole worker, and a request or a hot update that landed in that moment was answered from half-evaluated modules. The watcher now leaves those files alone; a change of the dev state itself (`db reset`, `db push`) reloads as before.
