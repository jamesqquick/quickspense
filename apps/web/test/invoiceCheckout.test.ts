import { beforeEach, describe, expect, it, vi } from "vitest";
import { attemptFixture, connectionFixture, invoiceFixture, payToken, paymentEnv, sessionFixture } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({
  getInvoiceByPayToken: vi.fn(), getLatestCheckoutAttempt: vi.fn(), reserveCheckoutAttempt: vi.fn(),
  claimCheckoutCreation: vi.fn(), attachCheckoutSession: vi.fn(), recordCheckoutCreationFailure: vi.fn(),
  recordCheckoutSessionExpiration: vi.fn(), getConnectionById: vi.fn(), getActiveConnection: vi.fn(),
  updateAccountStatus: vi.fn(),
}));
vi.mock("@quickspense/domain", async (original) => {
  const domain = await original<typeof import("@quickspense/domain")>();
  return {
  ...domain,
  invoices: { getInvoiceByPayToken: mocks.getInvoiceByPayToken },
  invoicePayments: mocks,
  stripeConnections: { ...domain.stripeConnections, getConnectionById: mocks.getConnectionById, getActiveConnection: mocks.getActiveConnection,
    updateAccountStatus: mocks.updateAccountStatus },
}; });

import { payInvoice } from "@/lib/invoiceCheckout";
const database = {} as never;
let invoice = invoiceFixture();
let attempt = attemptFixture();
let connection = connectionFixture();
let session = sessionFixture();
let requests: Array<{ url: string; headers: Headers; body: string }>;
const pay = (env = paymentEnv) => payInvoice(database, { payToken }, env);

beforeEach(() => {
  vi.resetAllMocks();
  invoice = invoiceFixture(); attempt = attemptFixture(); connection = connectionFixture(); session = sessionFixture(); requests = [];
  mocks.getInvoiceByPayToken.mockImplementation(async () => invoice);
  mocks.getLatestCheckoutAttempt.mockResolvedValue(null);
  mocks.getConnectionById.mockImplementation(async () => connection);
  mocks.updateAccountStatus.mockResolvedValue({ outcome: "applied" });
  mocks.reserveCheckoutAttempt.mockImplementation(async (_db, input) => {
    attempt.request_json = input.buildRequest({ attemptId: attempt.id, generation: 1, invoice });
    return attempt;
  });
  mocks.claimCheckoutCreation.mockImplementation(async () => ({ kind: "claimed", claimId: "claim_1", attempt }));
  mocks.attachCheckoutSession.mockImplementation(async () => ({ ...attempt, state: "open", stripe_session_id: session.id }));
  mocks.recordCheckoutSessionExpiration.mockImplementation(async () => ({ ...attempt, state: "expired" }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: String(init.body ?? "") });
    const response = url.includes("/v1/accounts/")
      ? { id: connection.stripe_account_id, object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }
      : session;
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json", "request-id": "req_fixture" } });
  }));
});

