import type { APIRoute } from "astro";
import type Stripe from "stripe";
import { invoices, createDb } from "@quickspense/domain";
import { createStripeClient } from "../../../lib/stripe";

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

  let stripe: Stripe;
  try {
    stripe = createStripeClient(env);
  } catch (e) {
    locals.logger.error("Stripe client refused to initialize", {
      error: e instanceof Error ? e.message : String(e),
    });
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  /** Process a paid Checkout session with full amount + currency verification. */
  const handleSession = async (
    session: Stripe.Checkout.Session,
    eventType: string,
  ) => {
    const payToken = session.metadata?.pay_token;
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

    if (!payToken) {
      locals.logger.warn("Stripe webhook session missing pay_token", {
        sessionId: session.id,
        eventType,
      });
      return;
    }

    const result = await invoices.markInvoicePaidByPayToken(db, payToken, {
      stripeSessionId: session.id,
      stripePaymentIntentId: paymentIntentId ?? undefined,
      amountTotal: session.amount_total,
      currency: session.currency,
    });

    switch (result.kind) {
      case "paid":
        locals.logger.info("Invoice marked paid via webhook", {
          invoiceId: result.invoice.id,
          invoiceNumber: result.invoice.invoice_number,
          eventType,
        });
        return;
      case "unknown_token":
        // pay_token doesn't match any invoice. Ack the event (no replay)
        // and log so ops can investigate.
        locals.logger.warn("Webhook for unknown invoice pay_token", {
          sessionId: session.id,
          eventType,
        });
        return;
      case "void":
        // Customer paid after we voided the invoice. Refuse the transition;
        // ops/billing should refund out-of-band. Still ack so Stripe stops
        // retrying — a 5xx here would loop forever.
        locals.logger.error(
          "Stripe payment received for VOID invoice; refusing transition",
          {
            invoiceId: result.invoice.id,
            invoiceNumber: result.invoice.invoice_number,
            sessionId: session.id,
            eventType,
          },
        );
        return;
      case "amount_mismatch":
        // The session paid a different amount or currency than we issued.
        // This is the canonical Stripe webhook attack vector. Refuse and
        // ack so the bad event isn't retried. Ops MUST investigate.
        locals.logger.error("Stripe session amount/currency mismatch", {
          sessionId: session.id,
          payToken,
          expectedAmount: result.expectedAmount,
          expectedCurrency: result.expectedCurrency,
          gotAmount: result.gotAmount,
          gotCurrency: result.gotCurrency,
          eventType,
        });
        return;
    }
  };

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // For sync payment methods (cards), payment_status === "paid" here.
      // For async (ACH, bank transfers) it'll be "unpaid" and the matching
      // checkout.session.async_payment_succeeded event drives the transition.
      if (session.payment_status === "paid") {
        await handleSession(session, event.type);
      }
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleSession(session, event.type);
    }
  } catch (e) {
    locals.logger.error("Stripe webhook processing error", {
      error: e instanceof Error ? e.message : String(e),
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
