import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  createDraftInvoice: vi.fn(),
  updateDraftInvoice: vi.fn(),
  getInvoiceByPayToken: vi.fn(),
  attachStripeSession: vi.fn(),
  createStripeSession: vi.fn(),
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
      getInvoiceByPayToken: mocks.getInvoiceByPayToken,
      attachStripeSession: mocks.attachStripeSession,
    },
  };
});

vi.mock("@/lib/stripe", () => ({
  createStripeClient: vi.fn(() => ({
    checkout: { sessions: { create: mocks.createStripeSession } },
  })),
}));

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
});

describe("POST /api/invoices/public/:token/checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a Stripe Checkout Session in the invoice currency", async () => {
    mocks.getInvoiceByPayToken.mockResolvedValue({
      id: "invoice-id",
      status: "sent",
      currency: "EUR",
      client_email: "client@example.com",
      tax_amount: 250,
      line_items: [
        {
          description: "Consulting",
          quantity: 2,
          unit_price: 6250,
        },
      ],
    });
    mocks.createStripeSession.mockResolvedValue({
      id: "session-id",
      url: "https://checkout.example/session",
    });

    const response = await checkout({
      params: { token: "invoice-test-token" },
      locals: {
        runtime: {
          env: {
            DB: {},
            STRIPE_SECRET_KEY: "test-configuration",
            APP_URL: "https://quickspense.example",
          },
        },
        logger: { error: vi.fn() },
      },
    } as Parameters<typeof checkout>[0]);

    expect(response.status).toBe(200);
    expect(mocks.createStripeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: expect.arrayContaining([
          expect.objectContaining({
            quantity: 2,
            price_data: expect.objectContaining({
              currency: "eur",
              unit_amount: 6250,
            }),
          }),
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "eur",
              unit_amount: 250,
            }),
          }),
        ]),
      }),
    );
  });
});
