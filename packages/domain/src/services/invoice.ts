import { eq, and, desc, sql, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  invoices,
  invoiceLineItems,
  stripeConnections,
} from "../db/schema.js";
import { beginInvoiceVoid, finalizeInvoiceVoid } from "./invoicePayment.js";
import type {
  Invoice,
  InvoiceLineItem,
  InvoiceStatus,
  InvoiceWithLineItems,
  PaginatedResult,
} from "../types.js";
import type { InvoiceCurrency } from "../invoice-currency.js";
import {
  ConflictError,
  InvalidStateTransitionError,
  NoReadyStripeConnectionError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { invoiceCurrencySchema } from "../invoice-currency.js";

/**
 * Result of attempting to mark an invoice paid via the Stripe webhook.
 * - `paid`: state successfully transitioned (or was already paid; idempotent).
 * - `unknown_token`: no invoice with this pay_token. Caller should ack.
 * - `void`: invoice was voided; we refuse to flip it back to paid.
 *   This happens if a customer pays after the issuer voids the invoice
 *   (e.g. async payment methods completing post-void). Surface for ops.
 * - `amount_mismatch`: the Stripe session amount_total does not match the
 *   invoice total (or currency disagrees). The session is from somewhere we
 *   don't trust; do NOT mark paid.
 */
export type MarkPaidResult =
  | { kind: "paid"; invoice: Invoice }
  | { kind: "unknown_token" }
  | { kind: "void"; invoice: Invoice }
  | {
      kind: "amount_mismatch";
      expectedAmount: number;
      expectedCurrency: string;
      gotAmount: number | null;
      gotCurrency: string | null;
    };

export type InvoiceLineItemInput = {
  description: string;
  quantity: number;
  unit_price: number;
};

export type CreateInvoiceInput = {
  userId: string;
  currency?: InvoiceCurrency;
  client_name: string;
  client_email: string;
  client_address?: string | null;
  notes?: string | null;
  due_date: string;
  tax_amount?: number;
  line_items: InvoiceLineItemInput[];
};

export type UpdateInvoiceInput = {
  currency?: InvoiceCurrency;
  client_name?: string;
  client_email?: string;
  client_address?: string | null;
  notes?: string | null;
  due_date?: string;
  tax_amount?: number;
  line_items?: InvoiceLineItemInput[];
};

const NUMBER_PREFIX = "INV-";
const NUMBER_PAD = 4;

function formatInvoiceNumber(seq: number): string {
  return `${NUMBER_PREFIX}${String(seq).padStart(NUMBER_PAD, "0")}`;
}

function parseInvoiceNumber(num: string): number {
  if (!num.startsWith(NUMBER_PREFIX)) return 0;
  const n = parseInt(num.slice(NUMBER_PREFIX.length), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns the next invoice number for a user. Per-user sequential.
 * Uses MAX(invoice_number)+1. The unique index on (user_id, invoice_number)
 * protects against accidental duplicates; callers retry on conflict.
 */
export async function getNextInvoiceNumber(
  db: Database,
  userId: string,
): Promise<string> {
  const rows = await db
    .select({ invoice_number: invoices.invoice_number })
    .from(invoices)
    .where(eq(invoices.user_id, userId));

  let max = 0;
  for (const row of rows) {
    const n = parseInvoiceNumber(row.invoice_number);
    if (n > max) max = n;
  }
  return formatInvoiceNumber(max + 1);
}

function generatePayToken(): string {
  return `qsi_${crypto.randomUUID().replace(/-/g, "")}${crypto
    .randomUUID()
    .replace(/-/g, "")}`;
}

function computeLineTotal(item: InvoiceLineItemInput): number {
  // Round to nearest cent.
  return Math.round(item.quantity * item.unit_price);
}

function computeSubtotal(items: InvoiceLineItemInput[]): number {
  return items.reduce((acc, item) => acc + computeLineTotal(item), 0);
}

function validateInvoiceCurrency(currency: unknown): InvoiceCurrency {
  const result = invoiceCurrencySchema.safeParse(currency);
  if (!result.success) {
    throw new ValidationError("Invoice currency must be USD or EUR");
  }
  return result.data;
}

export async function createDraftInvoice(
  db: Database,
  input: CreateInvoiceInput,
): Promise<InvoiceWithLineItems> {
  const currency =
    input.currency === undefined
      ? "USD"
      : validateInvoiceCurrency(input.currency);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const taxAmount = input.tax_amount ?? 0;
  const subtotal = computeSubtotal(input.line_items);
  const total = subtotal + taxAmount;
  const payToken = generatePayToken();

  // Retry on rare invoice_number conflict
  let attempts = 0;
  while (true) {
    attempts++;
    const invoiceNumber = await getNextInvoiceNumber(db, input.userId);

    try {
      await db.batch([
        db.insert(invoices).values({
          id,
          user_id: input.userId,
          invoice_number: invoiceNumber,
          pay_token: payToken,
          status: "draft",
          client_name: input.client_name,
          client_email: input.client_email,
          client_address: input.client_address ?? null,
          subtotal,
          tax_amount: taxAmount,
          total,
          currency,
          notes: input.notes ?? null,
          due_date: input.due_date,
          created_at: now,
          updated_at: now,
        }),
        ...input.line_items.map((item, idx) =>
          db.insert(invoiceLineItems).values({
            id: crypto.randomUUID(),
            invoice_id: id,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            line_total: computeLineTotal(item),
            position: idx,
            created_at: now,
          }),
        ),
      ]);
      break;
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE") &&
        e.message.includes("invoice_number") &&
        attempts < 3
      ) {
        // Race with another insert; pick a new number and retry
        continue;
      }
      throw e;
    }
  }

  const created = await getInvoice(db, id, input.userId);
  if (!created) throw new NotFoundError("Invoice", id);
  return created;
}

export async function getInvoice(
  db: Database,
  invoiceId: string,
  userId: string,
): Promise<InvoiceWithLineItems | null> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId)));
  if (!row) return null;

  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoice_id, invoiceId))
    .orderBy(invoiceLineItems.position);

  return {
    ...(row as Invoice),
    line_items: items as InvoiceLineItem[],
  };
}

