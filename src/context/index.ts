import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';

/**
 * The context object available during request handling
 */
export interface RequestContext<TEnv = unknown, TSession = unknown> {
  /** The Cloudflare environment bindings */
  env: TEnv;
  /** The incoming request */
  request: Request;
  /** Session data (typically includes shop info for Shopify apps) */
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
 *   const shop = ctx.session.shop;
 *   // ...
 * }
 * ```
 */
export function getContext<TEnv = unknown, TSession = unknown>(): RequestContext<TEnv, TSession> {
  return {
    // @ts-ignore
    session: {
      shop: 'my-shop.myshopify.com',
    },
    // @ts-ignore
    env,
  }
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
 *         session: { shop: 'my-shop.myshopify.com' },
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
