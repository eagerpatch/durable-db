---
'durable-db': patch
---

A blob can be written. The plugin that serialises dates walked into every object among a query's values, so an `ArrayBuffer` or a `Uint8Array` bound for a `blob()` column arrived as an empty object and the insert failed. Binary values now pass through untouched and are bound as blobs. A Durable Object answers a blob as an `ArrayBuffer`; `createTestDatabase()` now answers the same (it answered `node:sqlite`'s `Uint8Array`) and takes an `ArrayBuffer` as a parameter like the object does.
