import type { APIRoute } from "astro";
import Stripe from "stripe";
import { invoices, createDb } from "@quickspense/domain";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    locals.logger.error("Stripe webhook hit but secrets are not configured");
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-04-22.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Read the raw body. Stripe signature verification requires the exact bytes.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    locals.logger.warn("Stripe webhook signature verification failed", {
      error: e,
    });
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(env.DB);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const payToken = session.metadata?.pay_token;
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;

      if (!payToken) {
        locals.logger.warn("checkout.session.completed missing pay_token", {
          sessionId: session.id,
        });
      } else if (session.payment_status === "paid") {
        const updated = await invoices.markInvoicePaidByPayToken(db, payToken, {
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentIntentId ?? undefined,
        });
        if (updated) {
          locals.logger.info("Invoice marked paid via webhook", {
            invoiceId: updated.id,
            invoiceNumber: updated.invoice_number,
          });
        } else {
          locals.logger.warn("Webhook for unknown invoice pay_token", {
            payToken,
          });
        }
      }
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Stripe.Checkout.Session;
      const payToken = session.metadata?.pay_token;
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      if (payToken) {
        await invoices.markInvoicePaidByPayToken(db, payToken, {
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentIntentId ?? undefined,
        });
      }
    }
  } catch (e) {
    locals.logger.error("Stripe webhook processing error", {
      error: e,
      eventType: event.type,
    });
    return new Response(JSON.stringify({ error: "Processing failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
};
