import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/db/index.ts',
    'src/context/index.ts',
    'src/migrations/index.ts',
    'src/vite/databasePlugin.ts',
    'src/vite/modules/index.ts',
    'src/schema.ts',
    'src/registry.ts',
    'src/transport/index.ts',
    'src/cli/index.ts',
    'src/cli/bin.ts',
  ],
  fixedExtension: false,
  format: 'esm',
  dts: true,
  outDir: 'dist',
  clean: true,
});
