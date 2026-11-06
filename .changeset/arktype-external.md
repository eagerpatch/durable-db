---
"durable-db": patch
---

arktype is no longer bundled into the dist: it is imported from the `arktype` dependency, so an app that also uses arktype (Lagerverk's framework re-exports `type`) gets one instance. A second, inlined copy initialised arktype's whole scope registry again at every worker cold start, about 25–30 ms of CPU, and added about 270 kB to the worker. The jitless scope durable-db validates with is unchanged.
