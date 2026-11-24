import { AsyncLocalStorage } from 'node:async_hooks';

// The transaction an action's code runs in — the action's own, or a part of
// it (`ctx.transaction()`) — while it is open. A query, a push to the outbox
// or a part started from code of an action that has already ended (a write it
// did not await, the other promise of a Promise.all() that gave up at the
// first failure) is refused: in a Durable Object it would run outside the
// transaction, committed on its own after the action rolled back, or into the
// action's transaction after a part of it did; in the test harness the same.
//
// On globalThis: a worker can bundle this package twice (a prebundled copy in
// the generated objects, a source-served one in a framework), and a query of
// one copy's Kysely must see the scope the other copy's runAction opened.

interface Scope {
  open: boolean;
}

const SCOPES = Symbol.for('durable-db.actionScopes');
const scopes: AsyncLocalStorage<Scope> = ((globalThis as Record<symbol, unknown>)[SCOPES] ??=
  new AsyncLocalStorage<Scope>()) as AsyncLocalStorage<Scope>;

/** Runs `fn` as code of a transaction that ends when `fn` settles. */
export async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { open: true };
  try {
    return await scopes.run(scope, fn);
  } finally {
    scope.open = false;
  }
}

/** Throws when the code running now belongs to a transaction that has ended. */
export function assertInScope(what: string): void {
  const scope = scopes.getStore();
  if (scope && !scope.open) {
    throw new Error(
      `[db] ${what} ran after its action ended, so it would not be part of the action's transaction — ` +
        'a promise the action did not await, or one Promise.all() left behind when another failed. ' +
        'Await each query and push (one after the other, or with Promise.allSettled()) before the action returns.',
    );
  }
}
