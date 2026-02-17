import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { databasePlugin } from '@eagerpatch/durable-db/vite';

export default defineConfig({
  plugins: [
    databasePlugin({
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
