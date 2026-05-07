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
    //
    // remoteBindings: true (the default) honors `remote: true` in
    // wrangler.jsonc for binding types getPlatformProxy supports (KV, R2,
    // D1, AI, Durable Objects, Hyperdrive, Queues, Service bindings, env
    // vars). Note that `send_email` is NOT in that list, so the EMAIL
    // binding remains undefined under `astro dev`. Server code must guard
    // for that case. To exercise the real email path locally, build the
    // worker and run `wrangler dev` against the built output instead of
    // `astro dev`.
    platformProxy: {
      persist: { path: "../../.wrangler-shared/v3" },
      remoteBindings: true,
    },
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
