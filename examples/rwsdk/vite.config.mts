import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { shoplayerDatabasePlugin } from "@shoplayer/database/vite";

export default defineConfig({
  plugins: [
    shoplayerDatabasePlugin({
      contextImport: "@shoplayer/database/context",
      databasesDir: "./src/databases",
      autoMigrations: false,
    }),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
  ],
});
