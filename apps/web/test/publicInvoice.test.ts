import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoiceFixture, payToken } from "./helpers/invoicePayment";
const mocks = vi.hoisted(() => ({ getInvoiceByPayToken: vi.fn(), getLatestCheckoutAttempt: vi.fn(), getBusinessProfile: vi.fn() }));
vi.mock("@quickspense/domain", () => ({ invoices: mocks, invoicePayments: mocks, businessProfiles: mocks }));
import { getPublicInvoice } from "@/lib/publicInvoice";
beforeEach(() => {
  vi.resetAllMocks(); mocks.getInvoiceByPayToken.mockResolvedValue(invoiceFixture());
  mocks.getLatestCheckoutAttempt.mockResolvedValue(null); mocks.getBusinessProfile.mockResolvedValue(null);
});
describe("public payment view data", () => {
  it("only returns public invoice/issuer fields, never recipient email or payment identifiers", async () => {
    const view = await getPublicInvoice({} as never, payToken, "Issuer fallback");
    expect(view?.issuer_name).toBe("Issuer fallback");
    expect(view?.total).toBe(1625);
    expect(view).not.toHaveProperty("user_id");
    expect(view).not.toHaveProperty("pay_token");
    expect(view).not.toHaveProperty("client_email");
    expect(view).not.toHaveProperty("stripe_account_id");
    expect(view).not.toHaveProperty("stripe_session_id");
    expect(view?.line_items[0]).not.toHaveProperty("invoice_id");
  });
  it.each(["processing", "paid"])("blocks sent invoices whose attempt is %s", async (state) => {
    mocks.getLatestCheckoutAttempt.mockResolvedValue({ state });
    expect((await getPublicInvoice({} as never, payToken, "Issuer"))?.payment_processing).toBe(true);
  });
  it("permits retry after a signed async failure", async () => {
    mocks.getLatestCheckoutAttempt.mockResolvedValue({ state: "failed" });
    expect((await getPublicInvoice({} as never, payToken, "Issuer"))?.payment_processing).toBe(false);
  });
  it("returns null for an unknown payment link", async () => {
    mocks.getInvoiceByPayToken.mockResolvedValue(null);
    expect(await getPublicInvoice({} as never, payToken, "Issuer")).toBeNull();
    expect(mocks.getBusinessProfile).not.toHaveBeenCalled();
  });
});
