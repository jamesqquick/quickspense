import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  users,
  sessions,
  accounts,
  verifications,
  apikeys,
  expenses,
  stripeConnectionOperations,
  stripeConnections,
  stripeConnectStates,
  invoices,
  invoiceCheckoutAttempts,
  invoiceLegacySessionEvidence,
  stripeWebhookEvents,
} from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { stripePaymentWorkResolved } from "./stripeConnection.js";

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
        users,
        sessions,
        accounts,
        verifications,
        apikeys,
      },
    }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
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
    onAPIError: {
      errorURL: `${env.BETTER_AUTH_URL}/auth/error`,
    },
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

  const stripeDeletionSafe = sql`
    ${stripePaymentWorkResolved(userId)} AND
    NOT EXISTS (
      SELECT 1 FROM ${stripeConnections}
      WHERE ${stripeConnections.user_id} = ${userId}
        AND (
          ${stripeConnections.disconnected_at} IS NULL
          OR ${stripeConnections.disconnect_operation_id} IS NOT NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${stripeConnectionOperations}
      WHERE ${stripeConnectionOperations.user_id} = ${userId}
        AND ${stripeConnectionOperations.kind} = 'connect'
        AND EXISTS (
          SELECT 1 FROM ${stripeConnectStates}
          WHERE ${stripeConnectStates.operation_id} = ${stripeConnectionOperations.id}
            AND ${stripeConnectStates.user_id} = ${userId}
            AND ${stripeConnectStates.consumed_at} IS NOT NULL
            AND ${stripeConnectStates.completed_at} IS NULL
        )
    )
  `;
  const results = await db.batch([
    db.delete(stripeWebhookEvents).where(and(stripeDeletionSafe, sql`(${stripeWebhookEvents.invoice_id} IN (
      SELECT id FROM invoices WHERE user_id = ${userId}) OR (${stripeWebhookEvents.invoice_id} IS NULL
        AND ${stripeWebhookEvents.stripe_account_id} IN (SELECT stripe_account_id FROM stripe_connections WHERE user_id = ${userId})))`)),
    db.delete(invoiceLegacySessionEvidence).where(and(stripeDeletionSafe, sql`${invoiceLegacySessionEvidence.invoice_id} IN (SELECT id FROM invoices WHERE user_id = ${userId})`)),
    db.delete(invoiceCheckoutAttempts).where(and(stripeDeletionSafe, sql`${invoiceCheckoutAttempts.invoice_id} IN (SELECT id FROM invoices WHERE user_id = ${userId})`)),
    db.delete(invoices).where(and(eq(invoices.user_id, userId), stripeDeletionSafe)),
    db
      .delete(apikeys)
      .where(and(eq(apikeys.referenceId, userId), stripeDeletionSafe)),
    db
      .delete(users)
      .where(and(eq(users.id, userId), stripeDeletionSafe))
      .returning({ id: users.id }),
  ]);
  const deletedUsers = results[5];

  if (deletedUsers.length === 0) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (existing) {
      throw new ConflictError(
        "Resolve sent invoices, pending payments, and Stripe connections before deleting your account",
      );
    }
    throw new NotFoundError("User", userId);
  }

  return { fileKeys };
}
