ALTER TABLE invoices ADD COLUMN stripe_void_pending INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_void_pending IN (0, 1));

CREATE TABLE invoice_checkout_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stripe_connection_id TEXT NOT NULL REFERENCES stripe_connections(id) ON DELETE RESTRICT,
  stripe_account_id TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  charge_scope TEXT NOT NULL CHECK (charge_scope = 'connected'),
  amount_total INTEGER NOT NULL CHECK (amount_total > 0),
  currency TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('creating', 'open', 'processing', 'paid', 'failed', 'expired', 'unknown')),
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  creation_claim_id TEXT,
  creation_lease_expires_at TEXT,
  first_creation_started_at TEXT,
  retry_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((creation_claim_id IS NULL AND creation_lease_expires_at IS NULL)
    OR (creation_claim_id IS NOT NULL AND creation_lease_expires_at IS NOT NULL)),
  CHECK ((first_creation_started_at IS NULL AND retry_until IS NULL)
    OR (first_creation_started_at IS NOT NULL AND retry_until IS NOT NULL))
);

CREATE UNIQUE INDEX idx_invoice_checkout_attempts_generation
  ON invoice_checkout_attempts(invoice_id, generation);
CREATE UNIQUE INDEX idx_invoice_checkout_attempts_active
  ON invoice_checkout_attempts(invoice_id)
  WHERE state IN ('creating', 'open', 'processing', 'unknown');
CREATE UNIQUE INDEX idx_invoice_checkout_attempts_session
  ON invoice_checkout_attempts(stripe_account_id, livemode, stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE TRIGGER invoice_checkout_attempts_generation_guard
BEFORE INSERT ON invoice_checkout_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM invoices
  WHERE id = NEW.invoice_id AND stripe_checkout_attempt + 1 = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'checkout generation must advance the invoice counter');
END;

CREATE TRIGGER invoice_checkout_attempts_advance_counter
AFTER INSERT ON invoice_checkout_attempts
BEGIN
  UPDATE invoices SET stripe_checkout_attempt = NEW.generation, updated_at = NEW.created_at
  WHERE id = NEW.invoice_id;
END;

CREATE TRIGGER invoice_checkout_attempts_preserve_request
BEFORE UPDATE ON invoice_checkout_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.invoice_id IS NOT OLD.invoice_id
  OR NEW.generation IS NOT OLD.generation
  OR NEW.stripe_connection_id IS NOT OLD.stripe_connection_id
  OR NEW.stripe_account_id IS NOT OLD.stripe_account_id
  OR NEW.livemode IS NOT OLD.livemode OR NEW.charge_scope IS NOT OLD.charge_scope
  OR NEW.amount_total IS NOT OLD.amount_total OR NEW.currency IS NOT OLD.currency
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_json IS NOT OLD.request_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.first_creation_started_at IS NOT NULL AND (
    NEW.first_creation_started_at IS NOT OLD.first_creation_started_at
    OR NEW.retry_until IS NOT OLD.retry_until
  ))
  OR (OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS NOT OLD.stripe_session_id)
  OR (OLD.stripe_payment_intent_id IS NOT NULL AND NEW.stripe_payment_intent_id IS NOT OLD.stripe_payment_intent_id)
BEGIN
  SELECT RAISE(ABORT, 'checkout request and Stripe identifiers are immutable');
END;

CREATE TRIGGER invoice_checkout_attempts_preserve_terminal_state
BEFORE UPDATE OF state ON invoice_checkout_attempts
WHEN (OLD.state = 'paid' AND NEW.state <> 'paid')
  OR (OLD.state IN ('failed', 'expired') AND NEW.state NOT IN (OLD.state, 'paid'))
  OR (OLD.state = 'processing' AND NEW.state IN ('creating', 'open', 'unknown', 'expired'))
  OR (OLD.state IN ('open', 'unknown') AND NEW.state = 'creating')
BEGIN
  SELECT RAISE(ABORT, 'checkout state cannot regress');
END;

CREATE TRIGGER invoices_preserve_checkout_terms
BEFORE UPDATE OF user_id, pay_token, total, currency ON invoices
WHEN EXISTS (SELECT 1 FROM invoice_checkout_attempts WHERE invoice_id = OLD.id)
  AND (NEW.user_id IS NOT OLD.user_id OR NEW.pay_token IS NOT OLD.pay_token
    OR NEW.total IS NOT OLD.total OR NEW.currency IS NOT OLD.currency)
BEGIN
  SELECT RAISE(ABORT, 'invoice checkout terms are immutable');
END;

ALTER TABLE stripe_webhook_events ADD COLUMN charge_scope TEXT
  CHECK (charge_scope IN ('platform', 'connected'));
ALTER TABLE stripe_webhook_events ADD COLUMN livemode INTEGER CHECK (livemode IN (0, 1));
ALTER TABLE stripe_webhook_events ADD COLUMN invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT;
ALTER TABLE stripe_webhook_events ADD COLUMN checkout_attempt_id TEXT REFERENCES invoice_checkout_attempts(id) ON DELETE RESTRICT;
ALTER TABLE stripe_webhook_events ADD COLUMN stripe_session_id TEXT;
ALTER TABLE stripe_webhook_events ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE stripe_webhook_events ADD COLUMN result TEXT
  CHECK (result IN ('applied', 'ignored', 'duplicate_payment', 'void_payment'));
ALTER TABLE stripe_webhook_events ADD COLUMN receipt_id TEXT;
ALTER TABLE stripe_webhook_events ADD COLUMN amount_total INTEGER;
ALTER TABLE stripe_webhook_events ADD COLUMN currency TEXT;
ALTER TABLE stripe_webhook_events ADD COLUMN payment_status TEXT;
