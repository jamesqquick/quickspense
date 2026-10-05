import Stripe from "stripe";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  invoicePayments,
  invoices,
  payInvoiceSchema,
  stripeConnections,
  type Database,
  type Invoice,
  type InvoiceCheckoutAttempt,
  type InvoiceWithLineItems,
  type PayInvoiceInput,
  type PayInvoiceResult,
  type StripeConnection,
} from "@quickspense/domain";
import { createStripeClient, getGuardedStripeLivemode } from "@/lib/stripe";
import { retrieveStripeAccountObservation } from "@/lib/stripeConnect";

type CheckoutEnv = Parameters<typeof createStripeClient>[0] & { APP_URL: string };

export class InvoiceCheckoutUnavailableError extends DomainError {
  constructor() {
    super("Payment confirmation is temporarily unavailable. Please try again shortly.", "CHECKOUT_UNAVAILABLE", 503);
    this.name = "InvoiceCheckoutUnavailableError";
  }
}

function paymentConflict(): ConflictError {
  return new ConflictError("This invoice cannot accept a payment right now. Please contact the sender.");
}

export function getInvoicePaymentBaseUrl(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new InvoiceCheckoutUnavailableError();
    }
    return url.origin;
  } catch {
    throw new InvoiceCheckoutUnavailableError();
  }
}

export async function refreshInvoiceStripeConnection(
  db: Database,
  stripe: Stripe,
  userId: string,
  livemode: boolean,
  connectionId?: string,
): Promise<StripeConnection> {
  const connection = connectionId
    ? await stripeConnections.getConnectionById(db, connectionId)
    : await stripeConnections.getActiveConnection(db, userId);
  if (!connection || connection.user_id !== userId || connection.livemode !== livemode
    || connection.disconnected_at !== null || connection.disconnect_operation_id !== null
    || connection.disconnect_started_at !== null) {
    throw paymentConflict();
  }
  const { account, observedAt } = await retrieveStripeAccountObservation(
    () => stripe.accounts.retrieve(connection.stripe_account_id),
    connection.stripe_account_id,
    livemode,
  );
  const observation = await stripeConnections.updateAccountStatus(db, {
    ...account, observedAt, expectedAuthorizationRevision: connection.authorization_revision,
  });
  const current = await stripeConnections.getConnectionById(db, connection.id);
  if (observation.outcome !== "applied" || !current || current.user_id !== userId
    || current.stripe_account_id !== connection.stripe_account_id
    || current.authorization_revision !== connection.authorization_revision
    || current.disconnect_started_at !== null
    || !stripeConnections.isConnectionReady(current, livemode)
    || (livemode && (!account.charges_enabled || !account.payouts_enabled || !account.details_submitted))) {
    throw paymentConflict();
  }
  return current;
}

function safeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function buildCheckoutRequest(invoice: Readonly<Invoice>, items: InvoiceWithLineItems["line_items"], attemptId: string, baseUrl: string): string {
  if (!safeCents(invoice.subtotal) || !safeCents(invoice.tax_amount) || !safeCents(invoice.total) || invoice.total === 0
    || !/^[a-z]{3}$/i.test(invoice.currency) || items.length === 0) throw paymentConflict();
  const currency = invoice.currency.toLowerCase();
  let subtotal = 0;
  let lineItems: NonNullable<Stripe.Checkout.SessionCreateParams["line_items"]> = items.map((item) => {
    if (!safeCents(item.line_total) || !safeCents(item.unit_price) || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw paymentConflict();
    }
    subtotal += item.line_total;
    if (!safeCents(subtotal)) throw paymentConflict();
    return {
      quantity: 1,
      price_data: { currency, unit_amount: item.line_total,
        product_data: { name: item.description, description: `Quantity: ${item.quantity}` } },
    };
  });
  if (subtotal !== invoice.subtotal || !safeCents(subtotal + invoice.tax_amount) || subtotal + invoice.tax_amount !== invoice.total) {
    throw paymentConflict();
  }
  // Checkout's 100-row limit includes the separate tax row.
  if (lineItems.length + (invoice.tax_amount > 0 ? 1 : 0) > 100) {
    lineItems = [{ quantity: 1, price_data: { currency, unit_amount: subtotal,
      product_data: { name: `Invoice ${invoice.invoice_number} subtotal`, description: "See the full itemized invoice in Quickspense." } } }];
  }
  if (invoice.tax_amount > 0) {
    lineItems.push({ quantity: 1, price_data: { currency, unit_amount: invoice.tax_amount, product_data: { name: "Tax" } } });
  }
  const metadata = { invoice_id: invoice.id, pay_token: invoice.pay_token, checkout_attempt_id: attemptId };
  const request: Stripe.Checkout.SessionCreateParams = {
    mode: "payment", customer_email: invoice.client_email, line_items: lineItems,
    success_url: `${baseUrl}/pay/${invoice.pay_token}?status=success`, cancel_url: `${baseUrl}/pay/${invoice.pay_token}`,
    metadata, payment_intent_data: { metadata },
  };
  return JSON.stringify(request);
}

