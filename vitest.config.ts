import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Workers-pool tests live under tests/workers/ and run in a separate
    // project — the node pool can't import cloudflare:workers.
    exclude: ['tests/workers/**', '**/node_modules/**'],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
});
