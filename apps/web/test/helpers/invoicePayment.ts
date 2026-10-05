import type { InvoiceCheckoutAttempt, InvoiceWithLineItems, StripeConnection } from "@quickspense/domain";

export const payToken = `qsi_${"a".repeat(64)}`;
export const paymentEnv = {
  APP_URL: "https://quickspense.test",
  STRIPE_SECRET_KEY: "sk_test_contract_fixture",
  ENVIRONMENT: "development",
};

export function connectionFixture(overrides: Partial<StripeConnection> = {}): StripeConnection {
  return {
    id: "connection_issuer", user_id: "issuer", stripe_account_id: "acct_issuer", livemode: false,
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
    requirements: null,
    disconnected_at: null, disconnect_operation_id: null, disconnect_started_at: null,
    authorization_revision: "revision_original", stripe_status_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01", updated_at: "2026-01-01", ...overrides,
  };
}

export function invoiceFixture(overrides: Partial<InvoiceWithLineItems> = {}): InvoiceWithLineItems {
  return {
    id: "invoice_issuer", user_id: "issuer", invoice_number: "INV-0001", pay_token: payToken,
    status: "sent", client_name: "Client", client_email: "client@example.com", client_address: null,
    subtotal: 1502, tax_amount: 123, total: 1625, currency: "USD", notes: null,
    due_date: "2026-11-01", issued_at: "2026-10-01", paid_at: null,
    stripe_session_id: null, stripe_payment_intent_id: null, stripe_connection_id: "connection_issuer",
    stripe_account_id: "acct_issuer", stripe_livemode: false, stripe_charge_scope: "connected",
    stripe_checkout_attempt: 0, stripe_void_pending: false, created_at: "2026-10-01", updated_at: "2026-10-01",
    line_items: [{ id: "line_1", invoice_id: "invoice_issuer", description: "Consulting", quantity: 1.5,
      unit_price: 1001, line_total: 1502, position: 0, created_at: "2026-10-01" }], ...overrides,
  };
}

export function attemptFixture(overrides: Partial<InvoiceCheckoutAttempt> = {}): InvoiceCheckoutAttempt {
  return {
    id: "attempt_1", invoice_id: "invoice_issuer", generation: 1,
    stripe_connection_id: "connection_issuer", stripe_account_id: "acct_issuer", livemode: false,
    charge_scope: "connected", amount_total: 1625, currency: "usd", idempotency_key: "invoice_checkout:attempt_1",
    request_json: JSON.stringify({ mode: "payment", metadata: {
      invoice_id: "invoice_issuer", checkout_attempt_id: "attempt_1", pay_token: payToken,
    }, payment_intent_data: { metadata: { invoice_id: "invoice_issuer", checkout_attempt_id: "attempt_1", pay_token: payToken } },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1625, product_data: { name: "Original request" } } }],
    success_url: `https://quickspense.test/pay/${payToken}?status=success`, cancel_url: `https://quickspense.test/pay/${payToken}` }),
    state: "creating", stripe_session_id: null, stripe_payment_intent_id: null,
    creation_claim_id: null, creation_lease_expires_at: null, first_creation_started_at: null, retry_until: null,
    created_at: "2026-10-01", updated_at: "2026-10-01", ...overrides,
  };
}

export function sessionFixture(overrides: Record<string, unknown> = {}) {
  return { id: "cs_test_contract", object: "checkout.session", mode: "payment", livemode: false,
    status: "open", payment_status: "unpaid", amount_total: 1625, currency: "usd", payment_intent: null,
    metadata: { invoice_id: "invoice_issuer", pay_token: payToken, checkout_attempt_id: "attempt_1" },
    url: "https://checkout.stripe.com/c/pay/cs_test_contract", ...overrides };
}