function attemptScope(attempt: InvoiceCheckoutAttempt): invoicePayments.CheckoutAttemptScope {
  return { attemptId: attempt.id, stripeAccountId: attempt.stripe_account_id, livemode: attempt.livemode };
}

function assertAttemptBinding(attempt: InvoiceCheckoutAttempt, invoice: Invoice): void {
  if (attempt.invoice_id !== invoice.id || attempt.stripe_connection_id !== invoice.stripe_connection_id
    || attempt.stripe_account_id !== invoice.stripe_account_id || attempt.livemode !== invoice.stripe_livemode
    || attempt.charge_scope !== "connected" || attempt.amount_total !== invoice.total
    || attempt.currency !== invoice.currency.toLowerCase()) throw paymentConflict();
}

function paymentIntentId(session: Stripe.Checkout.Session): string | undefined {
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
}

export function validateSession(session: Stripe.Checkout.Session, attempt: InvoiceCheckoutAttempt, invoice: Invoice): void {
  const intentId = paymentIntentId(session);
  if (session.object !== "checkout.session" || !session.id?.startsWith("cs_")
    || (attempt.stripe_session_id !== null && session.id !== attempt.stripe_session_id)
    || session.livemode !== attempt.livemode || session.mode !== "payment"
    || session.amount_total !== attempt.amount_total || session.currency?.toLowerCase() !== attempt.currency
    || session.metadata?.invoice_id !== invoice.id || session.metadata?.pay_token !== invoice.pay_token
    || session.metadata?.checkout_attempt_id !== attempt.id
    || (attempt.stripe_payment_intent_id !== null && intentId !== attempt.stripe_payment_intent_id)
    || (intentId !== undefined && !intentId.startsWith("pi_"))
    || !["open", "complete", "expired"].includes(session.status ?? "")
    || !["paid", "unpaid"].includes(session.payment_status)
    || (session.status !== "complete" && session.payment_status !== "unpaid")
    || (session.payment_status === "paid" && !intentId)) {
    throw new InvoiceCheckoutUnavailableError();
  }
  if (session.status === "open") {
    try {
      const url = new URL(session.url ?? "");
      if (url.protocol !== "https:" || url.username || url.password) throw new InvoiceCheckoutUnavailableError();
    } catch {
      throw new InvoiceCheckoutUnavailableError();
    }
  }
}

async function expireSession(db: Database, stripe: Stripe, invoice: Invoice, attempt: InvoiceCheckoutAttempt, session: Stripe.Checkout.Session): Promise<void> {
  if (session.status === "open") {
    session = await stripe.checkout.sessions.expire(session.id, {}, { stripeAccount: attempt.stripe_account_id });
    validateSession(session, attempt, invoice);
  }
  if (session.status === "expired" && session.payment_status === "unpaid") {
    await invoicePayments.recordCheckoutSessionExpiration(db, {
      ...attemptScope(attempt), sessionId: session.id, sessionLivemode: session.livemode,
      sessionStatus: "expired", paymentStatus: "unpaid",
    });
  }
}

async function checkoutUrl(db: Database, stripe: Stripe, invoice: Invoice, attempt: InvoiceCheckoutAttempt, session: Stripe.Checkout.Session, refreshed: StripeConnection): Promise<PayInvoiceResult> {
  const latest = await invoices.getInvoiceByPayToken(db, invoice.pay_token);
  if (latest?.status === "paid") return { status: "paid" };
  if (latest?.stripe_void_pending || latest?.status === "void") {
    await expireSession(db, stripe, latest, attempt, session);
    throw paymentConflict();
  }
  if (!latest || latest.status !== "sent") throw paymentConflict();
  assertAttemptBinding(attempt, latest);
  const current = await stripeConnections.getConnectionById(db, attempt.stripe_connection_id);
  if (!current || current.user_id !== latest.user_id || current.stripe_account_id !== attempt.stripe_account_id
    || current.authorization_revision !== refreshed.authorization_revision || current.disconnect_started_at !== null
    || !stripeConnections.isConnectionReady(current, attempt.livemode)) throw paymentConflict();
  return { status: "checkout", url: session.url! };
}

