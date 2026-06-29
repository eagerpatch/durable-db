// Minimal internal replacement for the `debug` package.
//
// The real `debug`'s entry is a runtime-conditional
// `module.exports = require(isBrowser ? './browser.js' : './node.js')`. Rolldown's
// CJS→ESM interop can't statically resolve that conditional export, so the
// prebundle keeps the raw `module.exports`/`require`. When durable-db is consumed
// under Vite 8, these namespaces get pulled into the worker runtime (via the shared
// chunk that `context` imports), and the worker module-runner evaluates that CJS
// with no `module` in scope → "module is not defined" at boot.
//
// These namespaces are dev / CLI / migration tooling only, so a tiny pure-ESM
// logger with the same `createDebug(namespace)` API — gated on the `DEBUG` env the
// same way (comma/space-separated globs, `*` wildcard, `-` negation) — drops the
// dependency entirely while keeping the call sites unchanged.

type Debugger = ((formatter?: unknown, ...args: unknown[]) => void) & {
  namespace: string;
  enabled: boolean;
  extend: (subNamespace: string, delimiter?: string) => Debugger;
};

function readDebugEnv(): string {
  if (typeof process !== 'undefined' && process.env && process.env.DEBUG) {
    return process.env.DEBUG;
  }
  return '';
}

function namespaceEnabled(namespace: string): boolean {
  const spec = readDebugEnv();
  if (!spec) return false;
  let enabled = false;
  for (const raw of spec.split(/[\s,]+/)) {
    if (!raw) continue;
    const negated = raw[0] === '-';
    const pattern = negated ? raw.slice(1) : raw;
    const matches = pattern.endsWith('*')
      ? namespace.startsWith(pattern.slice(0, -1))
      : pattern === namespace;
    if (!matches) continue;
    if (negated) return false;
    enabled = true;
  }
  return enabled;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function format(formatter: unknown, args: unknown[]): string {
  if (typeof formatter !== 'string') {
    return [formatter, ...args].map(stringify).join(' ');
  }
  let index = 0;
  const formatted = formatter.replace(/%([%sdjoO])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    if (index >= args.length) return match;
    const arg = args[index++];
    if (spec === 's') return String(arg);
    if (spec === 'd') return String(Number(arg));
    return stringify(arg);
  });
  const extra = args.slice(index);
  return extra.length ? `${formatted} ${extra.map(stringify).join(' ')}` : formatted;
}

export function createDebug(namespace: string): Debugger {
  const debug = ((formatter?: unknown, ...args: unknown[]) => {
    if (!debug.enabled) return;
    console.error(`${namespace} ${format(formatter, args)}`);
  }) as Debugger;
  debug.namespace = namespace;
  debug.enabled = namespaceEnabled(namespace);
  debug.extend = (subNamespace, delimiter = ':') =>
    createDebug(`${namespace}${delimiter}${subNamespace}`);
  return debug;
}

export const debugVite = createDebug('database:vite');
export const debugCli = createDebug('database:cli');
export const debugMigrations = createDebug('database:migrations');
