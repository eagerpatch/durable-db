---
"durable-db": patch
---

getTenantId() now falls back to the Durable Object context when no resolver is configured: inside a DO the instance key IS the tenant (minus the dev `__dev_<epoch>` suffix), so action handlers can read the tenant without the worker-side setTenantIdResolver — which the DO execution context never runs. The registry publishes its DoContext store getter on globalThis so the fallback works even when a bundler produces two copies of the package in one worker.
