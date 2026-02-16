import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { shoplayerDatabasePlugin } from '@shoplayer/database/vite';

export default defineConfig({
  plugins: [
    shoplayerDatabasePlugin({
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
