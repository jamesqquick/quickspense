import type { APIRoute } from "astro";
import { createDb } from "@quickspense/domain";
import { getPublicInvoice } from "@/lib/publicInvoice";

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

  const invoice = await getPublicInvoice(db, token, env.EMAIL_FROM_NAME);
  if (!invoice) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(JSON.stringify(invoice), {
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
};
