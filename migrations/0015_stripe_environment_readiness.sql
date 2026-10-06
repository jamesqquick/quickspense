ALTER TABLE stripe_connections ADD COLUMN requirements TEXT;

DROP TRIGGER invoices_require_connected_snapshot_on_send;

CREATE TRIGGER invoices_require_connected_snapshot_on_send
BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'draft'
  AND NEW.status = 'sent'
  AND NOT (
    NEW.stripe_connection_id IS NOT NULL
    AND NEW.stripe_account_id IS NOT NULL
    AND NEW.stripe_livemode IS NOT NULL
    AND NEW.stripe_charge_scope = 'connected'
    AND EXISTS (
      SELECT 1
      FROM stripe_connections
      WHERE id = NEW.stripe_connection_id
        AND user_id = NEW.user_id
        AND stripe_account_id = NEW.stripe_account_id
        AND livemode = NEW.stripe_livemode
        AND disconnected_at IS NULL
        AND disconnect_operation_id IS NULL
        AND disconnect_started_at IS NULL
        AND (livemode = 0 OR (
          details_submitted = 1
          AND charges_enabled = 1
          AND payouts_enabled = 1
        ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'sent invoice requires a ready connected Stripe snapshot');
END;
