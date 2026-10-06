-- Migration: Stripe Connect account bindings
-- Stores connection metadata, hashed OAuth state, and webhook idempotency keys.

CREATE TABLE stripe_connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  disconnected_at TEXT,
  authorization_revision TEXT NOT NULL,
  stripe_status_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_stripe_connections_account
  ON stripe_connections(stripe_account_id);
CREATE UNIQUE INDEX idx_stripe_connections_active_user
  ON stripe_connections(user_id) WHERE disconnected_at IS NULL;
CREATE INDEX idx_stripe_connections_user
  ON stripe_connections(user_id);

CREATE TABLE stripe_connect_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  livemode INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_stripe_connect_states_user_expires
  ON stripe_connect_states(user_id, expires_at);

CREATE TABLE stripe_webhook_events (
  event_key TEXT PRIMARY KEY NOT NULL,
  stripe_account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_stripe_webhook_events_account
  ON stripe_webhook_events(stripe_account_id);

ALTER TABLE invoices
  ADD COLUMN stripe_connection_id TEXT REFERENCES stripe_connections(id);
ALTER TABLE invoices
  ADD COLUMN stripe_account_id TEXT;
ALTER TABLE invoices
  ADD COLUMN stripe_livemode INTEGER;
ALTER TABLE invoices
  ADD COLUMN stripe_charge_scope TEXT
    CHECK (stripe_charge_scope IN ('platform', 'connected'));
ALTER TABLE invoices
  ADD COLUMN stripe_checkout_attempt INTEGER NOT NULL DEFAULT 0;

UPDATE invoices
SET stripe_charge_scope = 'platform'
WHERE stripe_session_id IS NOT NULL;

CREATE INDEX idx_invoices_stripe_connection
  ON invoices(stripe_connection_id);
