import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { invoiceFixture, payToken } from "./helpers/invoicePayment";

vi.mock("astro:actions", () => ({ actions: { invoice: { pay: vi.fn() } } }));
import { PublicInvoiceView } from "@/components/PublicInvoiceView";

function publicInvoice(payment_processing = false) {
  const invoice = invoiceFixture();
  return { ...invoice, payment_processing, issuer_name: "Issuer business", issuer_email: null,
    issuer_phone: null, issuer_address: null };
}
describe("public invoice payment controls", () => {
  it("server-renders a disabled payment button for processing invoices", () => {
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: publicInvoice(true) }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Payment processing<\/button>/);
    expect(html).toContain("Processing your payment");
  });
  it("renders the persisted fractional quantity and exact total with an enabled payment button", () => {
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: publicInvoice() }));
    expect(html).toContain("1.5");
    expect(html).toMatch(/<button[^>]*>Pay \$16\.25<\/button>/);
    expect(html).not.toContain("disabled=\"\"");
  });
  it("never offers another payment on a paid invoice", () => {
    const invoice = publicInvoice(); invoice.status = "paid";
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: invoice }));
    expect(html).toContain("This invoice has been paid.");
    expect(html).not.toContain("Pay $16.25");
  });
  it("renders EUR line items, tax, and payment totals without converting cents", () => {
    const invoice = { ...publicInvoice(), currency: "EUR" as const };
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: invoice }));
    for (const amount of ["€10.01", "€15.02", "€1.23", "€16.25"]) expect(html).toContain(amount);
    expect(html).toMatch(/<button[^>]*>Pay €16\.25<\/button>/);
    expect(html).not.toContain("$");
  });
  it("keeps EUR payments disabled while processing", () => {
    const invoice = { ...publicInvoice(true), currency: "EUR" as const };
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: invoice }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Payment processing<\/button>/);
    expect(html).toContain("€16.25");
    expect(html).not.toContain("Pay €16.25");
  });
  it("displays every original invoice item even when Checkout needs consolidation", () => {
    const invoice = publicInvoice();
    invoice.line_items = Array.from({ length: 100 }, (_, i) => ({ ...invoice.line_items[0],
      id: `line_${i}`, position: i, description: `Original service ${i}`,
    }));
    invoice.subtotal = invoice.line_items.reduce((sum, item) => sum + item.line_total, 0);
    invoice.total = invoice.subtotal + invoice.tax_amount;
    const html = renderToStaticMarkup(createElement(PublicInvoiceView, { token: payToken, initialInvoice: invoice }));
    for (const item of invoice.line_items) expect(html).toContain(`>${item.description}</td>`);
    expect(html.match(/<tr /g)).toHaveLength(100);
    expect(html).toContain("Pay $1,503.23");
  });
});
