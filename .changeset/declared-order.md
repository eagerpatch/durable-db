---
'durable-db': patch
---

A JSON Schema of `durable-db/type` lists an object's `properties` in the order the keys were declared — `{ status, customerId, first?, after }` stays in that order instead of ArkType's sorted one — so a form or an API built from it (Lagerverk's open GraphQL API prints an operation's args from it) shows them as written. A spread, `merge()` and `and()` keep a key both sides have in its place, like an object spread; `pick()`, `omit()`, `partial()`, `required()` and `onUndeclaredKey()` keep the order. What is checked, the order errors are reported in, the `expression`, `props` and the schema's `required` list stay ArkType's.
