# @eagerpatch/durable-db

## 0.0.2

### Patch Changes

- Fix arktype module resolution error in consumer projects by importing `type` from `@eagerpatch/durable-db/db` instead of directly from `arktype` in the generated virtual module.
