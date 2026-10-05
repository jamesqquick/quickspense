import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@quickspense/domain";
import { payToken, paymentEnv } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  createDraftInvoice: vi.fn(),
  updateDraftInvoice: vi.fn(),
  payInvoice: vi.fn(),
}));

vi.mock("@quickspense/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quickspense/domain")>();

  return {
    ...actual,
    createDb: mocks.createDb,
    invoices: {
      ...actual.invoices,
      createDraftInvoice: mocks.createDraftInvoice,
      updateDraftInvoice: mocks.updateDraftInvoice,
    },
  };
});

vi.mock("@/lib/invoiceCheckout", () => ({ payInvoice: mocks.payInvoice }));

import { PATCH } from "../src/pages/api/invoices/[id]";
import { POST } from "../src/pages/api/invoices/index";
import { POST as checkout } from "../src/pages/api/invoices/public/[token]/checkout";

describe("POST /api/invoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the requested currency to invoice creation", async () => {
    mocks.createDraftInvoice.mockResolvedValue({ id: "invoice-id", currency: "EUR" });

    const response = await POST({
      request: new Request("https://example.com/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Example Client",
          client_email: "client@example.com",
          due_date: "2026-10-30",
          currency: "EUR",
          line_items: [{ description: "Consulting", quantity: 1, unit_price: 10000 }],
        }),
      }),
      locals: {
        user: { id: "user-id" },
        runtime: { env: { DB: {} } },
        logger: { error: vi.fn() },
      },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(201);
    expect(mocks.createDraftInvoice.mock.calls[0]?.[1]).toMatchObject({
      userId: "user-id",
      currency: "EUR",
    });
  });

  it("preserves the requested currency when updating a draft", async () => {
    mocks.updateDraftInvoice.mockResolvedValue({ id: "invoice-id", currency: "EUR" });

    const response = await PATCH({
      params: { id: "invoice-id" },
      request: new Request("https://example.com/api/invoices/invoice-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: "EUR" }),
      }),
      locals: {
        user: { id: "user-id" },
        runtime: { env: { DB: {} } },
        logger: { error: vi.fn() },
      },
    } as Parameters<typeof PATCH>[0]);

    expect(response.status).toBe(200);
    expect(mocks.updateDraftInvoice.mock.calls[0]?.[3]).toMatchObject({
      currency: "EUR",
    });
  });
  it("returns 409 when sending wins a concurrent draft edit", async () => {
    mocks.updateDraftInvoice.mockRejectedValueOnce(
      new ConflictError("Only draft invoices can be edited"),
    );
    const error = vi.fn();

    const response = await PATCH({
      params: { id: "invoice-id" },
      request: new Request("https://example.com/api/invoices/invoice-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: "EUR" }),
      }),
      locals: {
        user: { id: "user-id" },
        runtime: { env: { DB: {} } },
        logger: { error },
      },
    } as Parameters<typeof PATCH>[0]);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Only draft invoices can be edited" });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("POST /api/invoices/public/:token/checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates Checkout creation to the shared connected-payment service", async () => {
    const result = { status: "checkout", url: "https://checkout.stripe.com/c/pay/session" };
    mocks.payInvoice.mockResolvedValue(result);
    const env = { ...paymentEnv, DB: {} };

    const response = await checkout({
      params: { token: payToken },
      locals: {
        runtime: { env },
        logger: { error: vi.fn() },
      },
    } as Parameters<typeof checkout>[0]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.payInvoice).toHaveBeenCalledWith(mocks.createDb.mock.results[0]?.value, { payToken }, env);
  });
});