export async function getInvoiceByPayToken(
  db: Database,
  token: string,
): Promise<InvoiceWithLineItems | null> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.pay_token, token));
  if (!row) return null;

  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoice_id, row.id))
    .orderBy(invoiceLineItems.position);

  return {
    ...(row as Invoice),
    line_items: items as InvoiceLineItem[],
  };
}

export async function listInvoices(
  db: Database,
  userId: string,
  opts: { status?: InvoiceStatus; limit?: number; offset?: number } = {},
): Promise<PaginatedResult<Invoice>> {
  const { status, limit = 20, offset = 0 } = opts;

  const conditions: SQL[] = [eq(invoices.user_id, userId)];
  if (status) conditions.push(eq(invoices.status, status));
  const where = and(...conditions);

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(desc(invoices.created_at))
      .limit(limit)
      .offset(offset) as Promise<Invoice[]>,
    db.select({ total: count() }).from(invoices).where(where),
  ]);

  return { items, total, limit, offset };
}

export async function updateDraftInvoice(
  db: Database,
  invoiceId: string,
  userId: string,
  fields: UpdateInvoiceInput,
): Promise<InvoiceWithLineItems> {
  const currency =
    fields.currency === undefined
      ? undefined
      : validateInvoiceCurrency(fields.currency);
  const existing = await getInvoice(db, invoiceId, userId);
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status !== "draft") {
    throw new ConflictError("Only draft invoices can be edited");
  }

  const now = new Date().toISOString();
  const newLineItems = fields.line_items;
  const taxAmount = fields.tax_amount ?? existing.tax_amount;

  const updates: Record<string, unknown> = { updated_at: now };
  if (fields.client_name !== undefined) updates.client_name = fields.client_name;
  if (fields.client_email !== undefined) updates.client_email = fields.client_email;
  if (fields.client_address !== undefined)
    updates.client_address = fields.client_address;
  if (fields.notes !== undefined) updates.notes = fields.notes;
  if (fields.due_date !== undefined) updates.due_date = fields.due_date;
  if (fields.tax_amount !== undefined) updates.tax_amount = fields.tax_amount;
  if (currency !== undefined) updates.currency = currency;

  if (newLineItems) {
    const subtotal = computeSubtotal(newLineItems);
    const total = subtotal + taxAmount;
    updates.subtotal = subtotal;
    updates.total = total;
  } else if (fields.tax_amount !== undefined) {
    updates.total = existing.subtotal + taxAmount;
  }

  const editable = and(
    eq(invoices.id, invoiceId),
    eq(invoices.user_id, userId),
    eq(invoices.status, "draft"),
  )!;
  const update = db.update(invoices).set(updates).where(editable)
    .returning({ id: invoices.id });
  let updatedIds: { id: string }[];

  if (newLineItems) {
    [updatedIds] = await db.batch([
      update,
      db.delete(invoiceLineItems).where(and(
        eq(invoiceLineItems.invoice_id, invoiceId),
        sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${editable})`,
      )),
      ...newLineItems.map((item, idx) =>
        db.insert(invoiceLineItems).select(sql`
          SELECT ${crypto.randomUUID()}, ${invoices.id}, ${item.description},
            ${item.quantity}, ${item.unit_price}, ${computeLineTotal(item)}, ${idx}, ${now}
          FROM ${invoices} WHERE ${editable}
        `),
      ),
    ]);
  } else {
    [updatedIds] = await db.batch([update]);
  }
  if (updatedIds.length !== 1) {
    throw new ConflictError("Only draft invoices can be edited");
  }

  const updated = await getInvoice(db, invoiceId, userId);
  if (!updated) throw new NotFoundError("Invoice", invoiceId);
  return updated;
}

/**
 * Delete an invoice. Only `draft` and `void` invoices can be deleted.
 * Sent or paid invoices must be voided first to preserve an audit trail and
 * avoid breaking active Stripe Checkout sessions.
 *
 * Line items are removed automatically via the `ON DELETE CASCADE` foreign key.
 */
export async function deleteInvoice(
  db: Database,
  invoiceId: string,
  userId: string,
): Promise<void> {
  const existing = await getInvoice(db, invoiceId, userId);
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status !== "draft" && existing.status !== "void") {
    throw new ConflictError(
      "Only draft or void invoices can be deleted. Void the invoice first.",
    );
  }
  const deleted = await db
    .delete(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.user_id, userId),
      sql`${invoices.status} IN ('draft', 'void') AND ${invoices.stripe_void_pending} = 0`,
      sql`NOT EXISTS (SELECT 1 FROM invoice_checkout_attempts a WHERE a.invoice_id = ${invoices.id})`,
      sql`NOT EXISTS (SELECT 1 FROM stripe_webhook_events e WHERE e.invoice_id = ${invoices.id})`,
      sql`NOT EXISTS (SELECT 1 FROM invoice_legacy_session_evidence e WHERE e.invoice_id = ${invoices.id})`,
    )).returning({ id: invoices.id });
  if (deleted.length !== 1) throw new ConflictError("Resolve pending payments or retain this invoice's payment history before deleting it");
}

/** Transition draft -> sent. Returns the updated invoice for email caller. */
export async function markInvoiceSent(
  db: Database,
  invoiceId: string,
  userId: string,
  expectedLivemode: boolean,
  refreshedConnection?: { connectionId: string; expectedAuthorizationRevision: string },
): Promise<InvoiceWithLineItems> {
  const existing = await getInvoice(db, invoiceId, userId);
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status === "sent") return existing; // idempotent
  if (existing.status !== "draft") {
    throw new InvalidStateTransitionError(existing.status, "sent");
  }
  const now = new Date().toISOString();
  const result = await db.run(sql`
    WITH ready_connection AS (
      SELECT
        ${stripeConnections.id} AS connection_id,
        ${stripeConnections.stripe_account_id} AS account_id,
        ${stripeConnections.livemode} AS livemode
      FROM ${stripeConnections}
      WHERE ${stripeConnections.user_id} = ${userId}
        AND ${stripeConnections.livemode} = ${expectedLivemode}
        AND ${refreshedConnection === undefined ? sql`1` : sql`${stripeConnections.id} = ${refreshedConnection.connectionId}
          AND ${stripeConnections.authorization_revision} = ${refreshedConnection.expectedAuthorizationRevision}`}
        AND ${stripeConnections.disconnected_at} IS NULL
        AND ${stripeConnections.disconnect_operation_id} IS NULL
        AND ${stripeConnections.disconnect_started_at} IS NULL
        AND (${stripeConnections.livemode} = 0 OR (
          ${stripeConnections.details_submitted} = 1
          AND ${stripeConnections.charges_enabled} = 1
          AND ${stripeConnections.payouts_enabled} = 1
        ))
      LIMIT 1
    )
    UPDATE ${invoices}
    SET
      status = 'sent',
      issued_at = ${now},
      updated_at = ${now},
      stripe_connection_id = (SELECT connection_id FROM ready_connection),
      stripe_account_id = (SELECT account_id FROM ready_connection),
      stripe_livemode = (SELECT livemode FROM ready_connection),
      stripe_charge_scope = 'connected'
    WHERE ${invoices.id} = ${invoiceId}
      AND ${invoices.user_id} = ${userId}
      AND ${invoices.status} = 'draft'
      AND EXISTS (SELECT 1 FROM ready_connection)
  `);

  const updated = await getInvoice(db, invoiceId, userId);
  if (!updated) throw new NotFoundError("Invoice", invoiceId);
  if (result.meta.changes !== 1) {
    if (updated.status === "sent") return updated;
    if (updated.status !== "draft") {
      throw new InvalidStateTransitionError(updated.status, "sent");
    }
    throw new NoReadyStripeConnectionError();
  }
  return updated;
}

export async function voidInvoice(
  db: Database,
  invoiceId: string,
  userId: string,
): Promise<InvoiceWithLineItems> {
  const existing = await getInvoice(db, invoiceId, userId);
  if (!existing) throw new NotFoundError("Invoice", invoiceId);
  if (existing.status === "void") return existing;
  if (existing.status === "paid") {
    throw new InvalidStateTransitionError("paid", "void");
  }
  await beginInvoiceVoid(db, invoiceId, userId);
  await finalizeInvoiceVoid(db, invoiceId, userId);

  const updated = await getInvoice(db, invoiceId, userId);
  if (!updated) throw new NotFoundError("Invoice", invoiceId);
  return updated;
}

/**
 * Called by the Stripe webhook on successful checkout. Verifies the
 * Stripe-reported amount and currency match what we issued before flipping
 * status to paid. Idempotent on repeat events for the same already-paid
 * invoice; refuses to transition `void -> paid`.
 *
 * SECURITY: We do not trust `metadata.pay_token` alone — Stripe signs the
 * webhook payload, but the application logic must independently verify
 * that the session paid the right amount in the right currency. Otherwise
 * a future code path (promo code, partial payment, separate Checkout
 * flow) that creates a discounted session for the same pay_token could
 * silently mark the invoice paid for less.
 */
export async function markInvoicePaidByPayToken(
  db: Database,
  payToken: string,
  payment: {
    stripeSessionId?: string;
    stripePaymentIntentId?: string;
    /** session.amount_total from Stripe, in the smallest currency unit. */
    amountTotal: number | null;
    /** session.currency from Stripe (lowercase, e.g. "usd"). */
    currency: string | null;
  },
): Promise<MarkPaidResult> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.pay_token, payToken));
  if (!row) return { kind: "unknown_token" };

  // Refuse to flip a voided invoice back to paid. A late async payment
  // after the issuer voided is an ops issue (refund the customer); we
  // must not silently re-activate the invoice.
  if (row.status === "void") {
    return { kind: "void", invoice: row as Invoice };
  }

  // Verify amount + currency before trusting any state transition. This
  // also guards the idempotent re-entry path below — a duplicate event
  // for an already-paid invoice still must match the original amount.
  const expectedCurrency = row.currency.toLowerCase();
  const gotCurrency = payment.currency?.toLowerCase() ?? null;
  if (
    payment.amountTotal !== row.total ||
    gotCurrency !== expectedCurrency
  ) {
    return {
      kind: "amount_mismatch",
      expectedAmount: row.total,
      expectedCurrency,
      gotAmount: payment.amountTotal,
      gotCurrency,
    };
  }

  if (row.status === "paid") return { kind: "paid", invoice: row as Invoice }; // idempotent

  const now = new Date().toISOString();
  await db
    .update(invoices)
    .set({
      status: "paid",
      paid_at: now,
      updated_at: now,
      stripe_session_id: payment.stripeSessionId ?? row.stripe_session_id,
      stripe_payment_intent_id:
        payment.stripePaymentIntentId ?? row.stripe_payment_intent_id,
    })
    .where(eq(invoices.id, row.id));

  const [updated] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, row.id));
  return { kind: "paid", invoice: updated as Invoice };
}

/** Stash a Stripe Checkout session id on the invoice. Public path. */
export async function attachStripeSession(
  db: Database,
  payToken: string,
  sessionId: string,
): Promise<void> {
  await db
    .update(invoices)
    .set({
      stripe_session_id: sessionId,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(invoices.pay_token, payToken));
}
