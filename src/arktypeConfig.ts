// durable-db's `type`: ArkType's definitions and types on durable-db/type's
// runtime (./type), which needs no code generation — Workers refuse
// `new Function` during a request, which ArkType's compiled validators used
// at a lazily parsed definition — and builds nothing at import: ArkType's
// own initialises every keyword of its scope when imported, ~40 ms of CPU at
// each cold start of a worker and of every Durable Object.
export { type } from './type';
