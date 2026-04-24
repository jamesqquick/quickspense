import { drizzle, DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export type Database = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema });
}

export { schema };
export type { InferSelectModel, InferInsertModel } from "drizzle-orm";
