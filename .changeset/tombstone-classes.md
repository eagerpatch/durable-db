---
"durable-db": minor
---

Removing a database no longer breaks the worker. While wrangler.jsonc's migrations still declare the class of a database that is gone (an app dropped it, or dropped the extension package that brought it), the generated `virtual:durable-db/__durableObjects` module exports a tombstone of that class: `RemovedDatabaseDurableObject` (new in `durable-db/db`, with `RemovedDatabaseError`), which never touches its storage, answers `fetch` with 410 Gone and rejects the stubs' `rpc`/`sys` calls with an error naming the exact `deleted_classes` migration that deletes it. Before, the dev server failed in workerd with `Class extends value undefined … at createDurableObjectWrapper` (@cloudflare/vite-plugin wraps every class the config names), and a deploy failed for a class with live instances that was neither exported nor deleted.

So dev starts, deploys pass and no data is deleted; re-adding the database brings its data back. A class deleted by a `deleted_classes` migration, or moved away by `renamed_classes` (a mount change), gets no tombstone. durable-db still never writes `deleted_classes`: the hint is printed once as a note, and a removed database's class left in the migrations no longer fails a production build in verify-only mode (a stale binding still does).
