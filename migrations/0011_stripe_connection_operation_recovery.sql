-- Migration: Recover authorized Connect callbacks and lease disconnect attempts

ALTER TABLE stripe_connection_operations
  ADD COLUMN phase TEXT CHECK (phase IN ('authorizing', 'authorized', 'disconnecting'));

ALTER TABLE stripe_connection_operations
  ADD COLUMN stripe_account_id TEXT;

ALTER TABLE stripe_connection_operations
  ADD COLUMN attempt_id TEXT;

ALTER TABLE stripe_connection_operations
  ADD COLUMN attempt_expires_at TEXT;

UPDATE stripe_connection_operations
SET phase = CASE
  WHEN kind = 'disconnect' THEN 'disconnecting'
  ELSE 'authorizing'
END;

CREATE TRIGGER stripe_connection_operations_validate_insert
BEFORE INSERT ON stripe_connection_operations
WHEN NOT COALESCE((
  (
    NEW.kind = 'connect'
    AND NEW.phase IN ('authorizing', 'authorized')
    AND (
      (NEW.phase = 'authorizing' AND NEW.stripe_account_id IS NULL)
      OR
      (NEW.phase = 'authorized' AND NEW.stripe_account_id IS NOT NULL)
    )
    AND NEW.attempt_id IS NULL
    AND NEW.attempt_expires_at IS NULL
  )
  OR
  (
    NEW.kind = 'disconnect'
    AND NEW.phase = 'disconnecting'
    AND NEW.stripe_account_id IS NULL
    AND (
      (NEW.attempt_id IS NULL AND NEW.attempt_expires_at IS NULL)
      OR
      (NEW.attempt_id IS NOT NULL AND NEW.attempt_expires_at IS NOT NULL)
    )
  )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid Stripe connection operation state');
END;

CREATE TRIGGER stripe_connection_operations_validate_update
BEFORE UPDATE OF kind, phase, stripe_account_id, attempt_id, attempt_expires_at
ON stripe_connection_operations
WHEN NOT COALESCE((
  (
    NEW.kind = 'connect'
    AND NEW.phase IN ('authorizing', 'authorized')
    AND (
      (NEW.phase = 'authorizing' AND NEW.stripe_account_id IS NULL)
      OR
      (NEW.phase = 'authorized' AND NEW.stripe_account_id IS NOT NULL)
    )
    AND NEW.attempt_id IS NULL
    AND NEW.attempt_expires_at IS NULL
  )
  OR
  (
    NEW.kind = 'disconnect'
    AND NEW.phase = 'disconnecting'
    AND NEW.stripe_account_id IS NULL
    AND (
      (NEW.attempt_id IS NULL AND NEW.attempt_expires_at IS NULL)
      OR
      (NEW.attempt_id IS NOT NULL AND NEW.attempt_expires_at IS NOT NULL)
    )
  )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid Stripe connection operation state');
END;