async function orchestrateCheckout(db: Database, input: PayInvoiceInput, env: CheckoutEnv): Promise<PayInvoiceResult> {
  if (!payInvoiceSchema.safeParse(input).success) throw new ValidationError("Invalid invoice payment link");
  const invoice = await invoices.getInvoiceByPayToken(db, input.payToken);
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.status === "paid") return { status: "paid" };
  if (!["sent", "void"].includes(invoice.status)) throw paymentConflict();
  const livemode = getGuardedStripeLivemode(env);
  if (!invoice.issued_at || invoice.stripe_charge_scope !== "connected" || !invoice.stripe_connection_id
    || !invoice.stripe_account_id?.startsWith("acct_") || invoice.stripe_livemode !== livemode) throw paymentConflict();
  const stripe = createStripeClient(env);
  let attempt = await invoicePayments.getLatestCheckoutAttempt(db, invoice.id);
  if (attempt) {
    assertAttemptBinding(attempt, invoice);
    if (attempt.state === "paid" || attempt.state === "processing") return { status: "processing" };
    if (attempt.stripe_session_id && !["expired", "failed"].includes(attempt.state)) {
      const session = await stripe.checkout.sessions.retrieve(attempt.stripe_session_id, {}, { stripeAccount: attempt.stripe_account_id });
      validateSession(session, attempt, invoice);
      // Retrieval is not a signed event and must never mint a webhook receipt.
      if (session.status === "complete") return { status: "processing" };
      if (invoice.stripe_void_pending || invoice.status === "void") {
        await expireSession(db, stripe, invoice, attempt, session);
        throw paymentConflict();
      }
      if (session.status === "expired") {
        const expired = await invoicePayments.recordCheckoutSessionExpiration(db, {
          ...attemptScope(attempt), sessionId: session.id, sessionLivemode: session.livemode,
          sessionStatus: "expired", paymentStatus: "unpaid",
        });
        if (!expired) return { status: "processing" };
        attempt = expired;
      } else {
        const refreshed = await refreshInvoiceStripeConnection(db, stripe, invoice.user_id, livemode, attempt.stripe_connection_id);
        return checkoutUrl(db, stripe, invoice, attempt, session, refreshed);
      }
    }
  } else if (invoice.stripe_session_id) {
    throw paymentConflict();
  }
  if (invoice.status !== "sent" || invoice.stripe_void_pending || invoice.stripe_payment_intent_id || invoice.paid_at) throw paymentConflict();
  const baseUrl = getInvoicePaymentBaseUrl(env.APP_URL);
  // Validate persisted amounts before reserving; retries retain the original request unchanged.
  if (!attempt || ["expired", "failed"].includes(attempt.state)) {
    buildCheckoutRequest(invoice, invoice.line_items, "validation", baseUrl);
  }
  const refreshed = await refreshInvoiceStripeConnection(db, stripe, invoice.user_id, livemode, invoice.stripe_connection_id);
  if (refreshed.stripe_account_id !== invoice.stripe_account_id) throw paymentConflict();
  if (!attempt || ["expired", "failed"].includes(attempt.state)) {
    attempt = await invoicePayments.reserveCheckoutAttempt(db, {
      ...input, livemode, expectedAuthorizationRevision: refreshed.authorization_revision,
      buildRequest: ({ attemptId, invoice: snapshot }) => buildCheckoutRequest(snapshot, invoice.line_items, attemptId, baseUrl),
    });
  }
  assertAttemptBinding(attempt, invoice);
  const claim = await invoicePayments.claimCheckoutCreation(db, {
    ...attemptScope(attempt), expectedAuthorizationRevision: refreshed.authorization_revision,
  });
  if (claim.kind === "busy") return { status: "processing" };
  if (claim.kind !== "claimed") {
    if (["open", "processing", "paid"].includes(claim.attempt.state)) return { status: "processing" };
    throw paymentConflict();
  }
  attempt = claim.attempt;
  let session: Stripe.Checkout.Session;
  let attached: InvoiceCheckoutAttempt | null;
  try {
    session = await stripe.checkout.sessions.create(JSON.parse(attempt.request_json), {
      stripeAccount: attempt.stripe_account_id, idempotencyKey: attempt.idempotency_key,
      maxNetworkRetries: 0, timeout: 30_000,
    });
    validateSession(session, attempt, invoice);
    attached = await invoicePayments.attachCheckoutSession(db, {
      ...attemptScope(attempt), claimId: claim.claimId, sessionId: session.id, paymentIntentId: paymentIntentId(session),
    });
    if (!attached) throw new InvoiceCheckoutUnavailableError();
  } catch {
    try {
      await invoicePayments.recordCheckoutCreationFailure(db, {
        ...attemptScope(attempt), claimId: claim.claimId,
        outcome: "unknown",
      });
    } catch {
      // The persisted lease still blocks competing creates; retry uses the same request and key.
    }
    throw new InvoiceCheckoutUnavailableError();
  }
  if (session.status === "complete" || ["processing", "paid"].includes(attached.state)) return { status: "processing" };
  if (session.status === "expired") {
    await expireSession(db, stripe, invoice, attached, session);
    throw paymentConflict();
  }
  if (attached.state !== "open") throw paymentConflict();
  return checkoutUrl(db, stripe, invoice, attached, session, refreshed);
}

export async function payInvoice(db: Database, input: PayInvoiceInput, env: CheckoutEnv): Promise<PayInvoiceResult> {
  try {
    return await orchestrateCheckout(db, input, env);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ValidationError || error instanceof InvoiceCheckoutUnavailableError) throw error;
    if (error instanceof ConflictError) throw paymentConflict();
    throw new InvoiceCheckoutUnavailableError();
  }
}
