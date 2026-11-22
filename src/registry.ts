import { type } from './arktypeConfig'; // jitless `type` — eval-free for Workers
import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocketTransport } from './transport/websocket';
import { actionArgsType } from './db/actionArgs';
import { ACTION_INFO, type ActionInfo } from './db/describeAction';

// The `type` the action-file transform injects (as `__ddType`) to compile each
// action's `args`, for the RPC stub and the Durable Object's validator alike.
// It is exported from HERE (a durable-db subpath that always resolves in the
// consumer's worker) instead of bare `arktype` — which a pnpm app never hoists
// to its root, and which the cloudflare vite plugin's
// getWorkerEntryExportTypes then fails to resolve. arktype is this package's
// dependency (external in the dist, resolved from here), so this is the SAME
// instance durable-db validates with and the app's own arktype, version
// permitting — no second scope registry. It is arktype's `type` from a
// scope whose optional keys admit `undefined` (see ./db/actionArgs): an
// optional key passed as `undefined` validates, as the inferred TypeScript
// type says it does.
export { actionArgsType as type };

// ============================================================================
// Types
// ============================================================================

export interface ActionDefinition {
  validator: (args: unknown) => unknown;
  handler: (db: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
  /** The compiled args schema (a `type()`), for `describeAction()`; a getter, read only when asked. */
  args?: unknown;
  /** The call site the build compiled this action to: `describeAction()` reads the description from it. */
  stub?: object;
}

export interface DoContext {
  db: unknown;
  ctx: RpcContext;
  dbName: string;
  instanceKey: string;
  /**
   * The tenant the object worked out from `instanceKey` (`tenantOf()`: null
   * for a global database, else the key without exactly the dev epoch the
   * build applied) — what `getTenantId()` answers inside the action, before
   * any resolver (`setTenantIdResolver()`): the resolver is asked only where
   * this is null (a global database's object) or left out. The generated
   * Durable Objects set it; a store without it (one built by hand) is read
   * as its key, `'global'` as no tenant, when no resolver is set.
   */
  tenantId?: string | null;
}

export interface RpcContext {
  env: Record<string, unknown>;
  dbName: string;
  dbBindingNames: Record<string, string>;
  dbTransports?: Record<string, 'rpc' | 'websocket'>;
  instanceKey: string;
  /** The action run's outbox (`runWithOutbox`); an action called from another of the same database shares it. */
  outbox?: import('./db/outbox').Outbox;
}

// ============================================================================
// State
// ============================================================================

const actionsByDb = new Map<string, Map<string, ActionDefinition>>();
const als = new AsyncLocalStorage<DoContext>();
const wsTransportCache = new Map<string, WebSocketTransport>();

// Publish the DO-context store getter on globalThis so getTenantId() (in
// context/index.ts) answers the object's own tenant in an action running in a
// Durable Object, and in what it calls — the store is the generated
// rpc/webSocketMessage's, so the alarm (the outbox sink) has none — before the
// consumer's setTenantIdResolver(), whose module top level runs in every
// object's isolate too but whose resolver reads a request the object does not
// have. Deliberately NOT a module-level wire: bundlers routinely
// produce two copies of this package in one worker (a prebundled
// 'durable-db/registry' inside generated DO stubs, a source-served
// 'durable-db/context' inside a framework) and a module-to-module
// registration only reaches its own copy — globalThis crosses copy boundaries.
(globalThis as Record<symbol, unknown>)[Symbol.for('durable-db.doContext')] = () =>
  als.getStore();

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
  // What the action is, on its call site (see ./db/describeAction): inert
  // unless a library asks, non-enumerable like the untransformed action's meta.
  // `args` is read when asked: the transform compiles the schema at its
  // first use (a getter on `def`), and registering is no use.
  if (def.stub) {
    const info: ActionInfo = {
      database: dbName,
      name: actionName,
      get args() {
        return def.args;
      },
    };
    Object.defineProperty(def.stub, ACTION_INFO, { value: info, enumerable: false, configurable: true });
  }
}

