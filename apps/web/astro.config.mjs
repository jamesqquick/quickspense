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
    // remoteBindings is explicitly OFF: keep `astro dev` fully local. If we
    // honored `remote: true` flags from wrangler.jsonc, a developer running
    // `astro dev` would silently connect to PRODUCTION D1 / R2 / etc. — bad
    // queries nuke prod data, test sends email real clients, etc. The
    // `send_email` binding is `remote: true` in wrangler.jsonc for the
    // production deploy; under `astro dev` the EMAIL binding is simply
    // undefined and code paths guard for that (see send.ts dev fallback).
    // To exercise the real email path locally, build and run via
    // `wrangler dev` against the built worker output.
    platformProxy: {
      persist: { path: "../../.wrangler-shared/v3" },
      remoteBindings: false,
    },
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
