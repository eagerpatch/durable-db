import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { durableDb } from 'durable-db/vite';

export default defineConfig({
  plugins: [
    durableDb({
      databasesDir: './src/databases',
    }),
    // Cloudflare's Vite plugin for Workers
    cloudflare({
      viteEnvironment: {
        name: 'worker',
      },
    }),
  ],
});
