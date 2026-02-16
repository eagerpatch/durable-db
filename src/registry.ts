import { type } from 'arktype';
import { AsyncLocalStorage } from 'node:async_hooks';

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
  instanceKey: string;
}

// ============================================================================
// State
// ============================================================================

const actionsByDb = new Map<string, Map<string, ActionDefinition>>();
const als = new AsyncLocalStorage<DoContext>();

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
    throw new Error(`[shoplayer-database] Action not registered: ${dbName}/${actionName}`);
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
    throw new Error(`[shoplayer-database] Invalid args: ${validated.summary}`);
  }

  // Same DB: direct call (no RPC hop)
  if (ctx.dbName === targetDb) {
    return entry.handler(db, validated, ctx);
  }

  // Cross DB: RPC to the other DO
  const bindingName = ctx.dbBindingNames[targetDb];
  if (!bindingName) {
    throw new Error(`[shoplayer-database] Missing binding for db: ${targetDb}`);
  }

  const binding = ctx.env[bindingName] as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { rpc: (method: string, args: unknown, ctx: { instanceKey: string }) => Promise<unknown> };
  };

  const id = binding.idFromName(ctx.instanceKey);
  const stub = binding.get(id);

  return stub.rpc(actionName, validated, { instanceKey: ctx.instanceKey });
}
