import { defineConfig } from 'tsdown';

const entry = [
  'src/index.ts',
  'src/db/index.ts',
  'src/context/index.ts',
  'src/migrations/snapshot.ts',
  'src/migrations/generator.ts',
  'src/vite/durableDb.ts',
  'src/schema.ts',
  'src/registry.ts',
  'src/transport/protocol.ts',
  'src/transport/websocket.ts',
  'src/cli/index.ts',
  'src/cli/bin.ts',
  'src/testing/index.ts',
];

const shared = {
  entry,
  fixedExtension: false,
  format: 'esm' as const,
  sourcemap: false,
  outDir: 'dist',
};

// Two passes. The JavaScript bundles arktype IN: durable-db re-exports
// arktype's `type`, and consumers reach it through tooling that evaluates
// this raw dist directly — notably @cloudflare/vite-plugin's
// getWorkerEntryExportTypes, which reads the worker-entry module graph
// WITHOUT going through Vite's optimizeDeps prebundle. With arktype external,
// that path resolves a bare `arktype` from the consuming app's root, which
// pnpm never hoists there ("Cannot find module 'arktype'"). Inlining makes
// the dist self-contained: rolldown emits arktype as ONE shared chunk across
// these entries, so the worker isolate still evaluates a single arktype
// instance (its global scope registry must not be evaluated twice).
//
// The declarations keep arktype EXTERNAL: a copy of its type graph inlined
// into the .d.ts loses the ambient `type()` DSL typing ("'string' is not
// allowed here"), so they import from the consumer's own `arktype`.
export default defineConfig([
  { ...shared, clean: true, dts: false, deps: { alwaysBundle: ['arktype'] } },
  { ...shared, clean: false, dts: { emitDtsOnly: true } },
]);
