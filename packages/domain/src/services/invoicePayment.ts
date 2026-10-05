import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { invoiceCheckoutAttempts as attempts, invoiceLegacySessionEvidence as legacyEvidence, invoices, stripeWebhookEvents as events } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { Invoice, InvoiceCheckoutAttempt, StripeChargeScope } from "../types.js";

// Stripe may prune idempotency keys after 24 hours. Leave an hour for clock/network skew.
export const CHECKOUT_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const CHECKOUT_CREATION_LEASE_MS = 60 * 1000;

export type CheckoutAttemptScope = {
  attemptId: string;
  stripeAccountId: string;
  livemode: boolean;
  expectedAuthorizationRevision?: string;
};

export type CheckoutRequestContext = {
  attemptId: string;
  generation: number;
  invoice: Readonly<Invoice>;
};

export type ReserveCheckoutAttemptInput = {
  payToken: string;
  livemode: boolean;
  expectedAuthorizationRevision?: string;
  /** Pure server-side builder. Return the exact JSON object string sent to Stripe, including attempt metadata. */
  buildRequest: (context: CheckoutRequestContext) => string;
};

export type CheckoutCreationClaimResult =
  | { kind: "claimed"; attempt: InvoiceCheckoutAttempt; claimId: string }
  | { kind: "busy" | "not_creatable" | "retry_window_elapsed"; attempt: InvoiceCheckoutAttempt };

function scopedAttempt(input: CheckoutAttemptScope): SQL {
  return and(
    eq(attempts.id, input.attemptId),
    eq(attempts.stripe_account_id, input.stripeAccountId),
    eq(attempts.livemode, input.livemode),
  )!;
}

