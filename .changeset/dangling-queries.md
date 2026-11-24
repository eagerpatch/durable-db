---
"durable-db": patch
---

A query, a push to the outbox or a `ctx.transaction()` that runs after its action — or its part — has ended is refused (`… ran after its action ended …`): a write the handler did not await, or the other promise of a `Promise.all()` that gave up when one failed. Run then, it was not in the transaction: in a Durable Object it was committed on its own after the action rolled back, or written into the action after its part rolled back, and a message pushed then was dropped. The test harness refuses the same.
