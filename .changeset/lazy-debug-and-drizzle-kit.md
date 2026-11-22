---
"durable-db": patch
---

What only some calls need is no longer made when the module loads.

- **A debugger reads `DEBUG` when it is first asked**: at its first call or read of `enabled`, then kept. The debug module is in the worker's and every Durable Object's bundle, and in workerd the first read of `process` builds Node's whole process object, its streams with it. Three debuggers made at import cost about 7 ms of every isolate's startup, though no request calls them (in a Lagerverk example, an isolate's startup CPU 13.8 → 6 ms).
- **drizzle-kit's API is required at the first snapshot or migration**, not when `durable-db/migrations/snapshot` loads. The CLI's entry imports that module, and a host CLI registers `db` for every command line it runs, so each one loaded drizzle-orm's ~240 modules (about 100 ms) for nothing. Importing `durable-db/cli` takes about 45 ms instead of 150. `tests/cli/startup.test.ts` runs the built entry and fails if it loads drizzle-kit.
