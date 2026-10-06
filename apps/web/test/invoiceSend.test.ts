import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionFixture, invoiceFixture, paymentEnv } from "./helpers/invoicePayment";
const mocks = vi.hoisted(() => ({ getInvoice: vi.fn(), markInvoiceSent: vi.fn(), refreshInvoiceStripeConnection: vi.fn(), createStripeClient: vi.fn() }));
vi.mock("@quickspense/domain", async (original) => ({ ...await original<typeof import("@quickspense/domain")>(),
  createDb: () => ({}), invoices: { getInvoice: mocks.getInvoice, markInvoiceSent: mocks.markInvoiceSent },
  businessProfiles: { getBusinessProfile: vi.fn() },
}));
vi.mock("@/lib/invoiceCheckout", async (original) => ({
  ...await original<typeof import("@/lib/invoiceCheckout")>(),
  refreshInvoiceStripeConnection: mocks.refreshInvoiceStripeConnection,
}));
vi.mock("@/lib/stripe", () => ({ createStripeClient: mocks.createStripeClient, getGuardedStripeLivemode: () => false }));
import { POST } from "@/pages/api/invoices/[id]/send";
const context = () => ({ params: { id: "invoice_issuer" }, locals: { user: { id: "issuer" }, logger: { error: vi.fn(), warn: vi.fn() }, runtime: { env: { ...paymentEnv, DB: {} } } } });
beforeEach(() => {
  vi.resetAllMocks(); mocks.getInvoice.mockResolvedValue(invoiceFixture({ status: "draft" }));
  mocks.markInvoiceSent.mockResolvedValue(invoiceFixture()); mocks.refreshInvoiceStripeConnection.mockResolvedValue(connectionFixture());
});
describe("invoice send readiness", () => {
  it("requires the issuer even when middleware is bypassed", async () => {
    const ctx = context(); delete (ctx.locals as { user?: unknown }).user;
    expect((await POST(ctx as never)).status).toBe(401);
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });
  it("passes the exact refreshed connection/revision into the atomic send transition", async () => {
    await POST(context() as never);
    expect(mocks.refreshInvoiceStripeConnection).toHaveBeenCalled();
    expect(mocks.markInvoiceSent).toHaveBeenCalledWith({}, "invoice_issuer", "issuer", false, {
      connectionId: "connection_issuer", expectedAuthorizationRevision: "revision_original",
    });
  });
  it("does not send when readiness refresh fails", async () => {
    const { ConflictError } = await import("@quickspense/domain");
    mocks.refreshInvoiceStripeConnection.mockRejectedValue(new ConflictError("Stripe connection changed. Refresh and try again."));
    expect((await POST(context() as never)).status).toBe(409);
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });
});
