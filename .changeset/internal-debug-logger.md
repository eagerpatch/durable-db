---
"durable-db": patch
---

Replace the `debug` dependency with a tiny internal logger. `debug`'s entry is a
runtime-conditional `module.exports = require(isBrowser ? './browser' : './node')`,
which Rolldown can't statically interop. Under Vite 8 the `database:vite/cli/migrations`
namespaces get pulled into the worker runtime via `context`, and the worker
module-runner evaluates that CJS with no `module` in scope → crash at boot
("module is not defined"). The internal logger keeps the same `createDebug(namespace)`
API and `DEBUG`-env gating, with zero dependencies.
