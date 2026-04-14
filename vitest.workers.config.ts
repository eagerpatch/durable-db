import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    include: ['tests/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './tests/workers/wrangler.jsonc' },
      },
    },
  },
});
