/**
 * Tenant ID resolver for framework integration.
 */
let tenantIdResolver: (() => string) | null = null;

/**
 * Configure a tenant ID resolver.
 *
 * The resolver is called at the moment a database operation needs the tenant ID —
 * by which point request middleware (auth, session, etc.) has already completed.
 * Inside a per-tenant database's Durable Object it is not asked: the object's
 * own tenant is the answer there (see {@link getTenantId}).
 *
 * @example
 * ```ts
 * import { setTenantIdResolver } from 'durable-db/context';
 * import { getRequestInfo } from 'rwsdk/worker';
 *
 * setTenantIdResolver(() => getRequestInfo().ctx.session!.shop);
 * ```
 */
export function setTenantIdResolver(resolver: (() => string) | null): void {
  tenantIdResolver = resolver;
}

/** The DoContext store of the action running, when code runs inside a Durable Object's action. */
function doContextStore(): { instanceKey?: string; tenantId?: string | null } | undefined {
  const getStore = (globalThis as Record<symbol, unknown>)[
    Symbol.for('durable-db.doContext')
  ] as (() => { instanceKey?: string; tenantId?: string | null } | undefined) | undefined;
  return getStore?.();
}

/**
 * Inside a Durable Object the tenant is the object's own: the generated
 * classes work it out from the instance key with what the build applied —
 * null for a global database (its instance kind, not its key), else the key
 * without exactly its dev epoch suffix (`__dev_<epoch>` in dev, nothing in
 * production, so a tenant id containing `__dev_` is kept whole) — and hand it
 * to the action's DoContext store (`tenantId`). The registry publishes its
 * store getter on globalThis — see the note there for why this is not a
 * module import.
 */
function objectTenant(): string | null {
  const tenantId = doContextStore()?.tenantId;
  return typeof tenantId === 'string' && tenantId !== '' ? tenantId : null;
}

/**
 * A store that does not say its tenant (one built by hand, not by a generated
 * class): its key as it is, the key 'global' as no tenant.
 */
function tenantFromStoreKey(): string | null {
  const store = doContextStore();
  if (!store?.instanceKey || store.tenantId !== undefined) return null;
  return store.instanceKey === 'global' ? null : store.instanceKey;
}

/**
 * The current tenant ID.
 *
 * Inside a per-tenant database's Durable Object — an action, or what it
 * calls — the object's own tenant (its DoContext's `tenantId`) is the answer,
 * before any resolver: it cannot be wrong for code running in that object,
 * and a resolver that reads a request would throw there (the worker module's
 * top level, where a resolver is installed, runs in every object's isolate
 * too). So a resolver cannot answer another tenant for code running inside a
 * per-tenant object. Everywhere else — the worker, a global database's
 * object (no tenant of its own) — the resolver answers; a store built by hand
 * without a `tenantId` is read as its key when no resolver is set.
 *
 * @throws Error if no resolver is configured and no Durable Object supplies the tenant
 *
 * @example
 * ```ts
 * import { getTenantId } from 'durable-db/context';
 *
 * async function myHandler() {
 *   const tenantId = getTenantId();
 *   // ...
 * }
 * ```
 */
export function getTenantId(): string {
  const own = objectTenant();
  if (own) return own;

  if (tenantIdResolver) return tenantIdResolver();

  const fromKey = tenantFromStoreKey();
  if (fromKey) return fromKey;

  throw new Error('getTenantId() called without a resolver. Call setTenantIdResolver() first.');
}

/**
 * Check if a tenant ID resolver is configured (or a Durable Object context
 * can supply the tenant).
 */
export function hasTenantId(): boolean {
  return objectTenant() !== null || tenantIdResolver !== null || tenantFromStoreKey() !== null;
}

/**
 * One-time warning guard: we only log an unexpected dev-epoch load failure
 * once per process so Vite HMR / repeated lookups don't spam stderr.
 */
let loggedDevEpochFailure = false;

/**
 * Get the dev epoch for instance key suffixing
 * Only used in development to allow database resets
 *
 * Returns null in production or if no dev state exists
 *
 * @deprecated The epoch is now baked into generated stubs at build time via
 * the `virtual:durable-db/__devEpoch` module — this function
 * cannot read the dev state inside workerd (no filesystem) and returns null
 * there. Import `devEpoch` / `applyDevEpoch` from the virtual module instead.
 */
export function getDevInstanceKeySuffix(): string | null {
  // Don't use epoch in production
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  // Try to load dev epoch from CLI state
  // This is a lazy import to avoid loading CLI code in production
  try {
    // Note: This uses a dynamic require to work in the Cloudflare Workers environment
    // In Vite dev, this will resolve; in production builds, it returns null
    const { getDevEpoch } = require('../cli/state');
    return getDevEpoch(process.cwd());
  } catch (e) {
    // Expected in worker/production builds where the CLI module isn't bundled.
    // MODULE_NOT_FOUND is silently ignored; anything else is logged once so
    // unexpected breakage (permissions, malformed state file) is visible.
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND' && !loggedDevEpochFailure) {
      loggedDevEpochFailure = true;
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[durable-db] Could not load dev epoch state (continuing without it): ${message}`);
    }
    return null;
  }
}

/**
 * Get a database instance key, optionally suffixed with dev epoch
 *
 * In development, this appends an epoch suffix to enable database resets.
 * In production, this returns the base key unchanged.
 *
 * @deprecated Generated stubs apply the epoch automatically via
 * `applyDevEpoch` from `virtual:durable-db/__devEpoch`. This
 * function only works in Node (it reads the dev state from disk) and is the
 * identity inside workerd — combining it with the generated stubs would
 * also double-suffix keys. Import from the virtual module instead.
 *
 * @param baseKey - The base instance key (e.g., tenant ID or 'global')
 */
export function getInstanceKey(baseKey: string): string {
  const suffix = getDevInstanceKeySuffix();
  if (!suffix) {
    return baseKey;
  }
  return `${baseKey}__dev_${suffix}`;
}
