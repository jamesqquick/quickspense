import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { eq, and, isNotNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  users,
  sessions,
  accounts,
  verifications,
  apikeys,
  expenses,
} from "../db/schema.js";
import { NotFoundError } from "../errors.js";

/**
 * Environment variables needed by the auth factory.
 * Both the web app and the worker must supply these.
 */
export type AuthEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Optional email sender — required for password reset to work. */
  sendEmail?: (to: string, subject: string, html: string) => Promise<void>;
  /** Google OAuth credentials — optional; omit to disable Google login. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        apikey: apikeys,
      },
    }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_SECRET && {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: env.sendEmail
        ? async ({ user, url }) => {
            await env.sendEmail!(
              user.email,
              "Reset your Quickspense password",
              `<p>Hi ${user.name},</p><p>Click the link below to reset your password:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
            );
          }
        : undefined,
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
 * Also cleans up API keys which lack a FK to users.
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

  // Delete orphan-prone apikeys (no FK to users)
  await db.delete(apikeys).where(eq(apikeys.referenceId, userId));

  const result = await db.delete(users).where(eq(users.id, userId));

  if (!result.meta.changes) {
    throw new NotFoundError("User", userId);
  }

  return { fileKeys };
}
