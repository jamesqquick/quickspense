import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // Share local D1 / R2 state with the worker's wrangler dev process.
    // Wrangler's --persist-to appends a `v3` subdirectory, so we point the
    // Astro platform proxy at the same v3 path directly.
    platformProxy: {
      persist: { path: "../../.wrangler-shared/v3" },
    },
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
