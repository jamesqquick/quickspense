import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(fileURLToPath(new URL("../../migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-04-21",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "PAYMENT_DB"],
        bindings: {
          // 0000 is a Drizzle snapshot of the original schema, duplicated by 0001.
          TEST_MIGRATIONS: migrations.filter((migration) => migration.name !== "0000_baseline.sql"),
        },
      },
    }),
  ],
});
