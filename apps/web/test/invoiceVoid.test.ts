import { beforeEach, describe, expect, it, vi } from "vitest";
import { attemptFixture, invoiceFixture, paymentEnv, sessionFixture } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), cancel: vi.fn(), list: vi.fn(), finalize: vi.fn(), getInvoice: vi.fn(), expiration: vi.fn(), evidence: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), useRealStripe: false }));
vi.mock("@quickspense/domain", async (original) => ({
  ...await original<typeof import("@quickspense/domain")>(),
  invoicePayments: { beginInvoiceVoid: mocks.begin, cancelUnstartedCheckoutAttempts: mocks.cancel,
    listCheckoutAttempts: mocks.list, finalizeInvoiceVoid: mocks.finalize, recordCheckoutSessionExpiration: mocks.expiration, recordLegacySessionEvidence: mocks.evidence },
  invoices: { getInvoice: mocks.getInvoice },
}));
vi.mock("@/lib/stripe", async (original) => {
  const stripe = await original<typeof import("@/lib/stripe")>();
  return { getGuardedStripeLivemode: (env: Parameters<typeof stripe.createStripeClient>[0]) => mocks.useRealStripe ? stripe.getGuardedStripeLivemode(env) : false,
    createStripeClient: (env: Parameters<typeof stripe.createStripeClient>[0]) => mocks.useRealStripe ? stripe.createStripeClient(env)
      : { checkout: { sessions: { retrieve: mocks.retrieve, expire: mocks.expire } } },
  };
});
import { voidInvoice } from "@/lib/invoiceVoid";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useRealStripe = false;
  mocks.begin.mockResolvedValue(invoiceFixture({ stripe_void_pending: true }));
  mocks.getInvoice.mockResolvedValue(invoiceFixture({ status: "void" }));
  mocks.cancel.mockResolvedValue(0);
  mocks.list.mockResolvedValue([attemptFixture({ state: "open", stripe_session_id: "cs_test_contract" })]);
  mocks.retrieve.mockResolvedValue(sessionFixture());
  mocks.expire.mockResolvedValue(sessionFixture({ status: "expired", url: null }));
  mocks.expiration.mockResolvedValue(attemptFixture({ state: "expired" }));
  mocks.finalize.mockResolvedValue(invoiceFixture({ status: "void" }));
  mocks.evidence.mockResolvedValue(true);
});

describe("safe invoice void orchestration", () => {
  it("persists the marker first, expires the bound session in its recorded account, then finalizes", async () => {
    expect(await voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).toMatchObject({ status: "void" });
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(mocks.retrieve.mock.invocationCallOrder[0]);
    expect(mocks.retrieve).toHaveBeenCalledWith("cs_test_contract", {}, { stripeAccount: "acct_issuer" });
    expect(mocks.expire).toHaveBeenCalledWith("cs_test_contract", {}, { stripeAccount: "acct_issuer" });
    expect(mocks.expiration.mock.invocationCallOrder[0]).toBeLessThan(mocks.finalize.mock.invocationCallOrder[0]);
  });
  it.each(["creating", "unknown", "processing", "paid"])("cannot finalize %s without confirmed resolution", async (state) => {
    mocks.list.mockResolvedValue([attemptFixture({ state: state as never })]);
    await expect(voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });
  it.each([{ amount_total: 1 }, { livemode: true }, { metadata: { pay_token: "wrong" } }, { id: "cs_unseen" }])("rejects mismatched session bindings %j", async (patch) => {
    mocks.retrieve.mockResolvedValue(sessionFixture(patch));
    await expect(voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it.each(["unpaid", "paid"])("refuses a complete %s session and retains the pending marker", async (payment_status) => {
    mocks.retrieve.mockResolvedValue(sessionFixture({ status: "complete", payment_status, payment_intent: "pi_processing" }));
    await expect(voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it("retries Stripe/network expiration failures without finalizing", async () => {
    mocks.expire.mockRejectedValue(new Error("network"));
    await expect(voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it("retries a recovered known session and accepts a confirmed already-expired session", async () => {
    mocks.retrieve.mockResolvedValue(sessionFixture({ status: "expired" }));
    await voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv);
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.expiration).toHaveBeenCalled();
  });
  it("requires platform expiration evidence in platform scope before historical void", async () => {
    mocks.begin.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_connection_id: null, stripe_account_id: null, stripe_livemode: null, stripe_session_id: "cs_test_contract", stripe_void_pending: true }));
    mocks.list.mockResolvedValue([]);
    mocks.retrieve.mockResolvedValue(sessionFixture({ metadata: { pay_token: invoiceFixture().pay_token } }));
    mocks.expire.mockResolvedValue(sessionFixture({ metadata: { pay_token: invoiceFixture().pay_token }, status: "expired" }));
    await voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv);
    expect(mocks.retrieve).toHaveBeenCalledWith("cs_test_contract");
    expect(mocks.expire).toHaveBeenCalledWith("cs_test_contract");
    expect(mocks.evidence).toHaveBeenCalledWith({}, expect.objectContaining({ sessionStatus: "expired", livemode: false }));
  });
  it("keeps sent historical session-less invoices blocked for operator verification", async () => {
    mocks.begin.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_connection_id: null, stripe_account_id: null, stripe_livemode: null, stripe_session_id: null }));
    mocks.list.mockResolvedValue([]);
    await expect(voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it.each(["connected", "platform"])("uses the real Stripe SDK to retrieve and expire in %s scope", async (scope) => {
    mocks.useRealStripe = true;
    if (scope === "platform") {
      mocks.begin.mockResolvedValue(invoiceFixture({ stripe_charge_scope: "platform", stripe_connection_id: null,
        stripe_account_id: null, stripe_livemode: null, stripe_session_id: "cs_test_contract", stripe_void_pending: true }));
      mocks.list.mockResolvedValue([]);
    }
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers) });
      return new Response(JSON.stringify(sessionFixture({
        ...(scope === "platform" ? { metadata: { pay_token: invoiceFixture().pay_token } } : {}),
        ...(String(url).endsWith("/expire") ? { status: "expired", url: null } : {}),
      })), { headers: { "Content-Type": "application/json" } });
    }));
    try {
      await voidInvoice({} as never, "invoice_issuer", "issuer", paymentEnv);
      expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
      expect(requests[0].url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_contract");
      expect(requests[1].url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_contract/expire");
      for (const request of requests) expect(request.headers.get("stripe-account")).toBe(scope === "connected" ? "acct_issuer" : null);
      expect(mocks.finalize).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
