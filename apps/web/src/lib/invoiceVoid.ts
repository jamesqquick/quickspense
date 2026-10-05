import { ConflictError, DomainError, NotFoundError, invoicePayments, type Database, type Invoice } from "@quickspense/domain";
import { createStripeClient, getGuardedStripeLivemode } from "@/lib/stripe";
import { validateSession } from "@/lib/invoiceCheckout";
import { recordRetrievedLegacySession } from "@/lib/invoiceLegacySession";

export class InvoiceVoidUnavailableError extends DomainError {
  constructor() {
    super("Stripe void confirmation is pending. Please retry shortly.", "VOID_UNAVAILABLE", 503);
    this.name = "InvoiceVoidUnavailableError";
  }
}

function unresolvedPayment(): ConflictError {
  return new ConflictError("Resolve outstanding Stripe payments before voiding this invoice.");
}

export async function voidInvoice(
  db: Database, invoiceId: string, userId: string, env: Parameters<typeof createStripeClient>[0],
): Promise<Invoice> {
  try {
    const invoice = await invoicePayments.beginInvoiceVoid(db, invoiceId, userId);
    if (invoice.status === "void") return invoice;
    await invoicePayments.cancelUnstartedCheckoutAttempts(db, invoiceId, userId);
    const attempts = await invoicePayments.listCheckoutAttempts(db, invoiceId);
    const unresolved = attempts.filter((attempt) => !["expired", "failed"].includes(attempt.state));
    if (unresolved.some((attempt) => !attempt.stripe_session_id || ["processing", "paid"].includes(attempt.state))) {
      throw unresolvedPayment();
    }
    if (invoice.status === "sent" && invoice.stripe_charge_scope === "platform" && !invoice.stripe_session_id) {
      throw new ConflictError("Stripe/support verification is needed for this historical invoice before voiding.");
    }
    if (unresolved.length || invoice.stripe_session_id) {
      const livemode = getGuardedStripeLivemode(env);
      const stripe = createStripeClient(env);
      for (const attempt of unresolved) {
        if (attempt.invoice_id !== invoice.id || attempt.charge_scope !== "connected"
          || attempt.stripe_connection_id !== invoice.stripe_connection_id || attempt.stripe_account_id !== invoice.stripe_account_id
          || attempt.livemode !== invoice.stripe_livemode || attempt.livemode !== livemode
          || attempt.amount_total !== invoice.total || attempt.currency !== invoice.currency.toLowerCase()) {
          throw new InvoiceVoidUnavailableError();
        }
        const options = { stripeAccount: attempt.stripe_account_id };
        let session = await stripe.checkout.sessions.retrieve(attempt.stripe_session_id!, {}, options);
        validateSession(session, attempt, invoice);
        if (session.status === "complete" || session.payment_status !== "unpaid") throw unresolvedPayment();
        if (session.status === "open") {
          session = await stripe.checkout.sessions.expire(session.id, {}, options);
          validateSession(session, attempt, invoice);
        }
        if (session.status !== "expired" || session.payment_status !== "unpaid") throw unresolvedPayment();
        const expired = await invoicePayments.recordCheckoutSessionExpiration(db, {
          attemptId: attempt.id, stripeAccountId: attempt.stripe_account_id, livemode: attempt.livemode,
          sessionId: session.id, sessionLivemode: session.livemode, sessionStatus: "expired", paymentStatus: "unpaid",
        });
        if (!expired) throw unresolvedPayment();
      }
      if (invoice.stripe_charge_scope === "platform" && invoice.stripe_session_id) {
        let session = await stripe.checkout.sessions.retrieve(invoice.stripe_session_id);
        await recordRetrievedLegacySession(db, invoice, session, livemode);
        if (session.status === "complete" || session.payment_status !== "unpaid") throw unresolvedPayment();
        if (session.status === "open") {
          session = await stripe.checkout.sessions.expire(invoice.stripe_session_id);
          await recordRetrievedLegacySession(db, invoice, session, livemode);
        }
        if (session.status !== "expired" || session.payment_status !== "unpaid") throw unresolvedPayment();
      }
    }
    return await invoicePayments.finalizeInvoiceVoid(db, invoiceId, userId);
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof InvoiceVoidUnavailableError) throw error;
    throw new InvoiceVoidUnavailableError();
  }
}