export function getAction(dbName: string, actionName: string): ActionDefinition | undefined {
  return actionsByDb.get(dbName)?.get(actionName) ?? sharedActions().get(actionName);
}

// On globalThis for the same reason as the DO-context getter above: a worker
// may hold two copies of this module, and what one registers the other looks up.
const SHARED_ACTIONS = Symbol.for('durable-db.sharedActions');

function sharedActions(): Map<string, ActionDefinition> {
  const store = globalThis as Record<symbol, unknown>;
  return (store[SHARED_ACTIONS] ??= new Map<string, ActionDefinition>()) as Map<string, ActionDefinition>;
}

/**
 * Registers an action every database has: `stub.rpc(actionName, args)` runs it
 * in whichever Durable Object is called, with that database's `db` and the
 * action context — for a library that works on any schema (a query executor,
 * an exporter). A database's own action of the same name wins; give a shared
 * action a name no export can have (`"graph:run"`).
 *
 * Opt-in: nothing is registered unless a module calls this, and the module
 * has to be loaded in the Durable Object's isolate (the worker's entry is).
 */
export function registerSharedAction(actionName: string, def: ActionDefinition): void {
  sharedActions().set(actionName, def);
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
    throw new Error(
      `[db] Invalid args for ${targetDb}/${actionName}: ${validated.summary}`
    );
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

  // Cloudflare's Durable Object RPC attaches a `Symbol.dispose` to the
  // TOP-LEVEL returned object (explicit-resource-management for the RPC call).
  // React Server Components refuse to serialize symbol-keyed props ("Objects
  // with symbol properties like Symbol.dispose are not supported"), so an action
  // result returned from a "use server" function or passed straight to a client
  // component throws. structuredClone returns a plain clone with all symbol keys
  // dropped — and, unlike a JSON round-trip, preserves Date/Map/Set/etc. The
  // direct-call and WebSocket paths above already yield plain values.
  const result = await stub.rpc(actionName, validated, { instanceKey: ctx.instanceKey });
  return structuredClone(result);
}

// ============================================================================
// Worker → Durable Object calls: one compiled schema, one RPC per object
// ============================================================================

/** What a Durable Object's `rpcBatch` returns for each call, in order. */
export type BatchedResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

interface ActionStub {
  rpc(action: string, args: unknown, options: { instanceKey: string }): Promise<unknown>;
  rpcBatch(calls: Array<{ action: string; args: unknown }>, options: { instanceKey: string }): Promise<BatchedResult[]>;
}

interface ActionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): ActionStub;
}

