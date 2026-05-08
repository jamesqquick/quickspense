import type { APIRoute } from "astro";
import { invoices, businessProfiles, createDb } from "@quickspense/domain";

/**
 * Public read of an invoice by its pay_token. Returns the minimum data
 * needed to render the public pay page: amounts, line items, status, and
 * the issuer's business profile (or fallback to env defaults if unset).
 *
 * SECURITY: This endpoint is unauthenticated. Anyone with the pay_token can
 * call it. We deliberately do NOT expose:
 * - `client_email` / `client_address`: PII that the recipient already knows;
 *   if the token URL leaks (forwarded email, browser history, server logs)
 *   we don't want to leak the recipient's contact info to whoever finds it.
 * - `user_id`, `stripe_session_id`, `stripe_payment_intent_id`: internal IDs.
 *
 * Issuer fields (`issuer_name`, etc.) are intentionally exposed: they're
 * what the client expects to see on the invoice they're paying. The issuer
 * is publishing their own business identity by sending the invoice.
 *
 * Responses also set `Referrer-Policy: no-referrer` so the pay_token isn't
 * leaked in the Referer header when the user navigates to Stripe Checkout
 * or any external link from the pay page.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const token = params.token!;

  const invoice = await invoices.getInvoiceByPayToken(db, token);
  if (!invoice) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // Fall back to env defaults for users who haven't set up a business
  // profile yet. New users will get the prompt to set one up in settings.
  const profile = await businessProfiles.getBusinessProfile(
    db,
    invoice.user_id,
  );

  const publicView = {
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    client_name: invoice.client_name,
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
    issuer_name: profile?.business_name ?? env.EMAIL_FROM_NAME,
    issuer_email: profile?.business_email ?? null,
    issuer_phone: profile?.business_phone ?? null,
    issuer_address: profile?.business_address ?? null,
  };

  return new Response(JSON.stringify(publicView), {
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
    },
  });
};
