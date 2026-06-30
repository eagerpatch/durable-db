---
"durable-db": patch
---

vite: keep Drizzle base classes through Rolldown (Vite 8) production tree-shaking. `drizzle-orm` ships `sideEffects:false`, and Rolldown fails to count a cyclic `class Sub extends Base` as a use of `Base` — so it deletes the apparently-unused base-class module entirely while keeping the `extends` reference, crashing the worker at boot with e.g. `TypedQueryBuilder is not defined`. `databasePlugin()` now tags `drizzle-orm` modules side-effectful (a plugin hook's `moduleSideEffects` outranks the package's `sideEffects` field), forcing Rolldown to retain them. Fixes the bug at the source for any durable-db + Vite 8 consumer.
