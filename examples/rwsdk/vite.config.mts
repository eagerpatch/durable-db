import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { databasePlugin } from "@eagerpatch/durable-db/vite";

export default defineConfig({
  plugins: [
    databasePlugin({
      databasesDir: "./src/databases",
      autoMigrations: false,
    }),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
  ],
});
