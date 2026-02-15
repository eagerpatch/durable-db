import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The context object available during request handling
 */
export interface RequestContext<TEnv = unknown, TSession = unknown> {
  /** The Cloudflare environment bindings */
  env: TEnv;
  /** The incoming request */
  request: Request;
  /** Session data (typically includes tenant info) */
  session: TSession;
}

/**
 * AsyncLocalStorage instance for request context
 */
const contextStorage = new AsyncLocalStorage<RequestContext<any, any>>();

/**
 * Get the current request context
 *
 * @throws Error if called outside of a runWithContext() block
 *
 * @example
 * ```ts
 * import { getContext } from '@shoplayer/database/context';
 *
 * async function myHandler() {
 *   const ctx = getContext();
 *   const tenantId = ctx.session.tenantId;
 *   // ...
 * }
 * ```
 */
export function getContext<TEnv = unknown, TSession = unknown>(): RequestContext<TEnv, TSession> {
  const store = contextStorage.getStore();
  if (!store) {
    throw new Error('getContext() called outside of request context. Wrap your handler in runWithContext().');
  }
  return store as RequestContext<TEnv, TSession>;
}

/**
 * Run a function with the given request context
 *
 * All database actions called within the callback will have access to this context.
 *
 * @example
 * ```ts
 * import { runWithContext } from '@shoplayer/database/context';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return runWithContext(
 *       {
 *         env,
 *         request,
 *         session: { tenantId: 'my-tenant' },
 *       },
 *       async () => {
 *         // Call your actions here
 *         const user = await createUser({ name: 'John', email: 'john@example.com' });
 *         return Response.json(user);
 *       }
 *     );
 *   },
 * };
 * ```
 */
export function runWithContext<T, TEnv = unknown, TSession = unknown>(
  context: RequestContext<TEnv, TSession>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return contextStorage.run(context, fn);
}

/**
 * Check if we're currently inside a request context
 */
export function hasContext(): boolean {
  return contextStorage.getStore() !== undefined;
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
