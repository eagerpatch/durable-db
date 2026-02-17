import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/db/index.ts',
    'src/context/index.ts',
    'src/migrations/snapshot.ts',
    'src/migrations/generator.ts',
    'src/vite/databasePlugin.ts',
    'src/schema.ts',
    'src/registry.ts',
    'src/transport/protocol.ts',
    'src/transport/websocket.ts',
    'src/cli/index.ts',
    'src/cli/bin.ts',
  ],
  fixedExtension: false,
  format: 'esm',
  dts: true,
  outDir: 'dist',
  clean: true,
});
