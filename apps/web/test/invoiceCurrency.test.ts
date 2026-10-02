import type { InvoiceWithLineItems } from "@quickspense/domain";
import { describe, expect, it } from "vitest";
import { invoiceToFormValues } from "../src/components/InvoiceDetail";
import {
  buildInvoicePayload,
  emptyInvoiceForm,
} from "../src/components/InvoiceForm";
import { sendInvoiceEmail } from "../src/lib/invoiceEmail";
import { formatInvoiceMoney } from "../src/lib/invoiceMoney";
import { renderInvoicePrintHtml } from "../src/lib/invoicePrintHtml";

const euroInvoice = {
  id: "invoice-1",
  user_id: "user-1",
  invoice_number: "INV-2026-001",
  pay_token: "pay-token",
  status: "sent",
  client_name: "Example Client",
  client_email: "client@example.com",
  client_address: null,
  subtotal: 12500,
  tax_amount: 250,
  total: 12750,
  currency: "EUR",
  notes: null,
  due_date: "2026-10-30",
  issued_at: "2026-10-01T12:00:00.000Z",
  paid_at: null,
  stripe_session_id: null,
  stripe_payment_intent_id: null,
  created_at: "2026-10-01T12:00:00.000Z",
  updated_at: "2026-10-01T12:00:00.000Z",
  line_items: [
    {
      id: "line-item-1",
      invoice_id: "invoice-1",
      description: "Consulting",
      quantity: 2,
      unit_price: 6250,
      line_total: 12500,
      position: 0,
      created_at: "2026-10-01T12:00:00.000Z",
    },
  ],
} satisfies InvoiceWithLineItems;

describe("formatInvoiceMoney", () => {
  it("formats USD and EUR using the invoice currency", () => {
    expect(formatInvoiceMoney(1234.5, "USD")).toBe("$1,234.50");
    expect(formatInvoiceMoney(1234.5, "EUR")).toBe("€1,234.50");
  });
});

describe("invoice form currency", () => {
  it("defaults new drafts to USD", () => {
    expect(emptyInvoiceForm().currency).toBe("USD");
  });

  it("includes EUR without converting entered amount values", () => {
    const draft = {
      ...emptyInvoiceForm(),
      tax_amount: "2.34",
      line_items: [
        { description: "Consulting", quantity: "3", unit_price: "12.34" },
      ],
    };

    expect(buildInvoicePayload({ ...draft, currency: "EUR" })).toMatchObject({
      currency: "EUR",
      tax_amount: 234,
      line_items: [{ quantity: 3, unit_price: 1234 }],
    });
  });

  it("initializes draft edits with the invoice currency and keeps amounts unchanged", () => {
    const values = invoiceToFormValues(euroInvoice);

    expect(values).toMatchObject({
      currency: "EUR",
      tax_amount: "2.50",
      line_items: [
        {
          description: "Consulting",
          quantity: "2",
          unit_price: "62.50",
        },
      ],
    });
    expect(buildInvoicePayload(values)).toMatchObject({
      currency: "EUR",
      tax_amount: 250,
      line_items: [
        {
          description: "Consulting",
          quantity: 2,
          unit_price: 6250,
        },
      ],
    });
  });
});

describe("EUR invoice output", () => {
  it("uses EUR for invoice email text and HTML line items and totals", async () => {
    const messages: Array<{ html?: string; text?: string }> = [];
    const email = {
      send: async (message: {
        to: string | string[];
        from: string | { email: string; name?: string };
        subject: string;
        html?: string;
        text?: string;
        replyTo?: string | { email: string; name?: string };
        headers?: Record<string, string>;
      }) => {
        messages.push(message);
        return { messageId: "message-1" };
      },
    };

    await sendInvoiceEmail({
      email,
      fromAddress: "billing@example.com",
      fromName: "Example Business",
      appUrl: "https://quickspense.example",
      invoice: euroInvoice,
    });

    const message = messages[0];
    expect(message?.text).toContain("Total due: €127.50");
    expect(message?.text).not.toContain("$");
    expect(message?.html).toContain("€62.50");
    expect(message?.html).toContain("€125.00");
    expect(message?.html).toContain("€2.50");
    expect(message?.html).toContain("€127.50");
    expect(message?.html).not.toContain("$");
  });

  it("uses EUR for printed invoice line items and totals", () => {
    const html = renderInvoicePrintHtml(euroInvoice, null, {
      fallbackIssuerName: "Example Business",
      appUrl: "https://quickspense.example",
    });

    expect(html).toContain("€62.50");
    expect(html).toContain("€125.00");
    expect(html).toContain("€2.50");
    expect(html).toContain("€127.50");
    expect(html).not.toContain("$");
  });
});
