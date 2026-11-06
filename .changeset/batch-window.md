---
"durable-db": patch
---

Calls to one Durable Object batch across awaits: the batch is flushed by a timer once the microtasks have run out, not by the next microtask — two procedures of one `Promise.all` reach their action calls a different number of awaits later (an RPC framework's middleware, input validation), and each used to go out alone. A write asks SQLite for its affected rows and insert id in one follow-up statement instead of two.
