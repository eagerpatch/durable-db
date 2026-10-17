import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './tests/workers/wrangler.jsonc' } })],
  test: {
    include: ['tests/workers/**/*.test.ts'],
  },
});
