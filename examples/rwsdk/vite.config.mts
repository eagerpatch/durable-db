import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { durableDb } from "durable-db/vite";

export default defineConfig({
  plugins: [
    durableDb({
      databasesDir: "./src/databases",
    }),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
  ],
});
