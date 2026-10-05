DROP TRIGGER invoices_preserve_stripe_snapshot_after_draft;

UPDATE invoices SET stripe_charge_scope = 'platform'
WHERE status <> 'draft' AND stripe_charge_scope IS NULL
  AND stripe_connection_id IS NULL AND stripe_account_id IS NULL AND stripe_livemode IS NULL;

CREATE TABLE invoice_legacy_session_evidence (
  invoice_id TEXT PRIMARY KEY NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  stripe_session_id TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  amount_total INTEGER NOT NULL,
  currency TEXT NOT NULL,
  pay_token TEXT NOT NULL,
  confirmed_expired INTEGER NOT NULL CHECK (confirmed_expired IN (0, 1)),
  observed_at TEXT NOT NULL
);

CREATE TRIGGER invoice_legacy_session_evidence_preserve_binding
BEFORE UPDATE ON invoice_legacy_session_evidence
WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.stripe_session_id IS NOT OLD.stripe_session_id
  OR NEW.livemode IS NOT OLD.livemode OR NEW.amount_total IS NOT OLD.amount_total
  OR NEW.currency IS NOT OLD.currency OR NEW.pay_token IS NOT OLD.pay_token
  OR NEW.confirmed_expired < OLD.confirmed_expired
BEGIN
  SELECT RAISE(ABORT, 'legacy session evidence is immutable');
END;

CREATE TRIGGER invoices_preserve_stripe_snapshot_after_draft
BEFORE UPDATE OF stripe_connection_id, stripe_account_id, stripe_livemode, stripe_charge_scope ON invoices
WHEN OLD.status <> 'draft' AND (
  NEW.stripe_connection_id IS NOT OLD.stripe_connection_id
  OR NEW.stripe_account_id IS NOT OLD.stripe_account_id
  OR NEW.stripe_charge_scope IS NOT OLD.stripe_charge_scope
  OR (NEW.stripe_livemode IS NOT OLD.stripe_livemode AND NOT (
    OLD.stripe_charge_scope = 'platform' AND NEW.stripe_charge_scope = 'platform'
    AND OLD.stripe_connection_id IS NULL AND NEW.stripe_connection_id IS NULL
    AND OLD.stripe_account_id IS NULL AND NEW.stripe_account_id IS NULL
    AND OLD.stripe_livemode IS NULL AND NEW.stripe_livemode IN (0, 1)
    AND OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS OLD.stripe_session_id
    AND EXISTS (SELECT 1 FROM invoice_legacy_session_evidence e
      WHERE e.invoice_id = OLD.id AND e.stripe_session_id = OLD.stripe_session_id
        AND e.livemode = NEW.stripe_livemode AND e.amount_total = OLD.total
        AND e.currency = lower(OLD.currency) AND e.pay_token = OLD.pay_token)
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'sent invoice Stripe snapshot is immutable');
END;

CREATE TRIGGER invoices_preserve_legacy_evidence_terms
BEFORE UPDATE OF total, currency, pay_token, stripe_session_id ON invoices
WHEN EXISTS (SELECT 1 FROM invoice_legacy_session_evidence WHERE invoice_id = OLD.id)
  AND (NEW.total IS NOT OLD.total OR NEW.currency IS NOT OLD.currency
    OR NEW.pay_token IS NOT OLD.pay_token OR NEW.stripe_session_id IS NOT OLD.stripe_session_id)
BEGIN
  SELECT RAISE(ABORT, 'classified legacy invoice terms are immutable');
END;
