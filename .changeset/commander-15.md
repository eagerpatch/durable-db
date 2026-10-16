---
'durable-db': patch
---

commander 15: a host CLI on commander 15 can mount `createDbCommand()` without its top-level help
throwing (`sub.helpGroup is not a function` — commander 15's help calls a method commander 13's
Command lacks).
