---
'durable-db': patch
---

The declarations keep arktype external again. tsdown 0.23 inlined arktype's type graph into the
`.d.ts` along with the bundled runtime, which lost the ambient `type()` DSL typing in consumers
(`'string' is not allowed here`). The build now runs two passes: JavaScript with arktype bundled,
declarations importing from the consumer's `arktype`.
