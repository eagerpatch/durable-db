# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@eagerpatch/durable-db` — a zero-configuration database abstraction for Cloudflare Durable Objects with SQLite. Uses Drizzle for schema definition, Kysely for queries, and ArkType for runtime validation. A Vite plugin handles build-time code generation (Durable Object classes, RPC stubs, migration embedding, wrangler config patching).

## Commands

```bash
pnpm build          # Build with tsdown → dist/
pnpm dev            # Build in watch mode
pnpm test           # Run vitest in watch mode
pnpm test:run       # Run tests once
```

Run a single test file:
```bash
npx vitest run tests/db/defineDatabase.test.ts
```

Run the example apps:
```bash
cd examples/simple && pnpm dev
cd examples/rwsdk && pnpm dev
```

## Monorepo Structure

pnpm workspace with `examples/*` as separate packages. The root package is the library itself.

## Architecture

### Module Map

| Export path | Source | Purpose |
|---|---|---|
| `./db` | `src/db/` | `defineDatabase()` API, `SqliteDurableObject` base class, Kysely plugins |
| `./vite` | `src/vite/databasePlugin.ts` | Vite plugin entry (`databasePlugin`) |
| `./vite/modules` | `src/vite/modules/` | Plugin internals: discovery, AST parsing, code generation, wrangler patching |
| `./context` | `src/context/` | AsyncLocalStorage-based tenant ID context (`runWithTenantId`) |
| `./migrations` | `src/migrations/` | Snapshot-based migration generation via drizzle-kit |
| `./registry` | `src/registry.ts` | Action name → handler registry for RPC dispatch |
| `./cli` | `src/cli/` | CLI commands (push, generate, status, reset) and `db` binary |

### Core Flow

1. **User defines** Drizzle schema in `src/databases/schema.ts` and database + actions in `src/databases/*.ts`
2. **Vite plugin** discovers database files, parses them with Babel AST, extracts `defineDatabase()` calls and action exports
3. **Code generation** produces a virtual module (`virtual:eagerpatch/databases/__durableObjects`) containing Durable Object classes with embedded migrations and action methods
4. **Action call transformation**: internal calls → `this.actionName()`, cross-DB calls → RPC via `ctx.env`
5. **RPC stubs** are generated so workers can call actions like regular async functions (context provided via AsyncLocalStorage)
6. **wrangler.jsonc** is auto-patched with Durable Object bindings

### Action System

Actions are defined with `action({ args, handler })`. The `args` object uses ArkType syntax for runtime validation. The `handler` receives `(db: Kysely, args, ctx)`. Actions can call other actions — the Vite plugin detects these at build time via Babel AST traversal and transforms them appropriately.

### Migration System

- Schema snapshots stored in `_snapshot.json` in the migrations directory
- Dev migrations: ephemeral, stored in `node_modules/.cache/@eagerpatch/durable-db/`
- Production migrations: `.sql` files in the configured `migrationsDir`, created via `db generate`
- Dev epoch suffixing allows resetting local databases without conflicts

### Database Instance Strategies

- `per-tenant` (default): separate DO instance per tenant, keyed by tenant ID
- `global`: single shared DO instance

### Kysely Plugins

- **CamelCasePlugin**: auto-converts camelCase ↔ snake_case between JS and SQL
- **DateSerializePlugin**: handles Date serialization/deserialization for SQLite
- **DrizzleSchemaPlugin**: schema-aware column mapping

## Key Conventions

- Database definition files live in `src/databases/`. Files named `schema.ts`, `_*.ts`, and `.d.ts` are excluded from action discovery.
- Actions can be defined inline in the database file or in separate files in the same directory.
- The Vite plugin uses Babel (not regex) for all source code analysis.
- Build output is ESM-only via tsdown.
- Tests mirror source structure under `tests/`.
