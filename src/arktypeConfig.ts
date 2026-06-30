import { scope, type as ambientType } from 'arktype';

// arktype compiles validators with `new Function` (runtime code generation),
// which Cloudflare Workers ALLOW at startup but DISALLOW during request
// handling. So any validator that compiles at request time — e.g. a lazily
// loaded route's action `args` schema — throws "Code generation from strings
// disallowed" and 500s. arktype's `envHasCsp()` auto-probe mis-detects this
// because it runs at startup (where `new Function` still works).
//
// The global `configure({ jitless: true })` fix is fragile in a bundle: it must
// run before arktype's ambient scope initializes, and module-init order in the
// merged worker bundle doesn't reliably guarantee that. Instead we re-export
// `type` from an explicitly jitless scope, so every `type({...})` is eval-free
// BY CONSTRUCTION — independent of init order. Cast to the ambient `type`'s type
// so the developer-facing API is unchanged.
export const type = scope({}, { jitless: true }).type as typeof ambientType;
