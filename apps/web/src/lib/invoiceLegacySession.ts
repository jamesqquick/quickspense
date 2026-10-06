import type Stripe from "stripe";
import { ConflictError, invoicePayments, type Database, type Invoice } from "@quickspense/domain";

export async function recordRetrievedLegacySession(
  db: Database, invoice: Invoice, session: Stripe.Checkout.Session, expectedLivemode: boolean,
): Promise<void> {
  if (invoice.stripe_charge_scope !== "platform" || invoice.stripe_connection_id !== null
    || invoice.stripe_account_id !== null || !invoice.stripe_session_id
    || session.object !== "checkout.session" || session.id !== invoice.stripe_session_id
    || session.livemode !== expectedLivemode
    || (invoice.stripe_livemode !== null && invoice.stripe_livemode !== session.livemode)
    || session.mode !== "payment" || session.amount_total !== invoice.total
    || session.currency?.toLowerCase() !== invoice.currency.toLowerCase()
    || session.metadata?.pay_token !== invoice.pay_token || session.metadata?.checkout_attempt_id !== undefined
    || (session.metadata?.invoice_id !== undefined && session.metadata.invoice_id !== invoice.id)
    || !["open", "complete", "expired"].includes(session.status ?? "")
    || !["paid", "unpaid"].includes(session.payment_status)
    || (session.status !== "complete" && session.payment_status !== "unpaid")) {
    throw new ConflictError("Historical Stripe session verification is needed before continuing.");
  }
  await invoicePayments.recordLegacySessionEvidence(db, {
    invoiceId: invoice.id, sessionId: session.id, livemode: session.livemode,
    amountTotal: session.amount_total, currency: session.currency, payToken: invoice.pay_token,
    metadataInvoiceId: session.metadata?.invoice_id ?? null, sessionMode: session.mode,
    sessionStatus: session.status, paymentStatus: session.payment_status,
  });
}
