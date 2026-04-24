import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/domain/src/db/schema.ts",
  out: "./migrations",
});
