import type { APIRoute } from "astro";
import { invoices, createDb } from "@quickspense/domain";

/**
 * Public read of an invoice by its pay_token. Returns minimal data needed
 * to render the public pay page: amounts, line items, client name, status.
 * Owner identity is NOT exposed here (only EMAIL_FROM_NAME is shown to clients).
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const db = createDb(locals.runtime.env.DB);
  const token = params.token!;

  const invoice = await invoices.getInvoiceByPayToken(db, token);
  if (!invoice) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Don't surface internal owner ids, stripe details
  const publicView = {
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    client_name: invoice.client_name,
    client_email: invoice.client_email,
    client_address: invoice.client_address,
    subtotal: invoice.subtotal,
    tax_amount: invoice.tax_amount,
    total: invoice.total,
    currency: invoice.currency,
    notes: invoice.notes,
    due_date: invoice.due_date,
    issued_at: invoice.issued_at,
    paid_at: invoice.paid_at,
    line_items: invoice.line_items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
      position: item.position,
    })),
    issuer_name: locals.runtime.env.EMAIL_FROM_NAME,
  };

  return new Response(JSON.stringify(publicView), {
    headers: { "Content-Type": "application/json" },
  });
};
