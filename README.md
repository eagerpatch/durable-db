# Shoplayer Database

A zero-configuration database abstraction for Cloudflare Durable Objects with SQLite.

## Features

- **Define actions with ArkType validation** - Type-safe args validation at runtime
- **Drizzle schema, Kysely queries** - Best of both worlds for schema definition and query building
- **Auto-generated migrations** - Schema is the source of truth, migrations generated automatically
- **Per-shop or global databases** - Automatic instance management
- **Internal DO calls** - Actions can call other actions efficiently within the same DO
- **Cross-DB calls** - Automatically transformed to RPC calls at build time
- **CamelCase support** - Automatic camelCase ↔ snake_case conversion
- **Date serialization** - Seamless Date object handling for SQLite
- **Vite plugin** - Zero configuration, just drop files in `src/databases/`
- **Automatic wrangler config** - DO bindings are auto-generated
- **Fully testable** - Split modules for easy unit testing

## Quick Start

### 1. Install

```bash
pnpm add @shoplayer/database
```

### 2. Configure Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { shoplayerDatabasePlugin } from '@shoplayer/database/vite';

export default defineConfig({
  plugins: [
    shoplayerDatabasePlugin({
      contextImport: '@shoplayer/database/context',
      databasesDir: 'src/databases',
      shopIdPath: 'session.shop',
    }),
  ],
});
```

### 3. Define Your Schema

```typescript
// src/databases/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

### 4. Define Your Database and Actions

```typescript
// src/databases/main.ts
import { defineDatabase } from '@shoplayer/database/db';
import { users } from './schema';

export const { action } = defineDatabase({
  migrationsDir: './migrations',
  schema: { users },
});

export const createUser = action({
  args: {
    name: 'string',
    email: 'string.email',
  },
  handler: async (db, args, ctx) => {
    return db
      .insertInto('users')
      .values({
        id: crypto.randomUUID(),
        name: args.name,
        email: args.email,
        createdAt: new Date(), // Dates are automatically serialized
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
});

export const getUser = action({
  args: { userId: 'string' },
  handler: async (db, args, ctx) => {
    return db
      .selectFrom('users')
      .where('id', '=', args.userId)
      .selectAll()
      .executeTakeFirst();
  },
});

// Actions can call other actions - transformed to this.* in the DO
export const createUserIfNotExists = action({
  args: { name: 'string', email: 'string.email' },
  handler: async (db, args, ctx) => {
    const existing = await getUserByEmail({ email: args.email });
    if (existing) return { created: false, user: existing };
    
    const user = await createUser({ name: args.name, email: args.email });
    return { created: true, user };
  },
});
```

### 5. Use Actions in Your Worker

```typescript
// src/worker.ts
import { runWithContext } from '@shoplayer/database/context';
import { createUser, getUser } from './databases/main';

// Export the generated Durable Object
export { MainDatabaseDO } from 'virtual:shoplayer/databases/__durableObjects';

export default {
  async fetch(request: Request, env: any) {
    return runWithContext(
      {
        env,
        request,
        session: { shop: 'my-shop.myshopify.com' },
      },
      async () => {
        // Just call actions like regular functions!
        const user = await createUser({ 
          name: 'John', 
          email: 'john@example.com' 
        });
        
        return Response.json(user);
      }
    );
  },
};
```

## ArkType Validation

