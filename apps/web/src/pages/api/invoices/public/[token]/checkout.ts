import type { APIRoute } from "astro";
import Stripe from "stripe";
import { invoices, createDb } from "@quickspense/domain";

/**
 * Public endpoint. Creates a Stripe Checkout Session for the invoice with the
 * given pay_token and returns the hosted Checkout URL. Stashes the session id
 * on the invoice for reconciliation if the webhook signature ever falls behind.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const env = locals.runtime.env;
    const db = createDb(env.DB);
    const token = params.token!;

    if (!env.STRIPE_SECRET_KEY) {
      return new Response(
        JSON.stringify({ error: "Stripe is not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const invoice = await invoices.getInvoiceByPayToken(db, token);
    if (!invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (invoice.status === "paid") {
      return new Response(
        JSON.stringify({ error: "Invoice is already paid" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    if (invoice.status === "void") {
      return new Response(JSON.stringify({ error: "Invoice has been voided" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (invoice.status === "draft") {
      return new Response(
        JSON.stringify({ error: "Invoice has not been sent yet" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-04-22.dahlia",
      // Required for Workers fetch-based runtime
      httpClient: Stripe.createFetchHttpClient(),
    });

    const currency = invoice.currency.toLowerCase();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    for (const item of invoice.line_items) {
      lineItems.push({
        quantity: Math.max(1, Math.round(item.quantity)),
        price_data: {
          currency,
          unit_amount: item.unit_price,
          product_data: {
            name: item.description,
          },
        },
      });
    }

    if (invoice.tax_amount > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: invoice.tax_amount,
          product_data: { name: "Tax" },
        },
      });
    }

    const successUrl = `${env.APP_URL}/pay/${token}?status=success`;
    const cancelUrl = `${env.APP_URL}/pay/${token}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: invoice.client_email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        invoice_id: invoice.id,
        pay_token: token,
        invoice_number: invoice.invoice_number,
      },
      payment_intent_data: {
        metadata: {
          invoice_id: invoice.id,
          pay_token: token,
          invoice_number: invoice.invoice_number,
        },
      },
    });

    if (!session.url) {
      return new Response(
        JSON.stringify({ error: "Stripe did not return a checkout URL" }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    await invoices.attachStripeSession(db, token, session.id);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    locals.logger.error("Stripe checkout creation error", { error: e });
    return new Response(
      JSON.stringify({ error: "Failed to create checkout session" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
