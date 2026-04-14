import { type } from 'arktype';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocketTransport } from './transport/websocket';

// ============================================================================
// Types
// ============================================================================

export interface ActionDefinition {
  validator: (args: unknown) => unknown;
  handler: (db: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
}

export interface DoContext {
  db: unknown;
  ctx: RpcContext;
  dbName: string;
  instanceKey: string;
}

export interface RpcContext {
  env: Record<string, unknown>;
  dbName: string;
  dbBindingNames: Record<string, string>;
  dbTransports?: Record<string, 'rpc' | 'websocket'>;
  instanceKey: string;
}

// ============================================================================
// State
// ============================================================================

const actionsByDb = new Map<string, Map<string, ActionDefinition>>();
const als = new AsyncLocalStorage<DoContext>();
const wsTransportCache = new Map<string, WebSocketTransport>();

function getOrCreateWsTransport(
  bindingName: string,
  instanceKey: string,
  stub: { fetch: (input: RequestInfo) => Promise<Response> }
): WebSocketTransport {
  const cacheKey = `${bindingName}:${instanceKey}`;
  let transport = wsTransportCache.get(cacheKey);
  if (!transport) {
    transport = new WebSocketTransport(stub);
    wsTransportCache.set(cacheKey, transport);
  }
  return transport;
}

// ============================================================================
// Registration
// ============================================================================

export function registerAction(dbName: string, actionName: string, def: ActionDefinition): void {
  let dbMap = actionsByDb.get(dbName);
  if (!dbMap) {
    dbMap = new Map();
    actionsByDb.set(dbName, dbMap);
  }
  dbMap.set(actionName, def);
}

export function getAction(dbName: string, actionName: string): ActionDefinition | undefined {
  return actionsByDb.get(dbName)?.get(actionName);
}

function getOrThrow(dbName: string, actionName: string): ActionDefinition {
  const entry = getAction(dbName, actionName);
  if (!entry) {
    const dbMap = actionsByDb.get(dbName);
    if (!dbMap) {
      const knownDbs = Array.from(actionsByDb.keys());
      const dbList = knownDbs.length > 0 ? knownDbs.join(', ') : '(none registered)';
      throw new Error(
        `[db] Action not registered: ${dbName}/${actionName} — database '${dbName}' has no registered actions. ` +
        `Known databases: ${dbList}.`
      );
    }
    const knownActions = Array.from(dbMap.keys());
    const actionList = knownActions.length > 0 ? knownActions.join(', ') : '(none)';
    throw new Error(
      `[db] Action not registered: ${dbName}/${actionName}. ` +
      `Actions registered on '${dbName}': ${actionList}.`
    );
  }
  return entry;
}

// ============================================================================
// Durable Object Context (AsyncLocalStorage)
// ============================================================================

export function getDoContext(): DoContext | undefined {
  return als.getStore();
}

export function runWithDoContext<T>(store: DoContext, fn: () => T): T {
  return als.run(store, fn);
}

// ============================================================================
// Action Invocation
// ============================================================================

/**
 * Call an action: validates args, then dispatches (direct call for same DB, RPC for cross-DB).
 */
export async function callAction(
  db: unknown,
  targetDb: string,
  actionName: string,
  args: unknown,
  ctx: RpcContext
): Promise<unknown> {
  const entry = getOrThrow(targetDb, actionName);

  const validated = entry.validator(args);
  if (validated instanceof type.errors) {
    throw new Error(`[db] Invalid args: ${validated.summary}`);
  }

  // Same DB: direct call (no RPC hop)
  if (ctx.dbName === targetDb) {
    return entry.handler(db, validated, ctx);
  }

  // Cross DB: RPC or WebSocket to the other DO
  const bindingName = ctx.dbBindingNames[targetDb];
  if (!bindingName) {
    const known = Object.keys(ctx.dbBindingNames);
    const knownList = known.length > 0 ? known.join(', ') : '(none)';
    throw new Error(
      `[db] Missing binding for db: ${targetDb}. ` +
      `Known database bindings: ${knownList}. ` +
      `This usually means the Vite plugin didn't discover '${targetDb}.ts' in your databases directory.`
    );
  }

  const binding = ctx.env[bindingName] as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { rpc: (method: string, args: unknown, ctx: { instanceKey: string }) => Promise<unknown>; fetch: (input: RequestInfo) => Promise<Response> };
  };

  const id = binding.idFromName(ctx.instanceKey);
  const stub = binding.get(id);

  const transport = ctx.dbTransports?.[targetDb];
  if (transport === 'websocket') {
    const wsTransport = getOrCreateWsTransport(bindingName, ctx.instanceKey, stub);
    return wsTransport.call(actionName, validated, ctx.instanceKey);
  }

  return stub.rpc(actionName, validated, { instanceKey: ctx.instanceKey });
}
