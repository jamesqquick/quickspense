-- Migration: Bind sent invoices to an immutable ready Stripe connection snapshot

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
        AND details_submitted = 1
        AND charges_enabled = 1
        AND payouts_enabled = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'sent invoice requires a ready connected Stripe snapshot');
END;

CREATE TRIGGER invoices_preserve_stripe_snapshot_after_draft
BEFORE UPDATE OF
  stripe_connection_id,
  stripe_account_id,
  stripe_livemode,
  stripe_charge_scope
ON invoices
WHEN OLD.status <> 'draft'
  AND (
    NEW.stripe_connection_id IS NOT OLD.stripe_connection_id
    OR NEW.stripe_account_id IS NOT OLD.stripe_account_id
    OR NEW.stripe_livemode IS NOT OLD.stripe_livemode
    OR NEW.stripe_charge_scope IS NOT OLD.stripe_charge_scope
  )
BEGIN
  SELECT RAISE(ABORT, 'sent invoice Stripe snapshot is immutable');
END;
