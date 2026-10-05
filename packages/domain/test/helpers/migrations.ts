import { applyD1Migrations, env } from "cloudflare:test";

export async function applyPaymentMigrations() {
  await applyD1Migrations(env.PAYMENT_DB, env.TEST_MIGRATIONS);
}

// The older service suites use small schemas; ledger and race tests use the actual migrations above.
export const PAYMENT_GUARD_TABLES_SQL = `
CREATE TABLE invoice_checkout_attempts (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, state TEXT NOT NULL, stripe_session_id TEXT
);
CREATE TABLE stripe_webhook_events (
  event_key TEXT PRIMARY KEY, invoice_id TEXT, stripe_account_id TEXT
);
CREATE TABLE invoice_legacy_session_evidence (
  invoice_id TEXT PRIMARY KEY, stripe_session_id TEXT NOT NULL, livemode INTEGER NOT NULL,
  amount_total INTEGER NOT NULL, currency TEXT NOT NULL, pay_token TEXT NOT NULL,
  confirmed_expired INTEGER NOT NULL, observed_at TEXT NOT NULL
);
`;
