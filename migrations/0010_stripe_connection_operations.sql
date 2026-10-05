-- Migration: Serialize Stripe Connect operations per user

CREATE TABLE stripe_connection_operations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('connect', 'disconnect')),
  connection_id TEXT REFERENCES stripe_connections(id),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'connect' AND connection_id IS NULL AND expires_at IS NOT NULL)
    OR
    (kind = 'disconnect' AND connection_id IS NOT NULL AND expires_at IS NULL)
  )
);

CREATE INDEX idx_stripe_connection_operations_connection
  ON stripe_connection_operations(connection_id);

ALTER TABLE stripe_connect_states
  ADD COLUMN operation_id TEXT REFERENCES stripe_connection_operations(id) ON DELETE SET NULL;

ALTER TABLE stripe_connect_states
  ADD COLUMN completed_at TEXT;

INSERT OR IGNORE INTO stripe_connection_operations (
  id,
  user_id,
  kind,
  connection_id,
  expires_at,
  created_at
)
SELECT
  disconnect_operation_id,
  user_id,
  'disconnect',
  id,
  NULL,
  COALESCE(disconnect_started_at, updated_at)
FROM stripe_connections
WHERE disconnect_operation_id IS NOT NULL
ORDER BY disconnect_started_at DESC;
