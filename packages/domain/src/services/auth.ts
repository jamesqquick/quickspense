import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { eq, and, isNotNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users, expenses } from "../db/schema.js";
import * as schema from "../db/schema.js";
import { NotFoundError } from "../errors.js";

/**
 * Environment variables needed by the auth factory.
 * Both the web app and the worker must supply these.
 */
export type AuthEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
};

/**
 * Per-request Better Auth factory. Instantiated with the D1-backed Drizzle db
 * and env vars — never cached as a module-level singleton.
 */
export function createAuth(db: Database, env: AuthEnv) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
      schema: {
        ...schema,
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        apikey: schema.apikeys,
      },
    }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    user: {
      modelName: "users",
    },
    session: {
      modelName: "sessions",
    },
    account: {
      modelName: "accounts",
    },
    plugins: [
      apiKey({
        defaultPrefix: "qs_",
        defaultKeyLength: 32,
      }),
    ],
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Delete a user and return R2 file keys that need cleanup.
 * This is the only custom auth operation we keep — Better Auth doesn't
 * provide a "delete user + collect associated resources" flow.
 */
export async function deleteUser(
  db: Database,
  userId: string,
): Promise<{ fileKeys: string[] }> {
  const rows = await db
    .select({ file_key: expenses.file_key })
    .from(expenses)
    .where(and(eq(expenses.user_id, userId), isNotNull(expenses.file_key)));
  const fileKeys = rows
    .map((r) => r.file_key)
    .filter((k): k is string => k !== null);

  const result = await db.delete(users).where(eq(users.id, userId));

  if (!result.meta.changes) {
    throw new NotFoundError("User", userId);
  }

  return { fileKeys };
}
