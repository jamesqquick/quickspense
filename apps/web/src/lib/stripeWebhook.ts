import Stripe from "stripe";
import { createDb, invoicePayments, invoices, stripeConnections, type StripeChargeScope } from "@quickspense/domain";
import { createStripeClient, getGuardedStripeLivemode } from "@/lib/stripe";
import { retrieveStripeConnectionObservation } from "@/lib/stripeConnect";
import { recordRetrievedLegacySession } from "@/lib/invoiceLegacySession";

function webhookResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "5" } : {}) },
  });
}

function isPaymentEvent(type: string): type is invoicePayments.InvoicePaymentEventType {
  return ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"].includes(type);
}

export async function handleStripeWebhook(request: Request, locals: App.Locals, endpointScope: StripeChargeScope): Promise<Response> {
  const env = locals.runtime.env;
  const secret = endpointScope === "connected" ? env.STRIPE_CONNECT_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !env.STRIPE_SECRET_KEY) {
    locals.logger.error("Stripe webhook configuration is unavailable", { endpointScope });
    return webhookResponse({ error: "Webhook temporarily unavailable" }, 503);
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return webhookResponse({ error: "Missing stripe-signature" }, 400);
  let stripe: Stripe;
  let expectedLivemode: boolean;
  try {
    expectedLivemode = getGuardedStripeLivemode(env);
    stripe = createStripeClient(env);
  } catch {
    locals.logger.error("Stripe webhook configuration is unavailable", { endpointScope });
    return webhookResponse({ error: "Webhook temporarily unavailable" }, 503);
  }
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(), signature, secret, undefined, Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    locals.logger.warn("Stripe webhook signature verification failed", { endpointScope });
    return webhookResponse({ error: "Invalid signature" }, 400);
  }
  const context = { endpointScope, eventId: event.id, eventType: event.type };
  const accountId = typeof event.account === "string" ? event.account : null;
  if (event.livemode !== expectedLivemode
    || (endpointScope === "connected" ? !accountId?.startsWith("acct_") : event.account !== undefined)) {
    locals.logger.warn("Stripe webhook rejected signed scope or runtime mode", context);
    return webhookResponse({ received: true });
  }
  if (!isPaymentEvent(event.type)) {
    if (endpointScope === "connected" && (event.type === "account.updated" || event.type === "account.application.deauthorized")) {
      try {
        const db = createDb(env.DB);
        const connection = await stripeConnections.getConnectionByAccountId(db, accountId!);
        if (!connection || connection.livemode !== event.livemode) return webhookResponse({ received: true });
        const observation = await retrieveStripeConnectionObservation(
          () => stripe.accounts.retrieve(accountId!), accountId!, event.livemode,
          () => stripe.accounts.list({ limit: 100 }),
        );
        await stripeConnections.processConnectionEvent(db, {
          eventId: event.id, eventType: event.type, stripeAccountId: accountId!, livemode: event.livemode,
          expectedAuthorizationRevision: connection.authorization_revision, ...observation,
          expectedDisconnectOperationId: connection.disconnect_operation_id,
        });
      } catch {
        locals.logger.error("Stripe connection event reconciliation is pending", context);
        return webhookResponse({ error: "Connection confirmation pending" }, 503);
      }
    }
    return webhookResponse({ received: true });
  }
  const session = event.data?.object as Stripe.Checkout.Session | undefined;
  const payToken = session?.metadata?.pay_token;
  const metadataInvoiceId = session?.metadata?.invoice_id;
  const attemptId = session?.metadata?.checkout_attempt_id;
  if (!session || session.object !== "checkout.session" || !session.id?.startsWith("cs_")
    || session.livemode !== event.livemode || typeof payToken !== "string" || !payToken
    || (endpointScope === "connected" && (typeof metadataInvoiceId !== "string" || !metadataInvoiceId || typeof attemptId !== "string" || !attemptId))
    || (endpointScope === "platform" && attemptId !== undefined)) {
    locals.logger.warn("Stripe webhook rejected invalid session metadata or mode", context);
    return webhookResponse({ received: true });
  }
  try {
    const db = createDb(env.DB);
    // Old platform sessions may contain only pay_token. The ledger still requires their exact known session and classified mode.
    const legacyInvoice = endpointScope === "platform" ? await invoices.getInvoiceByPayToken(db, payToken) : null;
    const invoiceId = metadataInvoiceId || legacyInvoice?.id;
    if (!invoiceId) {
      locals.logger.warn("Stripe webhook has no bound invoice", context);
      return webhookResponse({ received: true });
    }
    if (legacyInvoice?.stripe_charge_scope === "platform" && legacyInvoice.stripe_livemode === null) {
      if (!legacyInvoice.stripe_session_id || legacyInvoice.stripe_session_id !== session.id
        || (metadataInvoiceId && metadataInvoiceId !== legacyInvoice.id)) {
        locals.logger.warn("Historical Stripe session requires operator mapping", context);
        return webhookResponse({ error: "Historical payment verification pending" }, 503);
      }
      const retrieved = await stripe.checkout.sessions.retrieve(legacyInvoice.stripe_session_id);
      await recordRetrievedLegacySession(db, legacyInvoice, retrieved, expectedLivemode);
    }
    const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    const result = await invoicePayments.processInvoicePaymentEvent(db, {
      eventId: event.id, eventType: event.type, endpointScope, expectedLivemode,
      stripeAccountId: accountId, livemode: event.livemode,
      invoiceId, attemptId: endpointScope === "connected" ? attemptId! : null, payToken,
      sessionId: session.id, paymentIntentId: intentId, amountTotal: session.amount_total, currency: session.currency,
      sessionMode: session.mode, sessionStatus: session.status, paymentStatus: session.payment_status,
    });
    if (result.kind === "retryable") {
      locals.logger.warn("Stripe webhook binding is not ready; retry required", { ...context, reason: result.reason });
      return webhookResponse({ error: "Payment confirmation pending" }, 503);
    }
    if (result.kind === "rejected") {
      if (result.reason === "unknown_legacy_mode") {
        return webhookResponse({ error: "Historical payment verification pending" }, 503);
      }
      locals.logger.warn("Stripe webhook rejected invoice payment binding", { ...context, reason: result.reason });
    } else if (["duplicate_payment", "void_payment"].includes(result.result)) {
      locals.logger.warn("Stripe invoice payment requires reconciliation", { ...context, result: result.result });
    }
    return webhookResponse({ received: true });
  } catch {
    locals.logger.error("Stripe webhook payment processing failed", context);
    return webhookResponse({ error: "Payment confirmation temporarily unavailable" }, 503);
  }
}
