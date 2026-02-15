import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { shoplayerDatabasePlugin } from '@shoplayer/database/vite';

export default defineConfig({
  plugins: [
    // Shoplayer database plugin - transforms action definitions
    shoplayerDatabasePlugin({
      // Use the built-in context module
      contextImport: '@shoplayer/database/context',
      // Where to find database definitions
      databasesDir: './src/databases',
      // How to get the tenant ID from context (for per-tenant databases)
      tenantIdPath: 'session.tenantId',

      autoMigrations: false,
    }),
    // Cloudflare's Vite plugin for Workers
    cloudflare({
      viteEnvironment: {
        name: 'worker',
      },
    }),
  ],
});