function readyInvoice(invoiceId: string, livemode: boolean, expectedAuthorizationRevision?: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM invoices i JOIN stripe_connections c ON c.id = i.stripe_connection_id
    WHERE i.id = ${invoiceId} AND i.status = 'sent' AND i.issued_at IS NOT NULL
      AND i.stripe_charge_scope = 'connected' AND i.stripe_livemode = ${livemode}
      AND i.stripe_account_id = c.stripe_account_id AND i.user_id = c.user_id
      AND i.stripe_livemode = c.livemode
      AND ${expectedAuthorizationRevision === undefined ? sql`1` : sql`c.authorization_revision = ${expectedAuthorizationRevision}`}
      AND c.disconnected_at IS NULL AND c.disconnect_operation_id IS NULL
      AND c.disconnect_started_at IS NULL
      AND (c.livemode = 0 OR (c.charges_enabled = 1 AND c.payouts_enabled = 1 AND c.details_submitted = 1))
      AND NOT EXISTS (
        SELECT 1 FROM stripe_connection_operations o
        WHERE o.connection_id = c.id AND o.kind = 'disconnect'
      )
      AND i.stripe_void_pending = 0 AND i.paid_at IS NULL
      AND i.stripe_payment_intent_id IS NULL AND i.total > 0
      AND (i.stripe_session_id IS NULL OR EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a WHERE a.invoice_id = i.id
          AND a.stripe_session_id = i.stripe_session_id
          AND a.stripe_account_id = i.stripe_account_id AND a.livemode = i.stripe_livemode
      ))
      AND NOT EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a WHERE a.invoice_id = i.id AND a.state = 'paid'
      )
  )`;
}

export async function getCheckoutAttempt(
  db: Database,
  input: CheckoutAttemptScope,
): Promise<InvoiceCheckoutAttempt | null> {
  const [row] = await db.select().from(attempts).where(scopedAttempt(input));
  return (row as InvoiceCheckoutAttempt | undefined) ?? null;
}

export async function getLatestCheckoutAttempt(
  db: Database,
  invoiceId: string,
): Promise<InvoiceCheckoutAttempt | null> {
  const [row] = await db.select().from(attempts).where(eq(attempts.invoice_id, invoiceId))
    .orderBy(desc(attempts.generation)).limit(1);
  return (row as InvoiceCheckoutAttempt | undefined) ?? null;
}

export async function listCheckoutAttempts(db: Database, invoiceId: string): Promise<InvoiceCheckoutAttempt[]> {
  return await db.select().from(attempts).where(eq(attempts.invoice_id, invoiceId))
    .orderBy(attempts.generation) as InvoiceCheckoutAttempt[];
}

/** Server-only evidence from retrieving the exact stored session in platform scope. Never accept browser assertions. */
export type LegacySessionEvidenceInput = {
  invoiceId: string;
  sessionId: string;
  livemode: boolean;
  amountTotal: number | null;
  currency: string | null;
  payToken: string;
  metadataInvoiceId: string | null;
  sessionMode: string;
  sessionStatus: string | null;
  paymentStatus: string;
};

export async function recordLegacySessionEvidence(db: Database, input: LegacySessionEvidenceInput, now = new Date()): Promise<boolean> {
  if (!input.sessionId.startsWith("cs_") || typeof input.livemode !== "boolean" || input.sessionMode !== "payment"
    || input.amountTotal === null || !Number.isSafeInteger(input.amountTotal) || !input.currency
    || (input.metadataInvoiceId !== null && input.metadataInvoiceId !== input.invoiceId)) {
    throw new ConflictError("Historical Stripe session could not be verified");
  }
  const currency = input.currency.toLowerCase();
  const binding = sql`${invoices.id} = ${input.invoiceId} AND ${invoices.stripe_charge_scope} = 'platform'
    AND ${invoices.stripe_connection_id} IS NULL AND ${invoices.stripe_account_id} IS NULL
    AND ${invoices.stripe_session_id} = ${input.sessionId} AND ${invoices.pay_token} = ${input.payToken}
    AND ${invoices.total} = ${input.amountTotal} AND lower(${invoices.currency}) = ${currency}
    AND (${invoices.stripe_livemode} IS NULL OR ${invoices.stripe_livemode} = ${input.livemode})
    AND ${invoices.status} IN ('sent', 'paid', 'void')`;
  const expired = input.sessionStatus === "expired" && input.paymentStatus === "unpaid";
  const [, classified] = await db.batch([
    db.insert(legacyEvidence).select(sql`
      SELECT id, ${input.sessionId}, ${input.livemode}, ${input.amountTotal}, ${currency}, ${input.payToken}, ${expired}, ${now.toISOString()}
      FROM invoices WHERE ${binding}
    `).onConflictDoUpdate({ target: legacyEvidence.invoice_id, set: {
      confirmed_expired: sql`MAX(${legacyEvidence.confirmed_expired}, ${expired})`, observed_at: now.toISOString(),
    } }),
    db.update(invoices).set({ stripe_livemode: input.livemode }).where(and(binding, sql`EXISTS (
      SELECT 1 FROM invoice_legacy_session_evidence e WHERE e.invoice_id = ${invoices.id}
        AND e.stripe_session_id = ${input.sessionId} AND e.livemode = ${input.livemode}
        AND e.amount_total = ${input.amountTotal} AND e.currency = ${currency} AND e.pay_token = ${input.payToken}
    )`)).returning({ id: invoices.id }),
  ]);
  if (classified.length !== 1) throw new ConflictError("Historical Stripe session could not be verified");
  return true;
}

async function requireAttempt(db: Database, input: CheckoutAttemptScope): Promise<InvoiceCheckoutAttempt> {
  const attempt = await getCheckoutAttempt(db, input);
  if (!attempt) throw new NotFoundError("Checkout attempt", input.attemptId);
  return attempt;
}

/** Reserves once, or returns the existing active attempt without running the builder again. */
export async function reserveCheckoutAttempt(
  db: Database,
  input: ReserveCheckoutAttemptInput,
  now = new Date(),
): Promise<InvoiceCheckoutAttempt> {
  const [row] = await db.select().from(invoices).where(eq(invoices.pay_token, input.payToken));
  if (!row) throw new NotFoundError("Invoice");
  const invoice = row as Invoice;
  const eligibility = readyInvoice(invoice.id, input.livemode, input.expectedAuthorizationRevision);
  const [ready] = await db.select({ id: invoices.id }).from(invoices)
    .where(and(eq(invoices.id, invoice.id), eligibility));
  if (!ready) throw new ConflictError("This invoice cannot accept a new Stripe checkout");

  const [active] = await db.select().from(attempts).where(and(
    eq(attempts.invoice_id, invoice.id),
    sql`${attempts.state} IN ('creating', 'open', 'processing', 'unknown')`,
    sql`${attempts.stripe_account_id} = ${invoice.stripe_account_id}`,
    eq(attempts.livemode, input.livemode),
    eligibility,
  ));
  if (active) return active as InvoiceCheckoutAttempt;

  const attemptId = crypto.randomUUID();
  const generation = invoice.stripe_checkout_attempt + 1;
  const requestJson = input.buildRequest({ attemptId, generation, invoice });
  let request: unknown;
  try {
    request = JSON.parse(requestJson);
  } catch {
    throw new ValidationError("Checkout request must be a JSON object");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ValidationError("Checkout request must be a JSON object");
  }

  const timestamp = now.toISOString();
  await db.run(sql`
    INSERT INTO invoice_checkout_attempts (
      id, invoice_id, generation, stripe_connection_id, stripe_account_id, livemode,
      charge_scope, amount_total, currency, idempotency_key, request_json, state, created_at, updated_at
    )
    SELECT ${attemptId}, id, ${generation}, stripe_connection_id, stripe_account_id, stripe_livemode,
      'connected', total, lower(currency), ${`invoice_checkout:${attemptId}`}, ${requestJson}, 'creating', ${timestamp}, ${timestamp}
    FROM invoices
    WHERE id = ${invoice.id} AND ${eligibility}
      AND stripe_checkout_attempt = ${invoice.stripe_checkout_attempt}
      AND stripe_connection_id = ${invoice.stripe_connection_id}
      AND stripe_account_id = ${invoice.stripe_account_id}
      AND total = ${invoice.total} AND currency = ${invoice.currency}
      AND pay_token = ${invoice.pay_token} AND invoice_number = ${invoice.invoice_number}
      AND client_email = ${invoice.client_email} AND client_name = ${invoice.client_name}
      AND NOT EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a
        WHERE a.invoice_id = invoices.id AND a.state IN ('creating', 'open', 'processing', 'unknown', 'paid')
      )
      AND (stripe_session_id IS NULL OR EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a
        WHERE a.invoice_id = invoices.id AND a.stripe_session_id = invoices.stripe_session_id
          AND a.state IN ('expired', 'failed')
      ))
  `);

  const [reserved] = await db.select().from(attempts).where(and(
    eq(attempts.invoice_id, invoice.id),
    eq(attempts.stripe_account_id, invoice.stripe_account_id!),
    eq(attempts.livemode, input.livemode),
    sql`${attempts.state} IN ('creating', 'open', 'processing', 'unknown')`,
    eligibility,
  ));
  if (!reserved) throw new ConflictError("Invoice payment changed; refresh before retrying");
  return reserved as InvoiceCheckoutAttempt;
}

/** Only a claimed result permits a create call. Use its stored account, key and request_json verbatim. */
export async function claimCheckoutCreation(
  db: Database,
  input: CheckoutAttemptScope,
  now = new Date(),
): Promise<CheckoutCreationClaimResult> {
  const attempt = await requireAttempt(db, input);
  const timestamp = now.toISOString();
  const leaseUntil = new Date(now.getTime() + CHECKOUT_CREATION_LEASE_MS).toISOString();
  const retryUntil = new Date(now.getTime() + CHECKOUT_RETRY_WINDOW_MS).toISOString();
  const claimId = crypto.randomUUID();

  // Crossing the cutoff never releases the active slot, even if no session id was recovered.
  await db.update(attempts).set({
    state: "unknown", creation_claim_id: null, creation_lease_expires_at: null, updated_at: timestamp,
  }).where(and(scopedAttempt(input), sql`${attempts.state} IN ('creating', 'unknown')`,
    sql`${attempts.stripe_session_id} IS NULL`, sql`${attempts.retry_until} <= ${leaseUntil}`,
    sql`(${attempts.creation_lease_expires_at} IS NULL OR ${attempts.creation_lease_expires_at} <= ${timestamp})`));

  const [claimed] = await db.update(attempts).set({
    // A reclaimed lease may have created a session even if its response was never recorded.
    state: sql`CASE WHEN ${attempts.first_creation_started_at} IS NOT NULL THEN 'unknown' ELSE ${attempts.state} END`,
    creation_claim_id: claimId,
    creation_lease_expires_at: leaseUntil,
    first_creation_started_at: sql`COALESCE(${attempts.first_creation_started_at}, ${timestamp})`,
    retry_until: sql`COALESCE(${attempts.retry_until}, ${retryUntil})`,
    updated_at: timestamp,
  }).where(and(scopedAttempt(input),
    sql`${attempts.state} IN ('creating', 'unknown')`, sql`${attempts.stripe_session_id} IS NULL`,
    sql`(${attempts.retry_until} IS NULL OR ${attempts.retry_until} > ${leaseUntil})`,
    sql`(${attempts.creation_lease_expires_at} IS NULL OR ${attempts.creation_lease_expires_at} <= ${timestamp})`,
    readyInvoice(attempt.invoice_id, input.livemode, input.expectedAuthorizationRevision),
    sql`EXISTS (
      SELECT 1 FROM invoices i WHERE i.id = ${attempts.invoice_id}
        AND i.stripe_connection_id = ${attempts.stripe_connection_id}
        AND i.stripe_account_id = ${attempts.stripe_account_id} AND i.stripe_livemode = ${attempts.livemode}
        AND i.total = ${attempts.amount_total} AND lower(i.currency) = ${attempts.currency}
        AND i.stripe_checkout_attempt = ${attempts.generation}
    )`,
  )).returning();
  if (claimed) return { kind: "claimed", claimId, attempt: claimed as InvoiceCheckoutAttempt };
  const latest = await requireAttempt(db, input);
  const kind = latest.retry_until !== null && latest.retry_until <= leaseUntil && latest.stripe_session_id === null
    ? "retry_window_elapsed"
    : latest.creation_lease_expires_at !== null && latest.creation_lease_expires_at > timestamp
      ? "busy" : "not_creatable";
  return { kind, attempt: latest };
}

export type AttachCheckoutSessionInput = CheckoutAttemptScope & {
  claimId: string;
  sessionId: string;
  paymentIntentId?: string;
};

/** Null means a stale claim. Recording an id is allowed during voiding; terminal states stay terminal. */
export async function attachCheckoutSession(
  db: Database,
  input: AttachCheckoutSessionInput,
  now = new Date(),
): Promise<InvoiceCheckoutAttempt | null> {
  if (!input.sessionId) throw new ValidationError("Checkout session id is required");
  const timestamp = now.toISOString();
  const [attached] = await db.batch([
    db.update(attempts).set({
      stripe_session_id: input.sessionId,
      stripe_payment_intent_id: sql`COALESCE(${attempts.stripe_payment_intent_id}, ${input.paymentIntentId ?? null})`,
      state: sql`CASE WHEN ${attempts.state} IN ('creating', 'unknown') THEN 'open' ELSE ${attempts.state} END`,
      creation_claim_id: null, creation_lease_expires_at: null, updated_at: timestamp,
    }).where(and(scopedAttempt(input), eq(attempts.creation_claim_id, input.claimId),
      sql`(${attempts.stripe_session_id} IS NULL OR ${attempts.stripe_session_id} = ${input.sessionId})`,
      sql`(${attempts.stripe_payment_intent_id} IS NULL OR ${attempts.stripe_payment_intent_id} = ${input.paymentIntentId ?? null})`,
    )).returning(),
    db.update(invoices).set({ stripe_session_id: input.sessionId, updated_at: timestamp })
      .where(and(eq(invoices.status, "sent"), sql`EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a
        WHERE a.id = ${input.attemptId} AND a.invoice_id = ${invoices.id}
          AND a.stripe_account_id = ${input.stripeAccountId} AND a.livemode = ${input.livemode}
          AND a.stripe_session_id = ${input.sessionId} AND a.generation = ${invoices.stripe_checkout_attempt}
      )`)),
  ]);
  return (attached[0] as InvoiceCheckoutAttempt | undefined) ?? null;
}

export type CheckoutCreationFailureInput = CheckoutAttemptScope & {
  claimId: string;
  /** not_created requires affirmative evidence about the original operation, not a retry's HTTP status; prior uncertainty stays unknown. */
  outcome: "not_created" | "unknown";
};

export async function recordCheckoutCreationFailure(
  db: Database,
  input: CheckoutCreationFailureInput,
  now = new Date(),
): Promise<InvoiceCheckoutAttempt | null> {
  const [row] = await db.update(attempts).set({
    state: input.outcome === "not_created"
      ? sql`CASE WHEN ${attempts.state} = 'unknown' THEN 'unknown' ELSE 'failed' END`
      : "unknown",
    creation_claim_id: null, creation_lease_expires_at: null, updated_at: now.toISOString(),
  }).where(and(scopedAttempt(input), eq(attempts.creation_claim_id, input.claimId),
    sql`${attempts.stripe_session_id} IS NULL`, sql`${attempts.state} IN ('creating', 'unknown')`,
  )).returning();
  return (row as InvoiceCheckoutAttempt | undefined) ?? null;
}

export type CheckoutSessionExpirationInput = CheckoutAttemptScope & {
  sessionId: string;
  sessionLivemode: boolean;
  sessionStatus: "expired";
  paymentStatus: "unpaid";
};

/** Use a server-retrieved/expired Stripe session in the recorded account. Null means no transition; processing/paid stay blocked. */
export async function recordCheckoutSessionExpiration(
  db: Database,
  input: CheckoutSessionExpirationInput,
  now = new Date(),
): Promise<InvoiceCheckoutAttempt | null> {
  if (!input.sessionId || input.sessionLivemode !== input.livemode
    || input.sessionStatus !== "expired" || input.paymentStatus !== "unpaid") {
    throw new ValidationError("A confirmed expired checkout in the recorded Stripe mode is required");
  }
  const [row] = await db.update(attempts).set({ state: "expired", updated_at: now.toISOString() })
    .where(and(scopedAttempt(input), eq(attempts.stripe_session_id, input.sessionId),
      sql`${attempts.state} IN ('open', 'unknown', 'expired')`,
    )).returning();
  return (row as InvoiceCheckoutAttempt | undefined) ?? null;
}

export async function beginInvoiceVoid(
  db: Database,
  invoiceId: string,
  userId: string,
  now = new Date(),
): Promise<Invoice> {
  const [row] = await db.update(invoices).set({ stripe_void_pending: true, updated_at: now.toISOString() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId),
      sql`${invoices.status} IN ('draft', 'sent')`, sql`${invoices.paid_at} IS NULL`,
      sql`${invoices.stripe_payment_intent_id} IS NULL`,
      sql`NOT EXISTS (SELECT 1 FROM invoice_checkout_attempts a WHERE a.invoice_id = ${invoices.id} AND a.state = 'paid')`,
    )).returning();
  if (row) return row as Invoice;
  const [existing] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId)));
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status === "void") return existing as Invoice;
  throw new ConflictError("A paid invoice cannot be voided");
}

export async function cancelUnstartedCheckoutAttempts(db: Database, invoiceId: string, userId: string, now = new Date()): Promise<number> {
  const result = await db.update(attempts).set({ state: "failed", updated_at: now.toISOString() })
    .where(and(eq(attempts.invoice_id, invoiceId), eq(attempts.state, "creating"),
      sql`${attempts.first_creation_started_at} IS NULL AND ${attempts.creation_claim_id} IS NULL
        AND ${attempts.stripe_session_id} IS NULL AND ${attempts.retry_until} IS NULL`,
      sql`EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${attempts.invoice_id}
        AND i.user_id = ${userId} AND i.stripe_void_pending = 1 AND i.status IN ('draft', 'sent'))`,
    ));
  return result.meta.changes;
}

/** Call only after every known checkout is confirmed expired/failed. Unknown/processing attempts block finalization. */
export async function finalizeInvoiceVoid(
  db: Database,
  invoiceId: string,
  userId: string,
  now = new Date(),
): Promise<Invoice> {
  const [row] = await db.update(invoices).set({ status: "void", stripe_void_pending: false, updated_at: now.toISOString() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId), eq(invoices.stripe_void_pending, true),
      sql`${invoices.status} IN ('draft', 'sent')`, sql`${invoices.paid_at} IS NULL`,
      sql`${invoices.stripe_payment_intent_id} IS NULL`,
      sql`NOT EXISTS (SELECT 1 FROM invoice_checkout_attempts a
        WHERE a.invoice_id = ${invoices.id} AND a.state NOT IN ('failed', 'expired'))`,
      sql`(${invoices.stripe_session_id} IS NULL OR EXISTS (
        SELECT 1 FROM invoice_checkout_attempts a
        WHERE a.invoice_id = ${invoices.id} AND a.stripe_session_id = ${invoices.stripe_session_id}
          AND a.state IN ('failed', 'expired')
      ) OR EXISTS (
        SELECT 1 FROM invoice_legacy_session_evidence e WHERE e.invoice_id = ${invoices.id}
          AND ${invoices.stripe_charge_scope} = 'platform' AND ${invoices.stripe_connection_id} IS NULL
          AND ${invoices.stripe_account_id} IS NULL AND e.stripe_session_id = ${invoices.stripe_session_id}
          AND e.livemode = ${invoices.stripe_livemode} AND e.amount_total = ${invoices.total}
          AND e.currency = lower(${invoices.currency}) AND e.pay_token = ${invoices.pay_token} AND e.confirmed_expired = 1
      ))`,
      sql`(${invoices.status} = 'draft' OR ${invoices.stripe_charge_scope} = 'connected'
        OR (${invoices.stripe_charge_scope} = 'platform' AND ${invoices.stripe_session_id} IS NOT NULL))`,
    )).returning();
  if (row) return row as Invoice;
  const [existing] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId)));
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status === "void") return existing as Invoice;
  throw new ConflictError("Resolve outstanding Stripe payments before voiding this invoice");
}

export type InvoicePaymentEventType =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed"
  | "checkout.session.expired";

/** The adapter must verify the endpoint's signature and supply the signed event account/mode, not client input. */
export type InvoicePaymentEventInput = {
  eventId: string;
  eventType: InvoicePaymentEventType;
  endpointScope: StripeChargeScope;
  expectedLivemode: boolean;
  stripeAccountId: string | null;
  livemode: boolean;
  invoiceId: string;
  attemptId: string | null;
  payToken: string;
  sessionId: string;
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  sessionMode: string;
  sessionStatus: string | null;
  paymentStatus: string;
};

export type InvoicePaymentReceiptResult = "applied" | "ignored" | "duplicate_payment" | "void_payment";
export type InvoicePaymentEventResult =
  | { kind: "processed" | "duplicate"; result: InvoicePaymentReceiptResult }
  | { kind: "retryable"; reason: "session_not_attached" | "binding_changed" }
  | { kind: "rejected"; reason: "invalid_event" | "binding_mismatch" | "unknown_legacy_mode" };

function eventState(input: InvoicePaymentEventInput): "processing" | "paid" | "failed" | "expired" | null {
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"].includes(input.eventType)) return null;
  if (input.sessionMode !== "payment") return null;
  if (input.eventType === "checkout.session.expired") {
    return input.sessionStatus === "expired" && input.paymentStatus === "unpaid" ? "expired" : null;
  }
  if (input.sessionStatus !== "complete") return null;
  if (input.eventType === "checkout.session.async_payment_failed") {
    return input.paymentStatus === "unpaid" ? "failed" : null;
  }
  if (input.paymentStatus === "paid" && input.paymentIntentId) return "paid";
  if (input.eventType === "checkout.session.completed" && input.paymentStatus === "unpaid") return "processing";
  return null;
}

/** Receipt and payment mutations commit in one D1 batch. Unattached early events have no receipt and must be retried. */
export async function processInvoicePaymentEvent(
  db: Database,
  input: InvoicePaymentEventInput,
  now = new Date(),
): Promise<InvoicePaymentEventResult> {
  const state = eventState(input);
  if (!state || !input.eventId || !input.sessionId || typeof input.livemode !== "boolean"
    || !["platform", "connected"].includes(input.endpointScope) || input.livemode !== input.expectedLivemode
    || (input.endpointScope === "connected" ? !input.stripeAccountId || !input.attemptId : input.stripeAccountId !== null || input.attemptId !== null)) {
    return { kind: "rejected", reason: "invalid_event" };
  }
  const accountId = input.stripeAccountId ?? "platform";
  const eventKey = JSON.stringify(["invoice_payment", input.endpointScope, input.livemode, accountId, input.eventId]);
  const [receipt] = await db.select({ result: events.result }).from(events).where(eq(events.event_key, eventKey));
  if (receipt) return { kind: "duplicate", result: receipt.result as InvoicePaymentReceiptResult };

  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId));
  if (!invoice || invoice.pay_token !== input.payToken || invoice.stripe_charge_scope !== input.endpointScope
    || invoice.total !== input.amountTotal || invoice.currency.toLowerCase() !== input.currency?.toLowerCase()
    || !["sent", "paid", "void"].includes(invoice.status)) {
    return { kind: "rejected", reason: "binding_mismatch" };
  }
  if (invoice.stripe_livemode === null && input.endpointScope === "platform") {
    return { kind: "rejected", reason: "unknown_legacy_mode" };
  }
  if (invoice.stripe_livemode !== input.livemode
    || (input.endpointScope === "connected" && invoice.stripe_account_id !== input.stripeAccountId)) {
    return { kind: "rejected", reason: "binding_mismatch" };
  }

  const attempt = input.attemptId === null ? null : await getCheckoutAttempt(db, {
    attemptId: input.attemptId, stripeAccountId: accountId, livemode: input.livemode,
  });
  if (input.endpointScope === "connected") {
    if (!attempt || attempt.invoice_id !== invoice.id || attempt.stripe_connection_id !== invoice.stripe_connection_id
      || attempt.amount_total !== input.amountTotal || attempt.currency !== input.currency?.toLowerCase()
      || (attempt.stripe_payment_intent_id !== null && input.paymentIntentId !== attempt.stripe_payment_intent_id)) {
      return { kind: "rejected", reason: "binding_mismatch" };
    }
    if (attempt.stripe_session_id === null) return { kind: "retryable", reason: "session_not_attached" };
    if (attempt.stripe_session_id !== input.sessionId) return { kind: "rejected", reason: "binding_mismatch" };
  } else if (invoice.stripe_connection_id !== null || invoice.stripe_account_id !== null
    || invoice.stripe_session_id !== input.sessionId
    || (invoice.stripe_payment_intent_id !== null && invoice.stripe_payment_intent_id !== input.paymentIntentId)) {
    return { kind: "rejected", reason: "binding_mismatch" };
  }

  const timestamp = now.toISOString();
  const receiptId = crypto.randomUUID();
  const binding = sql`${invoices.id} = ${input.invoiceId}
    AND ${invoices.pay_token} = ${input.payToken}
    AND ${invoices.stripe_charge_scope} = ${input.endpointScope}
    AND ${invoices.stripe_livemode} = ${input.livemode}
    AND ${invoices.total} = ${input.amountTotal} AND lower(${invoices.currency}) = ${input.currency!.toLowerCase()}
    AND ${invoices.status} IN ('sent', 'paid', 'void')
    AND ${input.endpointScope === "connected" ? sql`EXISTS (
      SELECT 1 FROM invoice_checkout_attempts a
      WHERE a.id = ${input.attemptId} AND a.invoice_id = ${invoices.id}
        AND a.stripe_account_id = ${input.stripeAccountId} AND a.livemode = ${input.livemode}
        AND a.charge_scope = 'connected' AND a.stripe_connection_id = ${invoices.stripe_connection_id}
        AND a.stripe_account_id = ${invoices.stripe_account_id}
        AND a.amount_total = ${input.amountTotal} AND a.currency = ${input.currency!.toLowerCase()}
        AND a.stripe_session_id = ${input.sessionId}
        AND (a.stripe_payment_intent_id IS NULL OR a.stripe_payment_intent_id = ${input.paymentIntentId})
    )` : sql`${invoices.stripe_connection_id} IS NULL AND ${invoices.stripe_account_id} IS NULL
      AND ${invoices.stripe_session_id} = ${input.sessionId}
      AND (${invoices.stripe_payment_intent_id} IS NULL OR ${invoices.stripe_payment_intent_id} = ${input.paymentIntentId})`}`;
  const canTransition = state === "paid" ? sql`1` : sql`EXISTS (
    SELECT 1 FROM invoice_checkout_attempts a WHERE a.id = ${input.attemptId}
      AND a.state IN ('creating', 'open', 'unknown'${state === "failed" ? sql`, 'processing'` : sql``})
  )`;
  const result = state === "paid"
    ? sql`CASE WHEN (${invoices.status} = 'paid' AND ${invoices.stripe_session_id} IS NOT ${input.sessionId})
          OR EXISTS (SELECT 1 FROM invoice_checkout_attempts a
            WHERE a.invoice_id = ${invoices.id} AND a.state = 'paid' AND a.stripe_session_id IS NOT ${input.sessionId})
          THEN 'duplicate_payment' WHEN ${invoices.status} = 'void' THEN 'void_payment' ELSE 'applied' END`
    : sql`CASE WHEN ${canTransition} THEN 'applied' ELSE 'ignored' END`;
  const freshReceipt = sql`EXISTS (
    SELECT 1 FROM stripe_webhook_events e WHERE e.event_key = ${eventKey} AND e.receipt_id = ${receiptId}
  )`;

  const [inserted] = await db.batch([
    db.insert(events).select(sql`
      SELECT ${eventKey}, ${accountId}, ${input.eventId}, ${input.eventType}, ${timestamp},
        ${input.endpointScope}, ${input.livemode}, ${input.invoiceId}, ${input.attemptId},
        ${input.sessionId}, ${input.paymentIntentId}, ${result}, ${receiptId},
        ${input.amountTotal}, ${input.currency!.toLowerCase()}, ${input.paymentStatus}
      FROM ${invoices} WHERE ${binding}
    `).onConflictDoNothing().returning(),
    db.update(attempts).set({
      state,
      stripe_payment_intent_id: sql`COALESCE(${attempts.stripe_payment_intent_id}, ${input.paymentIntentId})`,
      creation_claim_id: null, creation_lease_expires_at: null, updated_at: timestamp,
    }).where(and(eq(attempts.id, input.attemptId ?? ""), freshReceipt,
      state === "paid" ? sql`1` : canTransition,
    )),
    db.update(invoices).set({
      status: "paid", stripe_void_pending: false,
      stripe_session_id: input.sessionId, stripe_payment_intent_id: input.paymentIntentId,
      paid_at: timestamp, updated_at: timestamp,
    }).where(and(eq(invoices.id, input.invoiceId), eq(invoices.status, "sent"),
      state === "paid" ? sql`1` : sql`0`, freshReceipt,
      sql`EXISTS (SELECT 1 FROM stripe_webhook_events e
        WHERE e.event_key = ${eventKey} AND e.receipt_id = ${receiptId} AND e.result = 'applied')`,
    )),
  ]);
  if (inserted[0]) return { kind: "processed", result: inserted[0].result as InvoicePaymentReceiptResult };
  const [existing] = await db.select({ result: events.result }).from(events).where(eq(events.event_key, eventKey));
  return existing ? { kind: "duplicate", result: existing.result as InvoicePaymentReceiptResult }
    : { kind: "retryable", reason: "binding_changed" };
}
