import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * AsyncLocalStorage instance for tenant ID
 */
const tenantIdStorage = new AsyncLocalStorage<string>();

/**
 * Custom tenant ID resolver for framework integration.
 * When set, getTenantId() falls back to this if no ALS store is found.
 */
let tenantIdResolver: (() => string) | null = null;

/**
 * Configure a custom tenant ID resolver for framework integration.
 *
 * When running inside a framework that already has its own request-scoped context
 * (e.g. RWSDK's `getRequestInfo()`), use this to bridge the two context systems
 * instead of wrapping every request in `runWithTenantId()`.
 *
 * The resolver is called at the moment a database operation needs the tenant ID —
 * by which point request middleware (auth, session, etc.) has already completed.
 *
 * @example
 * ```ts
 * import { setTenantIdResolver } from '@shoplayer/database/context';
 * import { getRequestInfo } from 'rwsdk/worker';
 *
 * setTenantIdResolver(() => getRequestInfo().ctx.session!.shop);
 * ```
 */
export function setTenantIdResolver(resolver: (() => string) | null): void {
  tenantIdResolver = resolver;
}

/**
 * Get the current tenant ID
 *
 * Resolution order:
 * 1. AsyncLocalStorage store (standalone mode via `runWithTenantId()`)
 * 2. Custom resolver (framework integration via `setTenantIdResolver()`)
 * 3. Throws if neither is available
 *
 * @throws Error if no tenant ID is available
 *
 * @example
 * ```ts
 * import { getTenantId } from '@shoplayer/database/context';
 *
 * async function myHandler() {
 *   const tenantId = getTenantId();
 *   // ...
 * }
 * ```
 */
export function getTenantId(): string {
  const store = tenantIdStorage.getStore();
  if (store !== undefined) return store;

  if (tenantIdResolver) return tenantIdResolver();

  throw new Error('getTenantId() called outside of request context. Use runWithTenantId() or setTenantIdResolver().');
}

/**
 * Run a function with the given tenant ID
 *
 * All database actions called within the callback will have access to this tenant ID.
 *
 * @example
 * ```ts
 * import { runWithTenantId } from '@shoplayer/database/context';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return runWithTenantId('my-tenant', async () => {
 *       // Call your actions here
 *       const user = await createUser({ name: 'John', email: 'john@example.com' });
 *       return Response.json(user);
 *     });
 *   },
 * };
 * ```
 */
export function runWithTenantId<T>(
  tenantId: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return tenantIdStorage.run(tenantId, fn);
}

/**
 * Check if we're currently inside a request context with a tenant ID
 */
export function hasTenantId(): boolean {
  return tenantIdStorage.getStore() !== undefined || tenantIdResolver !== null;
}

/**
 * Get the dev epoch for instance key suffixing
 * Only used in development to allow database resets
 *
 * Returns null in production or if no dev state exists
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
  } catch {
    // CLI not available (production build or worker environment)
    return null;
  }
}

/**
 * Get a database instance key, optionally suffixed with dev epoch
 *
 * In development, this appends an epoch suffix to enable database resets.
 * In production, this returns the base key unchanged.
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
