import { defineConfig } from 'tsdown';

const entry = [
  'src/index.ts',
  'src/db/index.ts',
  'src/type/index.ts',
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

// arktype stays EXTERNAL — a dependency the consumer's bundler resolves from
// this package, so an app that also imports arktype (Lagerverk's framework
// re-exports `type`) gets ONE instance: arktype initialises its whole scope
// registry at import, and a second, inlined copy cost every worker ~25 ms of
// CPU at each cold start. (It was inlined because @cloudflare/vite-plugin's
// worker-entry export analysis once resolved a bare `arktype` from the app's
// root, which pnpm does not hoist; the Vite plugin and the app's own bundler
// resolve it from this package's directory.)
//
// The declarations keep arktype external too: a copy of its type graph inlined
// into the .d.ts loses the ambient `type()` DSL typing ("'string' is not
// allowed here"), so they import from the consumer's own `arktype`.
export default defineConfig([
  { ...shared, clean: true, dts: false },
  { ...shared, clean: false, dts: { emitDtsOnly: true } },
]);