Actions use [ArkType](https://arktype.io/) for runtime validation:

```typescript
action({
  args: {
    name: 'string',           // Required string
    email: 'string.email',    // Email validation
    age: 'number > 0',        // Positive number
    role: "'admin' | 'user'", // Literal union
    bio: 'string?',           // Optional
  },
  handler: async (db, args, ctx) => { ... }
})
```

## Internal Action Calls

Actions can call other actions within the same database. The plugin automatically transforms these calls to use `this.*`:

```typescript
export const getUser = action({
  args: { id: 'string' },
  handler: async (db, args, ctx) => {
    return db.selectFrom('users').where('id', '=', args.id).executeTakeFirst();
  },
});

export const createUserIfNotExists = action({
  args: { name: 'string', email: 'string' },
  handler: async (db, args, ctx) => {
    // This calls getUser - automatically transformed to this.getUser() in the DO
    const existing = await getUser({ id: args.email });
    if (existing) return existing;
    return db.insertInto('users').values(args).execute();
  },
});
```

## Cross-Database Calls

Actions can call actions from other databases - the plugin **automatically transforms these to RPC calls**:

```typescript
// src/databases/main.ts
export const createUserWithAnalytics = action({
  args: { name: 'string', email: 'string' },
  handler: async (db, args, ctx) => {
    const user = await db.insertInto('users').values(args).execute();
    
    // Just call the action! Automatically transformed to RPC
    await logEvent({ type: 'user_created', userId: user.id });
    
    return user;
  },
});

// src/databases/analytics.ts (global database)
export const logEvent = action({
  args: { type: 'string', userId: 'string?' },
  handler: async (db, args, ctx) => {
    return db.insertInto('events').values(args).execute();
  },
});
```

The plugin automatically:
1. Detects cross-database calls at build time
2. Transforms them into proper RPC calls using `ctx.env`
3. Uses the correct instance key based on the target database's strategy:
   - **Per-shop databases**: Uses the same shop ID as the calling database
   - **Global databases**: Uses `'global'` as the instance key

### Manual Cross-Database Calls

If you prefer explicit control, you can still use `ctx.env` directly:

```typescript
export const createUserWithAnalytics = action({
  args: { name: 'string', email: 'string' },
  handler: async (db, args, ctx) => {
    const user = await db.insertInto('users').values(args).execute();
    
    // Explicit RPC call
    const analyticsId = ctx.env.ANALYTICS_DATABASE_DO.idFromName('global');
    const analytics = ctx.env.ANALYTICS_DATABASE_DO.get(analyticsId);
    await analytics.logEvent({ type: 'user_created', userId: user.id });
    
    return user;
  },
});
```

## Multiple Databases

You can have multiple databases with different instance strategies:

```typescript
// src/databases/main.ts - Per-shop (default)
export const { action } = defineDatabase({
  schema: { users },
  migrationsDir: './migrations',
});

// src/databases/analytics.ts - Global (shared)
export const { action } = defineDatabase({
  schema: { events },
  migrationsDir: './migrations/analytics',
  instance: 'global',
});
```

## Migrations

**Your Drizzle schema is the source of truth.** The plugin automatically generates migrations when your schema changes.

### How it works

1. At build time, the plugin loads your Drizzle schema
2. Compares it to the previous snapshot (stored in `migrationsDir/_snapshot.json`)
3. If changes are detected, generates SQL migration statements using `drizzle-kit`
4. Saves the migration SQL file and updates the snapshot
5. Embeds migrations in the generated Durable Object

### Auto-generated migrations

When you modify your schema:

```typescript
// schema.ts - Add a new column
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  bio: text('bio'), // New column!
});
```

The plugin automatically generates:

```sql
-- migrations/20241208143000_auto.sql
ALTER TABLE users ADD COLUMN bio TEXT;
```

### Manual migrations

You can also write migrations manually by creating `.sql` files in your migrations directory:

```sql
-- migrations/001_initial.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users(email);
```

### Migration utilities

The migrations module is also available for programmatic use:

```typescript
import { 
  generateMigration,
  loadMigrationFiles,
  generateSnapshotFromSchema 
} from '@shoplayer/database/migrations';

// Generate a migration from schema changes
const result = await generateMigration({
  migrationsDir: './migrations',
  schema: { users, posts },
});

if (result.hasChanges) {
  console.log('Generated migration:', result.migrationName);
  console.log('SQL statements:', result.statements);
}
```

### Disabling auto-migrations

If you prefer manual control:

```typescript
shoplayerDatabasePlugin({
  autoMigrations: false,
})
```

## Plugins

The library includes Kysely plugins for common operations:

- **CamelCasePlugin** - Converts `camelCase` to `snake_case` for SQL
- **DateSerializePlugin** - Handles Date serialization/deserialization
- **DrizzleSchemaPlugin** - Schema-aware column mapping

## Plugin Options

```typescript
shoplayerDatabasePlugin({
  // Import path for context module
  contextImport: '@shoplayer/database/context',
  
  // Directory containing database definitions
  databasesDir: 'src/databases',
  
  // Path to shop ID in context (for per-shop DBs)
  shopIdPath: 'session.shop',
  
  // Auto-generate migrations from schema changes (default: true)
  autoMigrations: true,
})
```

## Development

```bash
# Install dependencies
pnpm install

# Build the package
pnpm build

# Run tests
pnpm test

# Run example
cd example && pnpm dev
```

## CLI Commands

The database module provides both a standalone CLI and composable functions for integration.

### Standalone CLI

After installing, you can use the `shoplayer-db` command directly:

```bash
# Check database status
npx shoplayer-db status

# Push schema changes to dev migrations
npx shoplayer-db push

# Generate production migration
npx shoplayer-db generate add_user_bio

# Reset dev state (fresh database instances)
npx shoplayer-db reset
```

### Programmatic API

The CLI functions are also available for integration into other tools:

```typescript
import * as db from '@shoplayer/database/cli';

// All functions default to process.cwd() for projectRoot
const results = await db.push();
const status = await db.status();
const generated = await db.generate({}, { name: 'add_bio' });
const resetResult = await db.reset();
```

### Available Commands

#### `db:push` - Push schema changes to dev migrations

During development, this creates ephemeral migrations in `node_modules/.cache/@shoplayer/database/`. These don't pollute your git history while you're iterating on your schema.

```typescript
const results = await db.push({ verbose: true });
for (const r of results) {
  if (r.hasChanges) {
    console.log(`✓ ${r.database}: ${r.statements.length} statements`);
  }
}
```

#### `db:generate` - Generate production migrations

When you're ready to commit your schema changes, this creates a proper migration file in your migrations directory.

```typescript
const results = await db.generate({}, { name: 'add_user_bio' });
```

#### `db:status` - Check migration status

Shows the current state of all databases - pending changes, dev migrations, etc.

```typescript
const status = await db.status();
console.log(db.formatStatus(status));
```

#### `db:reset` - Reset dev state

Bumps the epoch (changing all dev instance keys) and clears dev migrations. Useful when your local DB is in a broken state.

```typescript
const result = await db.reset();
console.log(`New epoch: ${result.newEpoch}`);
```

### Dev Workflow

```
1. Edit your Drizzle schema
2. Vite dev server auto-runs `push` on schema change
3. Dev migrations are stored in node_modules (not committed)
4. Local DO instances use epoch-suffixed keys
5. When ready, run `db:generate` to create prod migration
6. Commit the migration file
```

### Instance Key Suffixing

In development, database instance keys are automatically suffixed with a dev epoch. This allows you to "reset" your local database by bumping the epoch - the next request will use a fresh DO instance.

```typescript
import { getInstanceKey } from '@shoplayer/database/context';

// In production: "my-shop.myshopify.com"
// In development: "my-shop.myshopify.com__dev_abc123"
const key = getInstanceKey('my-shop.myshopify.com');
```

### Integration with shoplayer CLI

The CLI functions are designed to be easily wired up by higher-level CLIs:

```typescript
// In shoplayer CLI
import { program } from 'commander';
import * as db from '@shoplayer/database/cli';

program
  .command('db:push')
  .action(async () => {
    const results = await db.push({ verbose: true });
    // Format and display results
  });

program
  .command('db:generate [name]')
  .action(async (name) => {
    const results = await db.generate({}, { name });
    // Format and display results
  });

program
  .command('db:status')
  .action(async () => {
    const status = await db.status();
    console.log(db.formatStatus(status));
  });

program
  .command('db:reset')
  .option('--keep-epoch', 'Only clear dev migrations')
  .action(async (options) => {
    const result = await db.reset({}, { keepEpoch: options.keepEpoch });
    console.log(`Reset complete. New epoch: ${result.newEpoch ?? 'unchanged'}`);
  });
```

## How It Works

1. **Vite plugin discovers** database files in `src/databases/`
2. **Extracts actions** using Babel AST parsing (no regexes!)
3. **Loads schema** and generates migrations if schema changed
4. **Resolves action calls** - detects when actions call other actions
5. **Generates Durable Object classes** with action methods and embedded migrations
6. **Transforms internal calls** - `getUser()` becomes `this.getUser()`
7. **Transforms cross-DB calls** - `logEvent()` becomes RPC via `ctx.env`
8. **Generates RPC stubs** that use AsyncLocalStorage for context
9. **Patches wrangler.jsonc** with DO bindings automatically

When you call an action from your worker:
1. The RPC stub gets context from AsyncLocalStorage
2. Creates a DO stub using `idFromName(shopId)` (or `'global'`)
3. Calls the action method via Cloudflare's RPC, passing `instanceKey`
4. The DO validates args with ArkType
5. Executes the Kysely query against SQLite
6. For cross-DB calls, the `instanceKey` is used to address the target DO
7. Returns the result