describe("connected Checkout orchestration with the real Stripe SDK", () => {
  it("sends direct-charge account/key headers and persisted fractional line totals plus tax", async () => {
    expect(await pay()).toEqual({ status: "checkout", url: session.url });
    const create = requests.find((r) => r.url.endsWith("/v1/checkout/sessions"))!;
    expect(create.headers.get("stripe-account")).toBe("acct_issuer");
    expect(create.headers.get("idempotency-key")).toBe(attempt.idempotency_key);
    const body = new URLSearchParams(create.body);
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1502");
    expect(body.get("line_items[0][price_data][product_data][description]")).toContain("1.5");
    expect(body.get("line_items[1][price_data][unit_amount]")).toBe("123");
    expect(body.get("metadata[checkout_attempt_id]")).toBe(attempt.id);
    expect(body.get("payment_intent_data[metadata][checkout_attempt_id]")).toBe(attempt.id);
    expect(body.get("success_url")).toBe(`${paymentEnv.APP_URL}/pay/${payToken}?status=success`);
    expect(create.body).not.toMatch(/application_fee_amount|transfer_data|payment_method_types/);
    expect(mocks.reserveCheckoutAttempt).toHaveBeenCalledWith(database, expect.objectContaining({ expectedAuthorizationRevision: connection.authorization_revision }));
    expect(mocks.attachCheckoutSession).toHaveBeenCalledWith(database, expect.objectContaining({ stripeAccountId: "acct_issuer", sessionId: session.id, claimId: "claim_1" }));
  });

  it("creates connected Checkout in EUR with unchanged line totals and tax", async () => {
    invoice = invoiceFixture({ currency: "EUR", subtotal: 12500, tax_amount: 250, total: 12750,
      line_items: [{ ...invoice.line_items[0], quantity: 2, unit_price: 6250, line_total: 12500 }] });
    attempt = attemptFixture({ currency: "eur", amount_total: 12750 });
    session = sessionFixture({ currency: "eur", amount_total: 12750 });

    expect(await pay()).toEqual({ status: "checkout", url: session.url });
    const create = requests.find((request) => request.url.endsWith("/v1/checkout/sessions"))!;
    const body = new URLSearchParams(create.body);
    expect(create.headers.get("stripe-account")).toBe("acct_issuer");
    expect(create.headers.get("idempotency-key")).toBe(attempt.idempotency_key);
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("line_items[0][price_data][currency]")).toBe("eur");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("12500");
    expect(body.get("line_items[1][price_data][currency]")).toBe("eur");
    expect(body.get("line_items[1][price_data][unit_amount]")).toBe("250");
    expect(JSON.parse(attempt.request_json).line_items).toEqual([
      { quantity: 1, price_data: { currency: "eur", unit_amount: 12500,
        product_data: { name: "Consulting", description: "Quantity: 2" } } },
      { quantity: 1, price_data: { currency: "eur", unit_amount: 250, product_data: { name: "Tax" } } },
    ]);
    expect(create.body).not.toMatch(/application_fee_amount|transfer_data|payment_method_types/);
  });

  it.each([
    [99, 123, 100],
    [100, 123, 2],
    [100, 0, 100],
    [101, 0, 1],
  ])("fits %s invoice items plus %s tax into %s Checkout rows with exact totals", async (count, tax, expectedRows) => {
    const originalItems = Array.from({ length: count }, (_, i) => ({ ...invoice.line_items[0],
      id: `line_${i}`, position: i, description: `Service ${i}`, unit_price: 1001 + i,
      line_total: Math.round((1001 + i) * 1.5),
    }));
    const subtotal = originalItems.reduce((sum, item) => sum + item.line_total, 0);
    invoice = invoiceFixture({ line_items: structuredClone(originalItems), subtotal, tax_amount: tax, total: subtotal + tax });
    attempt.amount_total = invoice.total;
    session = sessionFixture({ amount_total: invoice.total });

    expect(await pay()).toEqual({ status: "checkout", url: session.url });
    const persisted = JSON.parse(attempt.request_json);
    expect(persisted.line_items).toHaveLength(expectedRows);
    expect(persisted.line_items.every((item: { quantity: number }) => item.quantity === 1)).toBe(true);
    expect(persisted.line_items.reduce((sum: number, item: { price_data: { unit_amount: number } }) => sum + item.price_data.unit_amount, 0)).toBe(invoice.total);
    const body = new URLSearchParams(requests.find((r) => r.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(body.get(`line_items[${expectedRows}][quantity]`)).toBeNull();
    for (let i = 0; i < expectedRows; i++) {
      expect(body.get(`line_items[${i}][quantity]`)).toBe("1");
      expect(body.get(`line_items[${i}][price_data][unit_amount]`)).toBe(String(persisted.line_items[i].price_data.unit_amount));
    }
    if (expectedRows < count) {
      expect(persisted.line_items[0].price_data.unit_amount).toBe(subtotal);
      expect(persisted.line_items[0].price_data.product_data.name).toBe(`Invoice ${invoice.invoice_number} subtotal`);
    } else {
      for (let i = 0; i < count; i++) {
        expect(persisted.line_items[i].price_data.unit_amount).toBe(originalItems[i].line_total);
        expect(persisted.line_items[i].price_data.product_data.name).toBe(originalItems[i].description);
        expect(persisted.line_items[i].price_data.product_data.description).toBe("Quantity: 1.5");
      }
    }
    if (tax > 0) expect(persisted.line_items.at(-1)).toMatchObject({ quantity: 1,
      price_data: { unit_amount: tax, product_data: { name: "Tax" } } });
    expect(invoice.line_items).toEqual(originalItems);
    expect(mocks.recordCheckoutCreationFailure).not.toHaveBeenCalled();
  });

  it("validates every oversized-invoice line sum before reserving a consolidated request", async () => {
    invoice.line_items = Array.from({ length: 100 }, (_, i) => ({ ...invoice.line_items[0], id: `line_${i}`, position: i }));
    invoice.subtotal = invoice.line_items.reduce((sum, item) => sum + item.line_total, 0);
    invoice.total = invoice.subtotal + invoice.tax_amount;
    invoice.line_items[99].line_total++;
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("isolates two issuers into their own Stripe accounts", async () => {
    await pay();
    invoice = invoiceFixture({ id: "invoice_second", user_id: "second", stripe_account_id: "acct_second", stripe_connection_id: "connection_second" });
    connection = connectionFixture({ id: "connection_second", user_id: "second", stripe_account_id: "acct_second" });
    attempt = attemptFixture({ id: "attempt_second", invoice_id: invoice.id, stripe_account_id: "acct_second", stripe_connection_id: "connection_second", idempotency_key: "invoice_checkout:attempt_second" });
    session = sessionFixture({ metadata: { invoice_id: invoice.id, pay_token: payToken, checkout_attempt_id: attempt.id } });
    await pay();
    expect(requests.filter((r) => r.url.endsWith("/v1/checkout/sessions")).map((r) => r.headers.get("stripe-account"))).toEqual(["acct_issuer", "acct_second"]);
  });

  it.each(["subtotal", "tax_amount", "total"] as const)("rejects unsafe/mismatched %s before reserving", async (field) => {
    invoice[field] = Number.MAX_SAFE_INTEGER + 1;
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it("rejects a persisted line sum that differs from the invoice total", async () => {
    invoice.line_items[0].line_total = 1501;
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it.each(["https://user:password@example.com", "https://example.com?other=1", "javascript:alert(1)", "https://example.com/subpath"])("rejects unsafe APP_URL %s", async (APP_URL) => {
    await expect(pay({ ...paymentEnv, APP_URL })).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it.each([{ stripe_livemode: true }, { stripe_charge_scope: "platform" }, { stripe_account_id: null }, { issued_at: null }])("rejects invalid send snapshots %j", async (patch) => {
    Object.assign(invoice, patch);
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(requests).toHaveLength(0);
  });
  it("rejects an account owned by a different user", async () => {
    connection.user_id = "another_user";
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(requests).toHaveLength(0);
  });
  it("refuses a stale account observation after concurrent reconnect", async () => {
    mocks.updateAccountStatus.mockResolvedValue({ outcome: "ignored", reason: "authorization_revision_mismatch" });
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it("allows sandbox Checkout after refreshing disabled Stripe capability flags", async () => {
    connection = connectionFixture({ charges_enabled: false, payouts_enabled: false, details_submitted: false });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(String(url).includes("/v1/accounts/")
        ? { id: "acct_issuer", object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: false }
        : session));
    });
    expect(await pay()).toEqual({ status: "checkout", url: session.url });
    expect(mocks.updateAccountStatus).toHaveBeenCalledWith(database, expect.objectContaining({ charges_enabled: false }));
    expect(mocks.claimCheckoutCreation).toHaveBeenCalled();
  });

  it("refreshes live readiness rather than trusting cached flags", async () => {
    connection.livemode = true;
    invoice.stripe_livemode = true;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "acct_issuer", object: "account", charges_enabled: false, payouts_enabled: true, details_submitted: true })));
    await expect(payInvoice(database, { payToken }, { ...paymentEnv, STRIPE_SECRET_KEY: "sk_live_contract_fixture",
      ENVIRONMENT: "production", STRIPE_ALLOW_LIVE_KEY: "1" })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.updateAccountStatus).toHaveBeenCalledWith(database, expect.objectContaining({ charges_enabled: false, expectedAuthorizationRevision: "revision_original" }));
    expect(mocks.claimCheckoutCreation).not.toHaveBeenCalled();
  });
  it("only the leased request calls create while a concurrent request is busy", async () => {
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    mocks.claimCheckoutCreation.mockResolvedValueOnce({ kind: "claimed", claimId: "claim_1", attempt }).mockResolvedValueOnce({ kind: "busy", attempt });
    const results = await Promise.all([pay(), pay()]);
    expect(results.map((r) => r.status).sort()).toEqual(["checkout", "processing"]);
    expect(requests.filter((r) => r.url.endsWith("/v1/checkout/sessions"))).toHaveLength(1);
  });
  it("retries unknown creation with its original account/key/request despite APP_URL changes", async () => {
    attempt.state = "unknown";
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    await pay({ ...paymentEnv, APP_URL: "https://changed.test" });
    const body = new URLSearchParams(requests.find((r) => r.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(body.get("line_items[0][price_data][product_data][name]")).toBe("Original request");
    expect(body.get("success_url")).toContain("https://quickspense.test/");
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it("recovers a lost create response through the real SDK using the identical request and idempotency key", async () => {
    mocks.getLatestCheckoutAttempt.mockResolvedValueOnce(null).mockImplementation(async () => attempt);
    mocks.recordCheckoutCreationFailure.mockImplementation(async (_db, input) => {
      expect(input.outcome).toBe("unknown");
      attempt.state = "unknown";
      return attempt;
    });
    let creates = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (String(url).includes("accounts")) {
        return new Response(JSON.stringify({ id: "acct_issuer", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }));
      }
      if (++creates === 1) throw new TypeError("Socket closed after Stripe accepted the request");
      return new Response(JSON.stringify(session));
    });
    await expect(pay()).rejects.toMatchObject({ statusCode: 503 });
    expect(await pay({ ...paymentEnv, APP_URL: "https://changed.test" })).toEqual({ status: "checkout", url: session.url });
    const createRequests = requests.filter((r) => r.url.endsWith("/v1/checkout/sessions"));
    expect(createRequests).toHaveLength(2);
    expect(createRequests[1].body).toBe(createRequests[0].body);
    for (const request of createRequests) {
      expect(request.headers.get("idempotency-key")).toBe(attempt.idempotency_key);
      expect(request.headers.get("stripe-account")).toBe(attempt.stripe_account_id);
    }
    expect(mocks.reserveCheckoutAttempt).toHaveBeenCalledOnce();
  });
  it("keeps the original generation after a lost response, retry 400, and subsequent pay", async () => {
    mocks.getLatestCheckoutAttempt.mockResolvedValueOnce(null).mockImplementation(async () => attempt);
    mocks.reserveCheckoutAttempt.mockImplementation(async (_db, input) => {
      const generation = invoice.stripe_checkout_attempt + 1;
      attempt = attemptFixture({ id: `attempt_${generation}`, generation, idempotency_key: `invoice_checkout:attempt_${generation}` });
      attempt.request_json = input.buildRequest({ attemptId: attempt.id, generation, invoice });
      invoice.stripe_checkout_attempt = generation;
      return attempt;
    });
    mocks.recordCheckoutCreationFailure.mockImplementation(async (_db, input) => {
      attempt.state = input.outcome === "not_created" ? "failed" : "unknown";
      return attempt;
    });
    mocks.attachCheckoutSession.mockImplementation(async (_db, input) => {
      attempt = { ...attempt, state: "open", stripe_session_id: input.sessionId };
      return attempt;
    });
    const acceptedOperations = new Map<string, ReturnType<typeof sessionFixture>>();
    let creates = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      requests.push({ url: String(url), headers, body });
      if (String(url).includes("accounts")) {
        return new Response(JSON.stringify({ id: "acct_issuer", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }));
      }
      if (++creates === 2) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "parameter_invalid_integer", message: "Fixture validation error" } }), {
          status: 400, headers: { "stripe-should-retry": "false" },
        });
      }
      const operationKey = `${headers.get("stripe-account")}:${headers.get("idempotency-key")}`;
      let accepted = acceptedOperations.get(operationKey);
      if (!accepted) {
        const params = new URLSearchParams(body);
        const id = `cs_test_operation_${acceptedOperations.size + 1}`;
        accepted = sessionFixture({ id, url: `https://checkout.stripe.com/c/pay/${id}`, metadata: {
          invoice_id: params.get("metadata[invoice_id]"), pay_token: params.get("metadata[pay_token]"),
          checkout_attempt_id: params.get("metadata[checkout_attempt_id]"),
        } });
        acceptedOperations.set(operationKey, accepted);
      }
      if (creates === 1) throw new TypeError("Socket closed after Stripe created the session");
      return new Response(JSON.stringify(accepted));
    });

    await expect(pay()).rejects.toMatchObject({ statusCode: 503 });
    const original = { ...attempt };
    await expect(pay({ ...paymentEnv, APP_URL: "https://changed.test" })).rejects.toMatchObject({ statusCode: 503 });
    const stateAfterRetry = attempt.state;
    const result = await pay({ ...paymentEnv, APP_URL: "https://changed.test" });

    expect(stateAfterRetry).toBe("unknown");
    expect(result).toEqual({ status: "checkout", url: "https://checkout.stripe.com/c/pay/cs_test_operation_1" });
    expect(attempt).toMatchObject({ id: original.id, generation: original.generation, stripe_account_id: original.stripe_account_id,
      request_json: original.request_json, idempotency_key: original.idempotency_key, stripe_session_id: "cs_test_operation_1" });
    expect(invoice.stripe_checkout_attempt).toBe(1);
    expect(mocks.reserveCheckoutAttempt).toHaveBeenCalledOnce();
    expect(acceptedOperations.size).toBe(1);
    const createRequests = requests.filter((r) => r.url.endsWith("/v1/checkout/sessions"));
    expect(createRequests).toHaveLength(3);
    for (const request of createRequests) {
      expect(request.body).toBe(createRequests[0].body);
      expect(request.headers.get("stripe-account")).toBe(original.stripe_account_id);
      expect(request.headers.get("idempotency-key")).toBe(original.idempotency_key);
    }
    expect(mocks.recordCheckoutCreationFailure.mock.calls.map(([, input]) => input.outcome)).toEqual(["unknown", "unknown"]);
  });
  it("never creates another generation once unknown creation exceeds retention", async () => {
    attempt.state = "unknown";
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    mocks.claimCheckoutCreation.mockResolvedValue({ kind: "retry_window_elapsed", attempt });
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.url.includes("checkout"))).toHaveLength(0);
  });
  it.each([
    { livemode: true }, { mode: "subscription" }, { amount_total: 1 }, { currency: "eur" },
    { metadata: { invoice_id: "wrong" } }, { status: "unexpected" }, { payment_status: "paid" },
    { id: "not_a_session" }, { url: "javascript:alert(1)" },
  ])("records unknown and never attaches an invalid Stripe response %j", async (patch) => {
    session = sessionFixture(patch);
    await expect(pay()).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.attachCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.recordCheckoutCreationFailure).toHaveBeenCalledWith(database, expect.objectContaining({ outcome: "unknown" }));
  });
  it.each([new Error("database attach lost"), null])("keeps creation unknown after attach failure/stale claim %s", async (failure) => {
    if (failure) mocks.attachCheckoutSession.mockRejectedValue(failure);
    else mocks.attachCheckoutSession.mockResolvedValue(null);
    await expect(pay()).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.recordCheckoutCreationFailure).toHaveBeenCalledWith(database, expect.objectContaining({ outcome: "unknown" }));
  });
  it.each([
    [400, "invalid_request_error", "parameter_invalid_integer"],
    [409, "invalid_request_error", "idempotency_key_in_use"],
    [429, "rate_limit_error", "rate_limit"],
    [500, "api_error", "server_error"],
  ])("keeps Stripe HTTP %s/%s create failures unknown", async (status, type, code) => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).includes("accounts")
      ? new Response(JSON.stringify({ id: "acct_issuer", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }))
      : new Response(JSON.stringify({ error: { type, code, message: "Fixture failure" } }), { status, headers: { "stripe-should-retry": "false" } }));
    await expect(pay()).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.recordCheckoutCreationFailure).toHaveBeenCalledWith(database, expect.objectContaining({ outcome: "unknown" }));
  });
  it("retrieves prior complete sessions after revocation but awaits signed webhooks without receipts", async () => {
    attempt.state = "open"; attempt.stripe_session_id = session.id;
    connection.disconnected_at = "2026-10-02";
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    session = sessionFixture({ status: "complete", payment_status: "paid", payment_intent: "pi_contract", url: null });
    expect(await pay()).toEqual({ status: "processing" });
    expect(requests[0].headers.get("stripe-account")).toBe(attempt.stripe_account_id);
    expect(requests[0].url).toContain(`/v1/checkout/sessions/${session.id}`);
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it("refuses to reuse an open session after revocation", async () => {
    attempt.state = "open"; attempt.stripe_session_id = session.id;
    connection.disconnected_at = "2026-10-02";
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("stripe-account")).toBe(attempt.stripe_account_id);
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutCreation).not.toHaveBeenCalled();
  });
  it("returns paid/processing without initiating another payment", async () => {
    invoice.status = "paid";
    expect(await pay()).toEqual({ status: "paid" });
    invoice.status = "sent"; attempt.state = "processing";
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    expect(await pay()).toEqual({ status: "processing" });
    expect(requests).toHaveLength(0);
  });
  it("marks confirmed unpaid expiration before reserving a new generation", async () => {
    const previous = attemptFixture({ state: "open", stripe_session_id: session.id });
    mocks.getLatestCheckoutAttempt.mockResolvedValue(previous);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(String(url).includes("accounts")
        ? { id: "acct_issuer", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }
        : String(url).endsWith(previous.stripe_session_id!) ? sessionFixture({ status: "expired", url: null }) : session));
    });
    await pay();
    expect(mocks.recordCheckoutSessionExpiration).toHaveBeenCalledWith(database, expect.objectContaining({ sessionId: previous.stripe_session_id, sessionStatus: "expired", paymentStatus: "unpaid" }));
    expect(mocks.reserveCheckoutAttempt).toHaveBeenCalledOnce();
  });
  it("expires an open session during void reconciliation in its recorded account", async () => {
    invoice.stripe_void_pending = true;
    attempt.state = "open"; attempt.stripe_session_id = session.id;
    mocks.getLatestCheckoutAttempt.mockResolvedValue(attempt);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(String(url).endsWith("/expire") ? sessionFixture({ status: "expired", url: null }) : session));
    });
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    const expired = requests.find((r) => r.url.endsWith("/expire"))!;
    expect(expired.headers.get("stripe-account")).toBe(attempt.stripe_account_id);
    expect(mocks.recordCheckoutSessionExpiration).toHaveBeenCalledOnce();
    expect(mocks.reserveCheckoutAttempt).not.toHaveBeenCalled();
  });
  it("retains and expires a session returned after void begins, never returning its payment URL", async () => {
    mocks.attachCheckoutSession.mockImplementation(async () => {
      invoice.stripe_void_pending = true;
      return { ...attempt, state: "open", stripe_session_id: session.id };
    });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(String(url).includes("accounts")
        ? { id: "acct_issuer", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }
        : String(url).endsWith("/expire") ? sessionFixture({ status: "expired", url: null }) : session));
    });
    await expect(pay()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.attachCheckoutSession).toHaveBeenCalledWith(database, expect.objectContaining({ sessionId: session.id }));
    expect(requests.find((request) => request.url.endsWith("/expire"))?.headers.get("stripe-account")).toBe("acct_issuer");
    expect(mocks.recordCheckoutSessionExpiration).toHaveBeenCalledOnce();
  });
});
