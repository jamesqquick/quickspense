-- Migration: Persist in-progress Stripe disconnect operations

ALTER TABLE stripe_connections
  ADD COLUMN disconnect_operation_id TEXT;

ALTER TABLE stripe_connections
  ADD COLUMN disconnect_started_at TEXT;