interface PendingCall {
  action: string;
  args: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const argsSchemas = new Map<string, unknown>();

/**
 * What `make()` answers for `key`, made at the first call in this isolate and
 * kept. (The action transform no longer calls it: each action file keeps its
 * one compiled args schema itself, so an edit in dev compiles the new one.)
 */
export function cachedArgsSchema<T>(key: string, make: () => T): T {
  let schema = argsSchemas.get(key) as T | undefined;
  if (!schema) argsSchemas.set(key, (schema = make()));
  return schema;
}

// Calls waiting for their object's RPC, by namespace and instance key — of ONE
// invocation (a request, a queue batch, a scheduled run: `batchScope()`). A
// timer flushes them, once the microtasks have run out: everything the code
// running now starts before it waits on I/O goes out together. A microtask
// was too early — two procedures started by one `Promise.all` reach their
// action calls a different number of awaits later (oRPC's middleware, input
// validation), so each flushed alone.
//
// Never across invocations. The calls used to wait in one list per object for
// the whole isolate, so two requests that reached the same object in the same
// turn shared a batch: the RPC was sent by the request whose timer fired, and
// the other's call was settled from a request context that was not its own —
// which the Workers runtime refuses ("A promise was resolved or rejected from
// a different request context"), leaving that request hanging until it was
// cancelled. Two concurrent requests of one tenant were enough.
interface BatchScope {
  pending: WeakMap<object, Map<string, PendingCall[]>>;
}

// On globalThis: bundlers routinely produce two copies of this package in one
// worker (see the DO-context getter above), and the code that opens a scope
// and the compiled call sites that read it must meet in one store.
const BATCH_SCOPES = Symbol.for('durable-db.batchScopes');
const batchScopes: AsyncLocalStorage<BatchScope> = ((globalThis as Record<symbol, unknown>)[BATCH_SCOPES] ??= new AsyncLocalStorage<BatchScope>()) as AsyncLocalStorage<BatchScope>;

/**
 * Runs `fn` as one invocation: the action calls it starts on the same Durable
 * Object before it waits on I/O travel in ONE RPC. Wrap what the platform
 * invokes — a worker's `fetch`, `queue` and `scheduled` handlers:
 *
 *   export default { fetch: (request, env, ctx) => batchScope(() => app.fetch(request, env, ctx)) }
 *
 * Outside a scope every call is its own RPC: batching is only safe among the
 * calls of one invocation, and nothing else tells them apart.
 */
export function batchScope<T>(fn: () => T): T {
  return batchScopes.run({ pending: new WeakMap() }, fn);
}

/**
 * Call an action on the Durable Object `instanceKey` of `namespace`. Inside a
 * `batchScope()`, calls to the same object started before the code waits on
 * I/O — `Promise.all([a(), b()])` however deep in middleware, sibling server
 * components awaiting at once — travel in ONE RPC (`rpcBatch`) and run there
 * one after another, in the order they were made, each result or error to its
 * own caller; a lone call, and every call outside a scope, is a plain `rpc`.
 * Results are plain values: the RPC's top-level `Symbol.dispose` is dropped
 * (React Server Components refuse symbol-keyed props).
 */
export function batchedRpc(namespace: ActionNamespace, instanceKey: string, action: string, args: unknown): Promise<unknown> {
  const scope = batchScopes.getStore();
  return new Promise((resolve, reject) => {
    const call: PendingCall = { action, args, resolve, reject };
    // No invocation to share a batch within: this call alone, now.
    if (!scope) {
      sendCalls(namespace, instanceKey, [call]);
      return;
    }
    let byKey = scope.pending.get(namespace);
    if (!byKey) scope.pending.set(namespace, (byKey = new Map()));
    let calls = byKey.get(instanceKey);
    if (!calls) {
      byKey.set(instanceKey, (calls = []));
      const queued = byKey;
      setTimeout(() => flushCalls(namespace, instanceKey, queued), 0);
    }
    calls.push(call);
  });
}

function flushCalls(namespace: ActionNamespace, instanceKey: string, byKey: Map<string, PendingCall[]>): void {
  const calls = byKey.get(instanceKey) ?? [];
  byKey.delete(instanceKey);
  sendCalls(namespace, instanceKey, calls);
}

function sendCalls(namespace: ActionNamespace, instanceKey: string, calls: PendingCall[]): void {
  if (calls.length === 0) return;
  let stub: ActionStub;
  try {
    stub = namespace.get(namespace.idFromName(instanceKey));
  } catch (error) {
    for (const call of calls) call.reject(error);
    return;
  }
  const options = { instanceKey };
  if (calls.length === 1) {
    const [call] = calls as [PendingCall];
    stub.rpc(call.action, call.args, options).then((value) => call.resolve(structuredClone(value)), call.reject);
    return;
  }
  stub.rpcBatch(calls.map(({ action, args }) => ({ action, args })), options).then(
    (results) => {
      calls.forEach((call, index) => {
        const result = results[index];
        if (!result) call.reject(new Error(`[db] ${call.action}: no result in the batch from the Durable Object`));
        else if (result.ok) call.resolve(result.value);
        else call.reject(Object.assign(new Error(result.error.message), { name: result.error.name }));
      });
    },
    (error) => {
      for (const call of calls) call.reject(error);
    },
  );
}
