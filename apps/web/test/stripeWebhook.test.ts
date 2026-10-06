import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionFixture, invoiceFixture, paymentEnv, payToken, sessionFixture } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({ createDb: vi.fn(() => ({})), processInvoicePaymentEvent: vi.fn(), getInvoiceByPayToken: vi.fn(), getConnectionByAccountId: vi.fn(), processConnectionEvent: vi.fn(), retrieve: vi.fn(), list: vi.fn(), retrieveSession: vi.fn(), recordLegacySessionEvidence: vi.fn() }));
vi.mock("@quickspense/domain", async (original) => ({
  ...await original<typeof import("@quickspense/domain")>(), createDb: mocks.createDb,
  invoicePayments: { processInvoicePaymentEvent: mocks.processInvoicePaymentEvent, recordLegacySessionEvidence: mocks.recordLegacySessionEvidence },
  invoices: { getInvoiceByPayToken: mocks.getInvoiceByPayToken },
  stripeConnections: { getConnectionByAccountId: mocks.getConnectionByAccountId, processConnectionEvent: mocks.processConnectionEvent },
}));
vi.mock("@/lib/stripe", async (original) => ({
  ...await original<typeof import("@/lib/stripe")>(),
  createStripeClient: () => ({ webhooks: Stripe.webhooks, accounts: { retrieve: mocks.retrieve, list: mocks.list }, checkout: { sessions: { retrieve: mocks.retrieveSession } } }),
}));
import { POST as platform } from "@/pages/api/webhooks/stripe";
import { POST as connected } from "@/pages/api/webhooks/stripe-connect";

const env = { ...paymentEnv, DB: {}, STRIPE_WEBHOOK_SECRET: "whsec_platform_fixture", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_fixture" };
let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
function eventFixture(overrides: Record<string, unknown> = {}) {
  return { id: "evt_contract", object: "event", type: "checkout.session.completed", livemode: false,
    account: "acct_issuer", data: { object: sessionFixture({ status: "complete", payment_status: "paid", payment_intent: "pi_contract" }) }, ...overrides };
}
async function send(event = eventFixture(), scope = "connected", secret?: string, invalidSignature = false) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: secret ?? (scope === "connected" ? env.STRIPE_CONNECT_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET) });
  const request = new Request(`https://quickspense.test/api/webhooks/${scope === "connected" ? "stripe-connect" : "stripe"}`, {
    method: "POST", body: payload, headers: { "stripe-signature": invalidSignature ? `${header}tampered` : header },
  });
  return (scope === "connected" ? connected : platform)({ request, locals: { runtime: { env }, logger } } as never);
}
beforeEach(() => {
  vi.resetAllMocks();
  logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  mocks.processInvoicePaymentEvent.mockResolvedValue({ kind: "processed", result: "applied" });
  mocks.getInvoiceByPayToken.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_livemode: false, stripe_account_id: null, stripe_connection_id: null, stripe_session_id: "cs_test_contract" }));
  mocks.getConnectionByAccountId.mockResolvedValue(connectionFixture());
  mocks.retrieve.mockResolvedValue({ object: "account", id: "acct_issuer", charges_enabled: false, payouts_enabled: false, details_submitted: true });
  mocks.list.mockImplementation(() => { throw new Error("Inventory unavailable"); });
  mocks.processConnectionEvent.mockResolvedValue({ kind: "processed", result: "applied" });
  mocks.recordLegacySessionEvidence.mockResolvedValue(true);
});

