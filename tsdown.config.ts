import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/db/index.ts',
    'src/context/index.ts',
    'src/migrations/index.ts',
    'src/vite/databasePlugin.ts',
    'src/vite/modules/index.ts',
  ],
  fixedExtension: false,
  format: 'esm',
  dts: true,
  outDir: 'dist',
  clean: true,
});
