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
 * Get the current tenant ID from the configured resolver.
 *
 * @throws Error if no resolver is configured
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
  if (tenantIdResolver) return tenantIdResolver();

  throw new Error('getTenantId() called without a resolver. Call setTenantIdResolver() first.');
}

/**
 * Check if a tenant ID resolver is configured.
 */
export function hasTenantId(): boolean {
  return tenantIdResolver !== null;
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