describe("real HMAC-signed platform and Connect webhook routes", () => {
  it("binds signed top-level account and complete session fields to the atomic domain processor", async () => {
    expect((await send()).status).toBe(200);
    expect(mocks.processInvoicePaymentEvent).toHaveBeenCalledWith({}, {
      eventId: "evt_contract", eventType: "checkout.session.completed", endpointScope: "connected",
      expectedLivemode: false, stripeAccountId: "acct_issuer", livemode: false,
      invoiceId: "invoice_issuer", attemptId: "attempt_1", payToken,
      sessionId: "cs_test_contract", paymentIntentId: "pi_contract", amountTotal: 1625, currency: "usd",
      sessionMode: "payment", sessionStatus: "complete", paymentStatus: "paid",
    });
  });
  it.each(["connected", "platform"])("rejects invalid signatures at the %s endpoint", async (scope) => {
    expect((await send(eventFixture(), scope, undefined, true)).status).toBe(400);
    expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
    expect(mocks.createDb).not.toHaveBeenCalled();
  });
  it.each(["connected", "platform"])("never substitutes the other endpoint's secret for %s", async (scope) => {
    const otherSecret = scope === "connected" ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect((await send(eventFixture(), scope, otherSecret)).status).toBe(400);
    expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
  });
  it.each([
    { livemode: true }, { account: undefined }, { account: null },
    { data: { object: sessionFixture({ livemode: true }) } },
    { data: { object: sessionFixture({ metadata: { pay_token: payToken } }) } },
    { data: { object: sessionFixture({ object: "payment_intent" }) } },
  ])("acks an invalid signed binding without mutations %j", async (patch) => {
    expect((await send(eventFixture(patch))).status).toBe(200);
    expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
  it("refuses connected events at the platform endpoint", async () => {
    expect((await send(eventFixture(), "platform")).status).toBe(200);
    expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
  });
  it.each([
    ["checkout.session.completed", "unpaid", "complete"],
    ["checkout.session.async_payment_succeeded", "paid", "complete"],
    ["checkout.session.async_payment_failed", "unpaid", "complete"],
    ["checkout.session.expired", "unpaid", "expired"],
  ])("delegates %s/%s lifecycle exactly", async (type, payment_status, status) => {
    expect((await send(eventFixture({ type, data: { object: sessionFixture({ status, payment_status, payment_intent: "pi_contract" }) } }))).status).toBe(200);
    expect(mocks.processInvoicePaymentEvent).toHaveBeenCalledWith({}, expect.objectContaining({ eventType: type, paymentStatus: payment_status, sessionStatus: status }));
  });
  it("returns 503 for an early unattached event so Stripe retries without a receipt", async () => {
    mocks.processInvoicePaymentEvent.mockResolvedValue({ kind: "retryable", reason: "session_not_attached" });
    expect((await send()).status).toBe(503);
  });
  it("returns retryable failure for database errors and logs no raw error/token", async () => {
    mocks.processInvoicePaymentEvent.mockRejectedValue(new Error(`DB query leaked ${payToken}`));
    expect((await send()).status).toBe(503);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(payToken);
  });
  it.each(["binding_mismatch", "invalid_event"])("acks rejected %s and logs safely", async (reason) => {
    mocks.processInvoicePaymentEvent.mockResolvedValue({ kind: "rejected", reason });
    expect((await send()).status).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(payToken);
  });
  it.each(["duplicate_payment", "void_payment"])("logs the %s exception without secrets", async (result) => {
    mocks.processInvoicePaymentEvent.mockResolvedValue({ kind: "processed", result });
    expect((await send()).status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ result }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(payToken);
  });
  it("resolves legacy platform metadata by token and leaves session/mode matching to the ledger", async () => {
    const event = eventFixture({ account: undefined, data: { object: sessionFixture({ status: "complete", payment_status: "paid", payment_intent: "pi_contract", metadata: { pay_token: payToken } }) } });
    expect((await send(event, "platform")).status).toBe(200);
    expect(mocks.getInvoiceByPayToken).toHaveBeenCalledWith({}, payToken);
    expect(mocks.processInvoicePaymentEvent).toHaveBeenCalledWith({}, expect.objectContaining({ endpointScope: "platform", stripeAccountId: null, attemptId: null, invoiceId: "invoice_issuer", sessionId: "cs_test_contract" }));
  });
  it.each(["account.updated", "account.application.deauthorized"])("reconciles %s against current signed-account API state, never the application/snapshot ID", async (type) => {
    expect((await send(eventFixture({ type, data: { object: { id: "ca_application_not_account" } } }))).status).toBe(200);
    expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
    expect(mocks.retrieve).toHaveBeenCalledWith("acct_issuer");
    expect(mocks.processConnectionEvent).toHaveBeenCalledWith({}, expect.objectContaining({
      eventId: "evt_contract", eventType: type, stripeAccountId: "acct_issuer", livemode: false,
      expectedAuthorizationRevision: "revision_original", observation: expect.objectContaining({ kind: "authorized", account: expect.objectContaining({ charges_enabled: false }) }),
    }));
  });
  it.each([{ type: "StripePermissionError", statusCode: 403 }, { type: "StripeAuthenticationError", statusCode: 401 }, { type: "StripeConnectionError" }, { code: "account_invalid" }])("retries ambiguous lifecycle failures without mutation or receipt %j", async (error) => {
    mocks.retrieve.mockRejectedValue(error);
    expect((await send(eventFixture({ type: "account.application.deauthorized", data: { object: { id: "ca_app" } } }))).status).toBe(503);
    expect(mocks.processConnectionEvent).not.toHaveBeenCalled();
  });
  it("preserves a same-account reconnect when an old deauthorization event retrieves an authorized account", async () => {
    mocks.getConnectionByAccountId.mockResolvedValue(connectionFixture({ authorization_revision: "reconnected" }));
    expect((await send(eventFixture({ type: "account.application.deauthorized", created: 1 }))).status).toBe(200);
    expect(mocks.processConnectionEvent).toHaveBeenCalledWith({}, expect.objectContaining({ expectedAuthorizationRevision: "reconnected", observation: expect.objectContaining({ kind: "authorized" }) }));
  });
  it("reconciles external revocation only after a successful empty connected-account inventory", async () => {
    mocks.retrieve.mockRejectedValue({ type: "StripeInvalidRequestError", code: "account_invalid" });
    mocks.list.mockImplementation(async function* () {});
    expect((await send(eventFixture({ type: "account.application.deauthorized" }))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ limit: 100 });
    expect(mocks.processConnectionEvent).toHaveBeenCalledWith({}, expect.objectContaining({
      expectedAuthorizationRevision: "revision_original", observation: { kind: "deauthorized" },
    }));
  });
  it("preserves a reconnected account found in inventory after retrieval fails", async () => {
    mocks.retrieve.mockRejectedValue({ type: "StripeInvalidRequestError", code: "account_invalid" });
    mocks.getConnectionByAccountId.mockResolvedValue(connectionFixture({ authorization_revision: "reconnected" }));
    mocks.list.mockImplementation(async function* () {
      yield { object: "account", id: "acct_other" };
      yield { object: "account", id: "acct_issuer", charges_enabled: true, payouts_enabled: true, details_submitted: true };
    });
    expect((await send(eventFixture({ type: "account.application.deauthorized", created: 1 }))).status).toBe(200);
    expect(mocks.processConnectionEvent).toHaveBeenCalledWith({}, expect.objectContaining({
      expectedAuthorizationRevision: "reconnected", observation: expect.objectContaining({ kind: "authorized" }),
    }));
  });
  it("returns 503 without acknowledging an unclassified historical mode", async () => {
    mocks.processInvoicePaymentEvent.mockResolvedValue({ kind: "rejected", reason: "unknown_legacy_mode" });
    expect((await send()).status).toBe(503);
  });
  it("classifies only the stored platform session using a trusted retrieval before processing its signed payment", async () => {
    mocks.getInvoiceByPayToken.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_livemode: null, stripe_account_id: null, stripe_connection_id: null, stripe_session_id: "cs_test_contract" }));
    mocks.retrieveSession.mockResolvedValue(sessionFixture({ metadata: { pay_token: payToken }, status: "complete", payment_status: "paid", payment_intent: "pi_contract" }));
    expect((await send(eventFixture({ account: undefined, data: { object: sessionFixture({ metadata: { pay_token: payToken }, status: "complete", payment_status: "paid", payment_intent: "pi_contract" }) } }), "platform")).status).toBe(200);
    expect(mocks.retrieveSession).toHaveBeenCalledWith("cs_test_contract");
    expect(mocks.recordLegacySessionEvidence).toHaveBeenCalledWith({}, expect.objectContaining({ sessionId: "cs_test_contract", livemode: false, amountTotal: 1625, currency: "usd", payToken }));
  });
  it.each([{ amount_total: 1 }, { currency: "eur" }, { id: "cs_unseen" }, { livemode: true }, { metadata: { pay_token: "wrong" } }])(
    "retries mismatched trusted platform evidence without classifying or acknowledging payment %j", async (patch) => {
      mocks.getInvoiceByPayToken.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_livemode: null,
        stripe_account_id: null, stripe_connection_id: null, stripe_session_id: "cs_test_contract" }));
      mocks.retrieveSession.mockResolvedValue(sessionFixture(patch));
      const response = await send(eventFixture({ account: undefined, data: { object: sessionFixture({ metadata: { pay_token: payToken } }) } }), "platform");
      expect(response.status).toBe(503);
      expect(mocks.recordLegacySessionEvidence).not.toHaveBeenCalled();
      expect(mocks.processInvoicePaymentEvent).not.toHaveBeenCalled();
    },
  );
  it("returns 503 when lifecycle persistence fails so the signed event can be retried", async () => {
    mocks.processConnectionEvent.mockRejectedValue(new Error("private database detail"));
    expect((await send(eventFixture({ type: "account.updated" }))).status).toBe(503);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private database detail");
  });
});
