/**
 * Tenant ID resolver for framework integration.
 */
let tenantIdResolver: (() => string) | null = null;

/**
 * Configure a tenant ID resolver.
 *
 * The resolver is called at the moment a database operation needs the tenant ID —
 * by which point request middleware (auth, session, etc.) has already completed.
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

/**
 * Get the current tenant ID from the configured resolver.
 *
 * @throws Error if no resolver is configured
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
/**
 * Inside a Durable Object the instance key IS the tenant (per-tenant DBs key
 * their instances by tenant id, plus an optional `__dev_<epoch>` suffix in
 * dev). The registry publishes its DoContext store getter on globalThis — see
 * the note there for why this is not a module import — so getTenantId() works
 * in action handlers without the worker-side resolver, which the DO execution
 * context never registers.
 */
function tenantIdFromDoContext(): string | null {
  const getStore = (globalThis as Record<symbol, unknown>)[
    Symbol.for('durable-db.doContext')
  ] as (() => { instanceKey?: string } | undefined) | undefined;
  const key = getStore?.()?.instanceKey;
  if (!key || key === 'global') return null;
  const suffixAt = key.lastIndexOf('__dev_');
  return suffixAt === -1 ? key : key.slice(0, suffixAt);
}

export function getTenantId(): string {
  if (tenantIdResolver) return tenantIdResolver();

  const doTenant = tenantIdFromDoContext();
  if (doTenant) return doTenant;

  throw new Error('getTenantId() called without a resolver. Call setTenantIdResolver() first.');
}

/**
 * Check if a tenant ID resolver is configured (or a Durable Object context
 * can supply the tenant).
 */
export function hasTenantId(): boolean {
  return tenantIdResolver !== null || tenantIdFromDoContext() !== null;
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
