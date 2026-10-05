import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb, type Database } from "../src/db/index.js";
import { invoiceCheckoutAttempts, invoiceLegacySessionEvidence, invoices as invoiceRows, stripeConnections, stripeWebhookEvents, users } from "../src/db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/errors.js";
import { createDraftInvoice, markInvoiceSent, voidInvoice, deleteInvoice } from "../src/services/invoice.js";
import { deleteUser } from "../src/services/auth.js";
import * as connections from "../src/services/stripeConnection.js";
import * as payments from "../src/services/invoicePayment.js";
import type { Invoice, InvoiceCheckoutAttempt } from "../src/types.js";
import { applyPaymentMigrations } from "./helpers/migrations.js";

const now = new Date("2026-10-02T12:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const db = () => createDb(env.PAYMENT_DB);

beforeAll(async () => {
  await applyD1Migrations(env.PAYMENT_DB, env.TEST_MIGRATIONS.filter((migration) => migration.name < "0008"));
  await env.PAYMENT_DB.prepare(`INSERT INTO users (id, name, email, created_at, updated_at)
    VALUES ('ledger-upgrade-user', 'Upgrade', 'ledger-upgrade@example.com', 0, 0)`).run();
  await env.PAYMENT_DB.prepare(`INSERT INTO invoices
    (id, user_id, invoice_number, pay_token, status, client_name, client_email, total, due_date, issued_at, stripe_session_id)
    VALUES ('ledger-upgrade-invoice', 'ledger-upgrade-user', 'INV-0001', 'ledger-upgrade-token',
      'sent', 'Client', 'client@example.com', 1500, '2026-11-01', '2026-10-01', 'cs_platform_existing')`).run();
  await env.PAYMENT_DB.prepare(`INSERT INTO invoices
    (id, user_id, invoice_number, pay_token, status, client_name, client_email, total, due_date, issued_at)
    VALUES ('upgrade-sessionless', 'ledger-upgrade-user', 'INV-0002', 'upgrade-sessionless-token',
      'sent', 'Client', 'client@example.com', 1500, '2026-11-01', '2026-10-01')`).run();
  for (const variant of ["matching", "amount", "currency", "livemode", "session", "session-mode"]) {
    await env.PAYMENT_DB.prepare(`INSERT INTO invoices
      (id, user_id, invoice_number, pay_token, status, client_name, client_email, total, currency,
        due_date, issued_at, paid_at, stripe_session_id, stripe_payment_intent_id)
      VALUES (?, 'ledger-upgrade-user', ?, ?, 'paid', 'Client', 'client@example.com', 1500, 'USD',
        '2026-11-01', '2026-10-01', '2026-10-01T12:00:00.000Z', ?, ?)`)
      .bind(`upgrade-paid-${variant}`, `INV-PAID-${variant}`, `upgrade-paid-token-${variant}`,
        `cs_platform_original_${variant}`, `pi_platform_original_${variant}`).run();
  }
  await applyD1Migrations(env.PAYMENT_DB, env.TEST_MIGRATIONS.filter((migration) => migration.name < "0013"));
  await env.PAYMENT_DB.prepare("UPDATE invoices SET stripe_checkout_attempt = 7 WHERE id = 'ledger-upgrade-invoice'").run();
  await applyPaymentMigrations();
});

function buildRequest({ attemptId, generation, invoice }: payments.CheckoutRequestContext) {
  return JSON.stringify({
    mode: "payment",
    metadata: { invoice_id: invoice.id, checkout_attempt_id: attemptId, pay_token: invoice.pay_token, generation: String(generation) },
    line_items: [{ price_data: { currency: invoice.currency.toLowerCase(), unit_amount: invoice.total, product_data: { name: invoice.invoice_number } }, quantity: 1 }],
    success_url: "https://example.com/paid",
    cancel_url: "https://example.com/cancel",
  });
}

async function newInvoice(database: Database, userId: string, livemode = false) {
  const draft = await createDraftInvoice(database, {
    userId, client_name: "Client", client_email: "client@example.com", due_date: "2026-11-01",
    line_items: [{ description: "Consulting", quantity: 1, unit_price: 1500 }],
  });
  return markInvoiceSent(database, draft.id, userId, livemode);
}

async function fixture(livemode = false) {
  const database = db();
  const userId = crypto.randomUUID();
  await database.insert(users).values({ id: userId, name: "Issuer", email: `${userId}@example.com`, createdAt: now, updatedAt: now });
  const connection = {
    id: crypto.randomUUID(), user_id: userId, stripe_account_id: `acct_${crypto.randomUUID()}`, livemode,
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
    authorization_revision: crypto.randomUUID(), stripe_status_at: now.toISOString(),
  };
  await database.insert(stripeConnections).values(connection);
  const invoice = await newInvoice(database, userId, livemode);
  const input = { payToken: invoice.pay_token, livemode, buildRequest };
  return { database, userId, connection, invoice, input };
}

function scope(attempt: InvoiceCheckoutAttempt): payments.CheckoutAttemptScope {
  return { attemptId: attempt.id, stripeAccountId: attempt.stripe_account_id, livemode: attempt.livemode };
}

async function claim(database: Database, attempt: InvoiceCheckoutAttempt, time = now) {
  const result = await payments.claimCheckoutCreation(database, scope(attempt), time);
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed") throw new ConflictError("Expected checkout creation claim");
  return result;
}

async function open(f: Awaited<ReturnType<typeof fixture>>, sessionId = `cs_${crypto.randomUUID()}`) {
  const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
  const { claimId } = await claim(f.database, attempt);
  const attached = await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId, sessionId }, now);
  expect(attached).not.toBeNull();
  return attached!;
}

function event(invoice: Invoice, attempt: InvoiceCheckoutAttempt | null, overrides: Partial<payments.InvoicePaymentEventInput> = {}): payments.InvoicePaymentEventInput {
  return {
    eventId: `evt_${crypto.randomUUID()}`, eventType: "checkout.session.completed",
    endpointScope: attempt ? "connected" : "platform", expectedLivemode: invoice.stripe_livemode ?? false,
    stripeAccountId: attempt?.stripe_account_id ?? null, livemode: invoice.stripe_livemode ?? false,
    invoiceId: invoice.id, attemptId: attempt?.id ?? null, payToken: invoice.pay_token,
    sessionId: attempt?.stripe_session_id ?? invoice.stripe_session_id ?? "cs_early",
    paymentIntentId: `pi_${crypto.randomUUID()}`, amountTotal: invoice.total, currency: invoice.currency.toLowerCase(),
    sessionMode: "payment", sessionStatus: "complete", paymentStatus: "paid", ...overrides,
  };
}

const expired = { eventType: "checkout.session.expired", sessionStatus: "expired", paymentStatus: "unpaid", paymentIntentId: null } as const;

async function legacyInvoice(f: Awaited<ReturnType<typeof fixture>>, livemode: boolean | null) {
  const row = {
    ...f.invoice, id: crypto.randomUUID(), invoice_number: `INV-LEGACY-${crypto.randomUUID()}`, pay_token: crypto.randomUUID(),
    stripe_charge_scope: "platform", stripe_connection_id: null, stripe_account_id: null, stripe_livemode: livemode,
    stripe_session_id: `cs_legacy_${crypto.randomUUID()}`,
  };
  const { line_items: _, ...values } = row;
  await f.database.insert(invoiceRows).values(values);
  return row as Invoice;
}

describe("invoice checkout ledger migrations", () => {

  it("applies the actual SQL migration chain including the checkout ledger", async () => {
    const migrations = await env.PAYMENT_DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
    expect(migrations.results.map((migration) => migration.name)).toEqual(env.TEST_MIGRATIONS.map((migration) => migration.name));
    expect(migrations.results.at(-1)?.name).toBe("0015_stripe_environment_readiness.sql");
    const columns = await env.PAYMENT_DB.prepare("PRAGMA table_info(invoice_checkout_attempts)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("request_json");
  });

  it("preserves pre-ledger sessions/counters and leaves historical platform mode unclassified", async () => {
    const [invoice] = await db().select().from(invoiceRows).where(eq(invoiceRows.id, "ledger-upgrade-invoice"));
    expect(invoice).toMatchObject({ stripe_session_id: "cs_platform_existing", stripe_checkout_attempt: 7, stripe_charge_scope: "platform", stripe_livemode: null, stripe_void_pending: false });
    expect(await db().select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, invoice.id))).toEqual([]);
  });

  it("enforces request/snapshot/time immutability and restricts deletion of financial audit parents", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await claim(f.database, attempt);
    await expect(f.database.update(invoiceCheckoutAttempts).set({ request_json: "{}" }).where(eq(invoiceCheckoutAttempts.id, attempt.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
    await expect(f.database.update(invoiceCheckoutAttempts).set({ retry_until: later(999999999).toISOString() }).where(eq(invoiceCheckoutAttempts.id, attempt.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
    await expect(f.database.update(invoiceRows).set({ total: 1 }).where(eq(invoiceRows.id, f.invoice.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
    await expect(f.database.update(invoiceRows).set({ stripe_account_id: "acct_foreign" }).where(eq(invoiceRows.id, f.invoice.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
    await expect(f.database.delete(invoiceRows).where(eq(invoiceRows.id, f.invoice.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("FOREIGN KEY") } });
    await expect(f.database.delete(stripeConnections).where(eq(stripeConnections.id, f.connection.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("FOREIGN KEY") } });
  });

  it("enforces the next generation and the one-active-attempt index at the database level", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await expect(f.database.insert(invoiceCheckoutAttempts).values({ ...attempt, id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), generation: 2 })).rejects.toMatchObject({ cause: { message: expect.stringContaining("UNIQUE") } });
    await expect(f.database.insert(invoiceCheckoutAttempts).values({ ...attempt, id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })).rejects.toMatchObject({ cause: { message: expect.stringContaining("advance the invoice counter") } });
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice.stripe_checkout_attempt).toBe(1);
  });
});

describe("checkout reservation and creation leases", () => {
  it("rejects a refreshed authorization revision that has since changed", async () => {
    const f = await fixture();
    await expect(payments.reserveCheckoutAttempt(f.database, {
      ...f.input, expectedAuthorizationRevision: "stale-revision",
    }, now)).rejects.toBeInstanceOf(ConflictError);
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toEqual([]);
  });

  it("guards creation claims against reconnects after readiness refresh", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const result = await payments.claimCheckoutCreation(f.database, {
      ...scope(attempt), expectedAuthorizationRevision: "stale-revision",
    }, now);
    expect(result.kind).toBe("not_creatable");
    expect((await payments.getCheckoutAttempt(f.database, scope(attempt)))?.first_creation_started_at).toBeNull();
  });

  it("retrieves the latest attempt for reconciliation even after authorization revocation", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await f.database.update(stripeConnections).set({ disconnected_at: later(10).toISOString() }).where(eq(stripeConnections.id, f.connection.id));
    expect(await payments.getLatestCheckoutAttempt(f.database, f.invoice.id)).toEqual(attempt);
    expect(await payments.getLatestCheckoutAttempt(f.database, "missing-invoice")).toBeNull();
  });

  it("binds draft sending to the exact refreshed connection and authorization revision", async () => {
    const f = await fixture();
    const draft = await createDraftInvoice(f.database, {
      userId: f.userId, client_name: "Client", client_email: "client@example.com", due_date: "2026-11-01",
      line_items: [{ description: "Consulting", quantity: 1, unit_price: 1500 }],
    });
    await expect(markInvoiceSent(f.database, draft.id, f.userId, false, {
      connectionId: f.connection.id, expectedAuthorizationRevision: "stale-revision",
    })).rejects.toMatchObject({ code: "NO_READY_STRIPE_CONNECTION" });
    expect((await markInvoiceSent(f.database, draft.id, f.userId, false, {
      connectionId: f.connection.id, expectedAuthorizationRevision: f.connection.authorization_revision,
    })).stripe_account_id).toBe(f.connection.stripe_account_id);
  });

  it("concurrent reservations return one active UUID/generation and increment the invoice counter once", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => payments.reserveCheckoutAttempt(f.database, f.input, now)));
    expect(new Set(results.map((attempt) => attempt.id)).size).toBe(1);
    expect(results[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(results[0]).toMatchObject({ generation: 1, state: "creating", stripe_account_id: f.connection.stripe_account_id, livemode: false, charge_scope: "connected" });
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toHaveLength(1);
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice.stripe_checkout_attempt).toBe(1);
  });

  it("keeps exact request bytes, idempotency key and account on retry without rebuilding", async () => {
    const f = await fixture();
    const builder = vi.fn((context: payments.CheckoutRequestContext) => `  ${buildRequest(context)}\n`);
    const original = await payments.reserveCheckoutAttempt(f.database, { ...f.input, buildRequest: builder }, now);
    const first = await claim(f.database, original);
    await payments.recordCheckoutCreationFailure(f.database, { ...scope(original), claimId: first.claimId, outcome: "unknown" }, later(10));
    const unusedBuilder = vi.fn(() => "{}");
    const retried = await payments.reserveCheckoutAttempt(f.database, { ...f.input, buildRequest: unusedBuilder }, later(100));
    expect(unusedBuilder).not.toHaveBeenCalled();
    expect(retried.request_json).toBe(builder.mock.results[0].value);
    expect(retried.idempotency_key).toBe(original.idempotency_key);
    expect(retried.stripe_account_id).toBe(original.stripe_account_id);
    expect(JSON.parse(retried.request_json).metadata.checkout_attempt_id).toBe(original.id);
    const second = await claim(f.database, original, later(100));
    expect(second.attempt.retry_until).toBe(first.attempt.retry_until);
    expect(second.attempt.first_creation_started_at).toBe(first.attempt.first_creation_started_at);
  });

  it("concurrent claims allow only one creator and a scoped lease protects against stale attachment", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const claims = await Promise.all(Array.from({ length: 6 }, () => payments.claimCheckoutCreation(f.database, scope(attempt), now)));
    expect(claims.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((result) => result.kind === "busy")).toHaveLength(5);
    const original = claims.find((result) => result.kind === "claimed")!;
    const replacement = await claim(f.database, attempt, later(payments.CHECKOUT_CREATION_LEASE_MS));
    expect(await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: original.claimId, sessionId: "cs_stale" }, later(61000))).toBeNull();
    const attached = await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: replacement.claimId, sessionId: "cs_current" }, later(61000));
    expect(attached).toMatchObject({ state: "open", stripe_session_id: "cs_current" });
  });

  it.each(["recorded unknown", "reclaimed lease"])("never frees prior ambiguity after %s and a retry's not-created report", async (history) => {
    const f = await fixture();
    const original = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const first = await claim(f.database, original);
    if (history === "recorded unknown") {
      await payments.recordCheckoutCreationFailure(f.database, {
        ...scope(original), claimId: first.claimId, outcome: "unknown",
      }, later(10));
    }
    const retryTime = payments.CHECKOUT_CREATION_LEASE_MS + 1;
    const retry = await claim(f.database, original, later(retryTime));
    const failure = await payments.recordCheckoutCreationFailure(f.database, {
      ...scope(original), claimId: retry.claimId, outcome: "not_created",
    }, later(retryTime + 1));
    const unusedBuilder = vi.fn(() => "{}");
    const subsequent = await payments.reserveCheckoutAttempt(f.database, {
      ...f.input, buildRequest: unusedBuilder,
    }, later(retryTime + 2));

    expect(failure?.state).toBe("unknown");
    expect(retry.attempt.state).toBe("unknown");
    expect(subsequent).toMatchObject({ id: original.id, generation: original.generation,
      stripe_account_id: original.stripe_account_id, request_json: original.request_json, idempotency_key: original.idempotency_key });
    expect(subsequent.first_creation_started_at).toBe(first.attempt.first_creation_started_at);
    expect(subsequent.retry_until).toBe(first.attempt.retry_until);
    expect(unusedBuilder).not.toHaveBeenCalled();
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toHaveLength(1);
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice.stripe_checkout_attempt).toBe(1);
    const subsequentClaim = await claim(f.database, subsequent, later(retryTime + 3));
    expect(subsequentClaim.attempt).toMatchObject({ id: original.id, generation: 1, state: "unknown",
      stripe_account_id: original.stripe_account_id, request_json: original.request_json, idempotency_key: original.idempotency_key });
  });

  it("persists unknown and blocks creation permanently across the idempotency cutoff", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await claim(f.database, attempt);
    const elapsed = await payments.claimCheckoutCreation(f.database, scope(attempt), later(payments.CHECKOUT_RETRY_WINDOW_MS));
    expect(elapsed).toMatchObject({ kind: "retry_window_elapsed", attempt: { state: "unknown", creation_claim_id: null } });
    const same = await payments.reserveCheckoutAttempt(f.database, f.input, later(2 * payments.CHECKOUT_RETRY_WINDOW_MS));
    expect(same.id).toBe(attempt.id);
    expect(same.generation).toBe(1);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), later(2 * payments.CHECKOUT_RETRY_WINDOW_MS))).kind).toBe("retry_window_elapsed");
  });

  it("does not give a lease that could cross the retry cutoff", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await claim(f.database, attempt);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), later(payments.CHECKOUT_RETRY_WINDOW_MS - payments.CHECKOUT_CREATION_LEASE_MS))).kind).toBe("retry_window_elapsed");
  });

  it("advances from the pre-existing counter only after a definitive not-created outcome", async () => {
    const f = await fixture();
    await f.database.update(invoiceRows).set({ stripe_checkout_attempt: 7 }).where(eq(invoiceRows.id, f.invoice.id));
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    expect(attempt.generation).toBe(8);
    const first = await claim(f.database, attempt);
    expect(await payments.recordCheckoutCreationFailure(f.database, { ...scope(attempt), claimId: "wrong", outcome: "not_created" })).toBeNull();
    expect((await payments.reserveCheckoutAttempt(f.database, f.input, now)).id).toBe(attempt.id);
    await payments.recordCheckoutCreationFailure(f.database, { ...scope(attempt), claimId: first.claimId, outcome: "not_created" }, later(10));
    const next = await payments.reserveCheckoutAttempt(f.database, f.input, later(11));
    expect(next.generation).toBe(9);
    expect(next.idempotency_key).not.toBe(attempt.idempotency_key);
  });

  it.each(["expired", "failed"] as const)("allows a new generation only after a confirmed %s session", async (state) => {
    const f = await fixture();
    const attempt = await open(f);
    const observation = state === "expired" ? expired : { eventType: "checkout.session.async_payment_failed", sessionStatus: "complete", paymentStatus: "unpaid", paymentIntentId: null } as const;
    expect(await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, observation), now)).toEqual({ kind: "processed", result: "applied" });
    const next = await payments.reserveCheckoutAttempt(f.database, f.input, later(10));
    expect(next.generation).toBe(2);
    expect(next.id).not.toBe(attempt.id);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), later(100000))).kind).toBe("not_creatable");
  });

  it("processing blocks a new charge even after a delayed expiration event", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, { paymentStatus: "unpaid", paymentIntentId: null }), now);
    expect(await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, expired), now)).toEqual({ kind: "processed", result: "ignored" });
    const same = await payments.reserveCheckoutAttempt(f.database, f.input, later(100000000));
    expect(same).toMatchObject({ id: attempt.id, generation: 1, state: "processing" });
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), later(100000000))).kind).toBe("not_creatable");
  });

  it("releases a server-confirmed expired session without waiting for the expiration webhook", async () => {
    const f = await fixture();
    const attempt = await open(f);
    const observation = { ...scope(attempt), sessionId: attempt.stripe_session_id!, sessionLivemode: false, sessionStatus: "expired", paymentStatus: "unpaid" } as const;
    await expect(payments.recordCheckoutSessionExpiration(f.database, { ...observation, sessionLivemode: true }, now)).rejects.toBeInstanceOf(ValidationError);
    expect(await payments.recordCheckoutSessionExpiration(f.database, { ...observation, sessionId: "cs_wrong" }, now)).toBeNull();
    expect(await payments.recordCheckoutSessionExpiration(f.database, observation, now)).toMatchObject({ state: "expired" });
    expect((await payments.reserveCheckoutAttempt(f.database, f.input, now)).generation).toBe(2);
  });

  it("a processing session cannot be released by a stale server expiration observation", async () => {
    const f = await fixture();
    const attempt = await open(f);
    const processing = event(f.invoice, attempt, { paymentStatus: "unpaid", paymentIntentId: "pi_processing" });
    await payments.processInvoicePaymentEvent(f.database, processing, now);
    expect(await payments.recordCheckoutSessionExpiration(f.database, { ...scope(attempt), sessionId: attempt.stripe_session_id!, sessionLivemode: false, sessionStatus: "expired", paymentStatus: "unpaid" }, now)).toBeNull();
    expect((await payments.reserveCheckoutAttempt(f.database, f.input, now)).state).toBe("processing");
    expect(await payments.processInvoicePaymentEvent(f.database, { ...processing, eventId: crypto.randomUUID(), eventType: "checkout.session.async_payment_failed" }, now)).toEqual({ kind: "processed", result: "applied" });
    expect((await payments.reserveCheckoutAttempt(f.database, f.input, now)).generation).toBe(2);
  });

  it.each(["draft", "void", "paid"] as const)("rejects a %s invoice and never allocates a checkout", async (status) => {
    const f = await fixture();
    await f.database.update(invoiceRows).set({ status }).where(eq(invoiceRows.id, f.invoice.id));
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocks a creation claim if an untracked payment session appears after reservation", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await f.database.update(invoiceRows).set({ stripe_session_id: "cs_untracked_race" }).where(eq(invoiceRows.id, f.invoice.id));
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), now)).kind).toBe("not_creatable");
  });

  it.each(["disconnected_at", "disconnect_operation_id", "disconnect_started_at", "charges_enabled", "payouts_enabled", "details_submitted"] as const)("rejects a live connection with %s and does not reserve", async (field) => {
    const f = await fixture(true);
    await f.database.update(stripeConnections).set({ [field]: field.endsWith("enabled") || field === "details_submitted" ? false : now.toISOString() }).where(eq(stripeConnections.id, f.connection.id));
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toEqual([]);
  });

  it.each(["disconnected_at", "disconnect_operation_id", "disconnect_started_at"] as const)("still rejects a sandbox connection with %s", async (field) => {
    const f = await fixture();
    await f.database.update(stripeConnections).set({ [field]: now.toISOString() }).where(eq(stripeConnections.id, f.connection.id));
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toEqual([]);
  });

  it("allows sandbox sending, reservation and creation claim with disabled flags through the actual migrations", async () => {
    const f = await fixture();
    await f.database.update(stripeConnections).set({ charges_enabled: false, payouts_enabled: false, details_submitted: false }).where(eq(stripeConnections.id, f.connection.id));
    const invoice = await newInvoice(f.database, f.userId);
    const attempt = await payments.reserveCheckoutAttempt(f.database, { ...f.input, payToken: invoice.pay_token }, now);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), now)).kind).toBe("claimed");
  });

  it.each(["charges_enabled", "payouts_enabled", "details_submitted"] as const)("the migrated send trigger rejects a live snapshot with %s disabled", async (field) => {
    const f = await fixture(true);
    const draft = await createDraftInvoice(f.database, { userId: f.userId, client_name: "Client", client_email: "client@example.com",
      due_date: "2026-11-01", line_items: [{ description: "Consulting", quantity: 1, unit_price: 1500 }] });
    await f.database.update(stripeConnections).set({ [field]: false }).where(eq(stripeConnections.id, f.connection.id));
    await expect(f.database.update(invoiceRows).set({ status: "sent", stripe_connection_id: f.connection.id,
      stripe_account_id: f.connection.stripe_account_id, stripe_livemode: true, stripe_charge_scope: "connected" })
      .where(eq(invoiceRows.id, draft.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("ready connected Stripe snapshot") } });
  });

  it("rechecks live readiness atomically at reservation and again at creation claim", async () => {
    const f = await fixture(true);
    const run = f.database.run.bind(f.database);
    const spy = vi.spyOn(f.database, "run").mockImplementationOnce((query) => {
      const pending = run(query);
      const execute = pending.execute.bind(pending);
      vi.spyOn(pending, "execute").mockImplementationOnce(async () => {
        await f.database.update(stripeConnections).set({ charges_enabled: false }).where(eq(stripeConnections.id, f.connection.id));
        return execute();
      });
      return pending;
    });
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    spy.mockRestore();
    await f.database.update(stripeConnections).set({ charges_enabled: true }).where(eq(stripeConnections.id, f.connection.id));
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await f.database.update(stripeConnections).set({ charges_enabled: false }).where(eq(stripeConnections.id, f.connection.id));
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), now)).kind).toBe("not_creatable");
  });

  it("rejects foreign ownership, wrong runtime mode, platform and incomplete snapshots", async () => {
    const f = await fixture();
    await expect(payments.reserveCheckoutAttempt(f.database, { ...f.input, livemode: true }, now)).rejects.toBeInstanceOf(ConflictError);
    const foreignUserId = crypto.randomUUID();
    await f.database.insert(users).values({ id: foreignUserId, name: "Other issuer", email: `${foreignUserId}@example.com`, createdAt: now, updatedAt: now });
    await f.database.update(stripeConnections).set({ user_id: foreignUserId }).where(eq(stripeConnections.id, f.connection.id));
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    const legacy = await legacyInvoice(await fixture(), null);
    await expect(payments.reserveCheckoutAttempt(db(), { ...f.input, payToken: legacy.pay_token }, now)).rejects.toBeInstanceOf(ConflictError);
    const complete = await fixture();
    const incomplete = { ...complete.invoice, id: crypto.randomUUID(), invoice_number: "INV-INCOMPLETE", pay_token: crypto.randomUUID(), stripe_connection_id: null, stripe_account_id: null, stripe_livemode: null, stripe_charge_scope: null };
    const { line_items: _, ...values } = incomplete;
    await complete.database.insert(invoiceRows).values(values);
    await expect(payments.reserveCheckoutAttempt(complete.database, { ...complete.input, payToken: incomplete.pay_token }, now)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects an untracked pre-existing checkout and invalid request JSON without changing the counter", async () => {
    const f = await fixture();
    await expect(payments.reserveCheckoutAttempt(f.database, { ...f.input, buildRequest: () => "[]" }, now)).rejects.toBeInstanceOf(ValidationError);
    await expect(payments.reserveCheckoutAttempt(f.database, { ...f.input, buildRequest: () => "invalid" }, now)).rejects.toBeInstanceOf(ValidationError);
    await f.database.update(invoiceRows).set({ stripe_session_id: "cs_untracked" }).where(eq(invoiceRows.id, f.invoice.id));
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice.stripe_checkout_attempt).toBe(0);
  });

  it("rejects claim/attachment/failure operations in a foreign account or mode", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const first = await claim(f.database, attempt);
    await expect(payments.claimCheckoutCreation(f.database, { ...scope(attempt), stripeAccountId: "acct_foreign" }, now)).rejects.toBeInstanceOf(NotFoundError);
    expect(await payments.attachCheckoutSession(f.database, { ...scope(attempt), livemode: true, claimId: first.claimId, sessionId: "cs_foreign" }, now)).toBeNull();
    expect(await payments.recordCheckoutCreationFailure(f.database, { ...scope(attempt), stripeAccountId: "acct_foreign", claimId: first.claimId, outcome: "not_created" }, now)).toBeNull();
  });

  it("enforces unique attached sessions within an account/mode and rolls back an attachment collision", async () => {
    const f = await fixture();
    await open(f, "cs_scoped_unique");
    const otherInvoice = await newInvoice(f.database, f.userId);
    const attempt = await payments.reserveCheckoutAttempt(f.database, { ...f.input, payToken: otherInvoice.pay_token }, now);
    const creator = await claim(f.database, attempt);
    await expect(payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: creator.claimId, sessionId: "cs_scoped_unique" }, now)).rejects.toThrow("UNIQUE");
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "creating", stripe_session_id: null, creation_claim_id: creator.claimId });
    expect(await open(await fixture(), "cs_scoped_unique")).toMatchObject({ state: "open" });
  });

  it("allows the same session identifier in a different recorded mode", async () => {
    const f = await fixture();
    await open(f, "cs_mode_scoped");
    await f.database.update(stripeConnections).set({ livemode: true }).where(eq(stripeConnections.id, f.connection.id));
    const liveInvoice = await newInvoice(f.database, f.userId, true);
    const liveAttempt = await payments.reserveCheckoutAttempt(f.database, { ...f.input, payToken: liveInvoice.pay_token, livemode: true }, now);
    const creator = await claim(f.database, liveAttempt);
    expect(await payments.attachCheckoutSession(f.database, { ...scope(liveAttempt), claimId: creator.claimId, sessionId: "cs_mode_scoped" }, now)).toMatchObject({ state: "open", livemode: true });
  });
});

describe("validated payment events and atomic receipts", () => {
  it("supports live-mode connected payments with a mode-specific receipt namespace", async () => {
    const f = await fixture(true);
    const attempt = await open(f);
    const payment = event(f.invoice, attempt);
    expect(await payments.processInvoicePaymentEvent(f.database, payment, now)).toEqual({ kind: "processed", result: "applied" });
    const [receipt] = await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, payment.eventId));
    expect(JSON.parse(receipt.event_key)).toEqual(["invoice_payment", "connected", true, f.connection.stripe_account_id, payment.eventId]);
    expect(receipt.livemode).toBe(true);
  });

  it("early metadata-bound webhook is retryable until the exact session is attached", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const creator = await claim(f.database, attempt);
    const early = event(f.invoice, attempt, { sessionId: "cs_early" });
    expect(await payments.processInvoicePaymentEvent(f.database, early, now)).toEqual({ kind: "retryable", reason: "session_not_attached" });
    expect(await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, early.eventId))).toEqual([]);
    await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: creator.claimId, sessionId: early.sessionId }, now);
    expect(await payments.processInvoicePaymentEvent(f.database, early, now)).toEqual({ kind: "processed", result: "applied" });
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "paid", stripe_payment_intent_id: early.paymentIntentId });
  });

  it("concurrent delivery stores one namespaced receipt and paid cannot regress", async () => {
    const f = await fixture();
    const attempt = await open(f);
    const paid = event(f.invoice, attempt);
    const results = await Promise.all(Array.from({ length: 5 }, () => payments.processInvoicePaymentEvent(f.database, paid, now)));
    expect(results.filter((result) => result.kind === "processed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "duplicate")).toHaveLength(4);
    const receipts = await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, paid.eventId));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].event_key)).toEqual(["invoice_payment", "connected", false, f.connection.stripe_account_id, paid.eventId]);
    expect(receipts[0]).toMatchObject({ result: "applied", invoice_id: f.invoice.id, checkout_attempt_id: attempt.id, amount_total: 1500, currency: "usd", payment_status: "paid" });
    for (const observation of [expired, { eventType: "checkout.session.async_payment_failed", sessionStatus: "complete", paymentStatus: "unpaid" }, { paymentStatus: "unpaid" }] as Partial<payments.InvoicePaymentEventInput>[]) {
      expect(await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, { ...observation, paymentIntentId: paid.paymentIntentId }), later(1000))).toEqual({ kind: "processed", result: "ignored" });
    }
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "paid", stripe_payment_intent_id: paid.paymentIntentId });
    await expect(f.database.update(invoiceCheckoutAttempts).set({ state: "open" }).where(eq(invoiceCheckoutAttempts.id, attempt.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining("regress") } });
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
  });

  it("a delayed creation response/failure cannot replace paid state or identifiers", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const creator = await claim(f.database, attempt);
    const attached = await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: creator.claimId, sessionId: "cs_paid_attachment_race" }, now);
    const paid = event(f.invoice, attached);
    await payments.processInvoicePaymentEvent(f.database, paid, now);
    expect(await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: creator.claimId, sessionId: "cs_different_late_response" }, later(100))).toBeNull();
    expect(await payments.recordCheckoutCreationFailure(f.database, { ...scope(attempt), claimId: creator.claimId, outcome: "unknown" }, later(100))).toBeNull();
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "paid", stripe_session_id: paid.sessionId, stripe_payment_intent_id: paid.paymentIntentId });
    expect(await payments.recordCheckoutSessionExpiration(f.database, { ...scope(attempt), sessionId: paid.sessionId, sessionLivemode: false, sessionStatus: "expired", paymentStatus: "unpaid" }, later(100))).toBeNull();
  });

  it("async success transitions processing to paid using the known payment intent", async () => {
    const f = await fixture();
    const attempt = await open(f);
    const processing = event(f.invoice, attempt, { paymentStatus: "unpaid" });
    await payments.processInvoicePaymentEvent(f.database, processing, now);
    expect(await payments.processInvoicePaymentEvent(f.database, { ...processing, eventId: crypto.randomUUID(), eventType: "checkout.session.async_payment_succeeded", paymentStatus: "paid" }, later(100))).toEqual({ kind: "processed", result: "applied" });
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "paid", stripe_payment_intent_id: processing.paymentIntentId });
  });

  it("classifies concurrent successful different sessions atomically", async () => {
    const f = await fixture();
    const first = await open(f);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, first, expired), now);
    const second = await open(f);
    const results = await Promise.all([payments.processInvoicePaymentEvent(f.database, event(f.invoice, first), now), payments.processInvoicePaymentEvent(f.database, event(f.invoice, second), now)]);
    expect(results).toContainEqual({ kind: "processed", result: "applied" });
    expect(results).toContainEqual({ kind: "processed", result: "duplicate_payment" });
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice.status).toBe("paid");
    expect([first.stripe_session_id, second.stripe_session_id]).toContain(invoice.stripe_session_id);
  });

  it.each([
    { stripeAccountId: "acct_foreign" }, { expectedLivemode: true }, { livemode: true, expectedLivemode: true },
    { sessionId: "cs_other" }, { attemptId: "other-attempt" }, { payToken: "wrong" },
    { invoiceId: "wrong" }, { amountTotal: 1499 }, { currency: "eur" }, { amountTotal: null },
    { currency: null }, { sessionMode: "subscription" }, { paymentStatus: "no_payment_required" },
    { sessionStatus: "open" }, { paymentIntentId: null },
  ] as Partial<payments.InvoicePaymentEventInput>[])("rejects a mismatched event %j without acknowledging a receipt", async (override) => {
    const f = await fixture();
    const attempt = await open(f);
    const payment = event(f.invoice, attempt, override);
    expect((await payments.processInvoicePaymentEvent(f.database, payment, now)).kind).toBe("rejected");
    expect(await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, payment.eventId))).toEqual([]);
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "open" });
  });

  it("does not replace a known payment intent with a different one", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, { paymentStatus: "unpaid", paymentIntentId: "pi_known" }), now);
    expect(await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt, { paymentIntentId: "pi_foreign" }), now)).toEqual({ kind: "rejected", reason: "binding_mismatch" });
  });

  it("detects a different successful session durably and preserves the original invoice payment", async () => {
    const f = await fixture();
    const first = await open(f);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, first, expired), now);
    const second = await open(f);
    const paidSecond = event(f.invoice, second);
    await payments.processInvoicePaymentEvent(f.database, paidSecond, later(100));
    const lateFirst = event(f.invoice, first);
    expect(await payments.processInvoicePaymentEvent(f.database, lateFirst, later(200))).toEqual({ kind: "processed", result: "duplicate_payment" });
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice).toMatchObject({ status: "paid", stripe_session_id: second.stripe_session_id, stripe_payment_intent_id: paidSecond.paymentIntentId, paid_at: later(100).toISOString() });
    expect(await payments.getCheckoutAttempt(f.database, scope(first))).toMatchObject({ state: "paid" });
    expect(await payments.processInvoicePaymentEvent(f.database, lateFirst, later(300))).toEqual({ kind: "duplicate", result: "duplicate_payment" });
  });

  it("rolls back both the receipt and attempt when invoice payment transition fails", async () => {
    const f = await fixture();
    const attempt = await open(f);
    const paid = event(f.invoice, attempt);
    await env.PAYMENT_DB.prepare(`CREATE TRIGGER fail_ledger_payment BEFORE UPDATE OF status ON invoices
      WHEN NEW.id = '${f.invoice.id}' AND NEW.status = 'paid'
      BEGIN SELECT RAISE(ABORT, 'test invoice failure'); END`).run();
    try {
      await expect(payments.processInvoicePaymentEvent(f.database, paid, now)).rejects.toThrow("test invoice failure");
      expect(await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, paid.eventId))).toEqual([]);
      expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "open", stripe_payment_intent_id: null });
    } finally {
      await env.PAYMENT_DB.prepare("DROP TRIGGER fail_ledger_payment").run();
    }
    expect(await payments.processInvoicePaymentEvent(f.database, paid, now)).toEqual({ kind: "processed", result: "applied" });
  });

  it("reconciles legacy platform payments only with a known session and classified mode", async () => {
    const f = await fixture();
    const historical = await legacyInvoice(f, null);
    expect(await payments.processInvoicePaymentEvent(f.database, event(historical, null), now)).toEqual({ kind: "rejected", reason: "unknown_legacy_mode" });
    const known = await legacyInvoice(f, false);
    expect(await payments.processInvoicePaymentEvent(f.database, event(known, null, { sessionId: "cs_metadata_only" }), now)).toEqual({ kind: "rejected", reason: "binding_mismatch" });
    expect(await payments.processInvoicePaymentEvent(f.database, event(known, null, { stripeAccountId: f.connection.stripe_account_id }), now)).toEqual({ kind: "rejected", reason: "invalid_event" });
    expect(await payments.processInvoicePaymentEvent(f.database, event(known, null, { expectedLivemode: true, livemode: true }), now)).toEqual({ kind: "rejected", reason: "binding_mismatch" });
    expect(await payments.processInvoicePaymentEvent(f.database, event(known, null), now)).toEqual({ kind: "processed", result: "applied" });
    await expect(payments.reserveCheckoutAttempt(f.database, { ...f.input, payToken: known.pay_token }, now)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("durable invoice void coordination", () => {
  it("cancels only a reservation that never started, atomically against a creation claim", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    expect(await payments.cancelUnstartedCheckoutAttempts(f.database, f.invoice.id, f.userId, now)).toBe(1);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), now)).kind).toBe("not_creatable");
    expect(await payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now)).toMatchObject({ status: "void" });
  });

  it("never cancels an in-flight create on lease expiration and legacy void cannot bypass it", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await claim(f.database, attempt);
    await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    expect(await payments.cancelUnstartedCheckoutAttempts(f.database, f.invoice.id, f.userId, later(100000000))).toBe(0);
    await expect(voidInvoice(f.database, f.invoice.id, f.userId)).rejects.toBeInstanceOf(ConflictError);
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "creating" });
  });

  it("returns a friendly conflict on deleting a void invoice with retained payment audit", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    await payments.recordCheckoutSessionExpiration(f.database, { ...scope(attempt), sessionId: attempt.stripe_session_id!, sessionLivemode: false, sessionStatus: "expired", paymentStatus: "unpaid" }, now);
    await payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    await expect(deleteInvoice(f.database, f.invoice.id, f.userId)).rejects.toBeInstanceOf(ConflictError);
  });
  it("sets the marker before Stripe expiration and rejects reservation/creation while pending", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    expect(await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now)).toMatchObject({ status: "sent", stripe_void_pending: true });
    await expect(payments.reserveCheckoutAttempt(f.database, f.input, now)).rejects.toBeInstanceOf(ConflictError);
    expect((await payments.claimCheckoutCreation(f.database, scope(attempt), now)).kind).toBe("not_creatable");
    await expect(payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
  });

  it("records an in-flight creation response during pending void and finalizes only after confirmed expiry", async () => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    const creator = await claim(f.database, attempt);
    await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    const attached = await payments.attachCheckoutSession(f.database, { ...scope(attempt), claimId: creator.claimId, sessionId: "cs_void_race" }, now);
    expect(attached).toMatchObject({ state: "open" });
    await expect(payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attached, expired), now);
    expect(await payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now)).toMatchObject({ status: "void", stripe_void_pending: false });
    const late = event(f.invoice, attached);
    expect(await payments.processInvoicePaymentEvent(f.database, late, now)).toEqual({ kind: "processed", result: "void_payment" });
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice).toMatchObject({ status: "void", paid_at: null });
    expect(await payments.getCheckoutAttempt(f.database, scope(attempt))).toMatchObject({ state: "paid" });
  });

  it("lets verified payment win a pending void and never finalizes a paid invoice", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt), now);
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice).toMatchObject({ status: "paid", stripe_void_pending: false });
    await expect(payments.finalizeInvoiceVoid(f.database, f.invoice.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
    await expect(payments.beginInvoiceVoid(f.database, f.invoice.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
  });

  it("scopes void operations to the issuer and blocks legacy untracked sessions", async () => {
    const f = await fixture();
    await expect(payments.beginInvoiceVoid(f.database, f.invoice.id, "other-user", now)).rejects.toBeInstanceOf(NotFoundError);
    const legacy = await legacyInvoice(f, false);
    await payments.beginInvoiceVoid(f.database, legacy.id, f.userId, now);
    await expect(payments.finalizeInvoiceVoid(f.database, legacy.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("historical platform evidence", () => {
  it("classifies an already-paid pre-migration invoice's exact original session without replacing its payment", async () => {
    const database = db();
    const [original] = await database.select().from(invoiceRows).where(eq(invoiceRows.id, "upgrade-paid-matching"));
    expect(original).toMatchObject({ status: "paid", paid_at: "2026-10-01T12:00:00.000Z",
      stripe_session_id: "cs_platform_original_matching", stripe_payment_intent_id: "pi_platform_original_matching",
      stripe_charge_scope: "platform", stripe_livemode: null, stripe_connection_id: null, stripe_account_id: null });
    const retrievedSession = { invoiceId: original.id, sessionId: original.stripe_session_id!, livemode: false,
      amountTotal: original.total, currency: original.currency.toLowerCase(), payToken: original.pay_token,
      metadataInvoiceId: null, sessionMode: "payment", sessionStatus: "complete", paymentStatus: "paid" };
    expect(await payments.recordLegacySessionEvidence(database, retrievedSession, now)).toBe(true);
    const [classified] = await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id));
    expect(classified).toEqual({ ...original, stripe_livemode: false });
    const payment = event(classified as Invoice, null, { paymentIntentId: original.stripe_payment_intent_id });
    expect(await payments.processInvoicePaymentEvent(database, payment, later(100))).toEqual({ kind: "processed", result: "applied" });
    expect(await payments.processInvoicePaymentEvent(database, payment, later(200))).toEqual({ kind: "duplicate", result: "applied" });
    expect((await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id)))[0]).toEqual(classified);
    const [receipt] = await database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, payment.eventId));
    expect(receipt).toMatchObject({ invoice_id: original.id, checkout_attempt_id: null, charge_scope: "platform",
      livemode: false, stripe_session_id: original.stripe_session_id, stripe_payment_intent_id: original.stripe_payment_intent_id,
      result: "applied", amount_total: original.total, currency: "usd", payment_status: "paid" });
    const wrongIntent = event(classified as Invoice, null, { paymentIntentId: "pi_foreign_historical" });
    expect(await payments.processInvoicePaymentEvent(database, wrongIntent, later(300))).toEqual({ kind: "rejected", reason: "binding_mismatch" });
    expect(await database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, wrongIntent.eventId))).toEqual([]);
    expect((await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id)))[0]).toEqual(classified);
    expect(await database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, original.id))).toEqual([]);
  });
  it.each([
    { variant: "amount", override: { amountTotal: 1499 } },
    { variant: "currency", override: { currency: "eur" } },
    { variant: "livemode", override: { livemode: true } },
    { variant: "session", override: { sessionId: "cs_foreign_historical" } },
    { variant: "session-mode", override: { sessionMode: "subscription" } },
  ])("rejects wrong $variant evidence and payment events for an already-paid historical invoice without mutating bindings", async ({ variant, override }) => {
    const database = db();
    const [original] = await database.select().from(invoiceRows).where(eq(invoiceRows.id, `upgrade-paid-${variant}`));
    expect(original).toMatchObject({ status: "paid", paid_at: "2026-10-01T12:00:00.000Z",
      stripe_session_id: `cs_platform_original_${variant}`, stripe_payment_intent_id: `pi_platform_original_${variant}`,
      stripe_charge_scope: "platform", stripe_livemode: null, stripe_connection_id: null, stripe_account_id: null });
    const retrievedSession = { invoiceId: original.id, sessionId: original.stripe_session_id!, livemode: false,
      amountTotal: original.total, currency: original.currency.toLowerCase(), payToken: original.pay_token,
      metadataInvoiceId: null, sessionMode: "payment", sessionStatus: "complete", paymentStatus: "paid" };
    if (variant !== "livemode") {
      await expect(payments.recordLegacySessionEvidence(database, { ...retrievedSession, ...override }, now)).rejects.toBeInstanceOf(ConflictError);
      expect((await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id)))[0]).toEqual(original);
      expect(await database.select().from(invoiceLegacySessionEvidence).where(eq(invoiceLegacySessionEvidence.invoice_id, original.id))).toEqual([]);
    }
    expect(await payments.recordLegacySessionEvidence(database, retrievedSession, now)).toBe(true);
    const [classified] = await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id));
    expect(classified).toEqual({ ...original, stripe_livemode: false });
    const [evidence] = await database.select().from(invoiceLegacySessionEvidence).where(eq(invoiceLegacySessionEvidence.invoice_id, original.id));
    await expect(payments.recordLegacySessionEvidence(database, { ...retrievedSession, ...override }, later(100))).rejects.toBeInstanceOf(ConflictError);
    expect((await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id)))[0]).toEqual(classified);
    expect((await database.select().from(invoiceLegacySessionEvidence).where(eq(invoiceLegacySessionEvidence.invoice_id, original.id)))[0]).toEqual(evidence);
    const payment = event(classified as Invoice, null, { paymentIntentId: original.stripe_payment_intent_id, ...override,
      ...(variant === "livemode" ? { expectedLivemode: true } : {}) });
    expect(await payments.processInvoicePaymentEvent(database, payment, later(200))).toEqual({ kind: "rejected",
      reason: variant === "session-mode" ? "invalid_event" : "binding_mismatch" });
    expect((await database.select().from(invoiceRows).where(eq(invoiceRows.id, original.id)))[0]).toEqual(classified);
    expect((await database.select().from(invoiceLegacySessionEvidence).where(eq(invoiceLegacySessionEvidence.invoice_id, original.id)))[0]).toEqual(evidence);
    expect(await database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.invoice_id, original.id))).toEqual([]);
    expect(await database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, original.id))).toEqual([]);
  });
  it("backfills old sent session-less invoices without guessing their mode", async () => {
    const [invoice] = await db().select().from(invoiceRows).where(eq(invoiceRows.id, "upgrade-sessionless"));
    expect(invoice).toMatchObject({ stripe_charge_scope: "platform", stripe_livemode: null, stripe_session_id: null });
    await expect(voidInvoice(db(), invoice.id, invoice.user_id)).rejects.toBeInstanceOf(ConflictError);
  });
  it("classifies a known platform mode once and finalizes only after trusted expiration evidence", async () => {
    const f = await fixture();
    const legacy = await legacyInvoice(f, null);
    const evidence = { invoiceId: legacy.id, sessionId: legacy.stripe_session_id!, livemode: false, amountTotal: legacy.total, currency: "usd", payToken: legacy.pay_token, metadataInvoiceId: null, sessionMode: "payment", sessionStatus: "open", paymentStatus: "unpaid" };
    await expect(f.database.update(invoiceRows).set({ stripe_livemode: false }).where(eq(invoiceRows.id, legacy.id))).rejects.toThrow();
    await expect(payments.recordLegacySessionEvidence(f.database, { ...evidence, sessionId: "cs_unseen" }, now)).rejects.toBeInstanceOf(ConflictError);
    await expect(payments.recordLegacySessionEvidence(f.database, { ...evidence, amountTotal: 1 }, now)).rejects.toBeInstanceOf(ConflictError);
    expect(await payments.recordLegacySessionEvidence(f.database, evidence, now)).toBe(true);
    await expect(payments.recordLegacySessionEvidence(f.database, { ...evidence, livemode: true }, now)).rejects.toBeInstanceOf(ConflictError);
    await expect(f.database.update(invoiceRows).set({ stripe_livemode: true }).where(eq(invoiceRows.id, legacy.id))).rejects.toThrow();
    expect((await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, legacy.id)))[0].stripe_livemode).toBe(false);
    await payments.beginInvoiceVoid(f.database, legacy.id, f.userId, now);
    await expect(payments.finalizeInvoiceVoid(f.database, legacy.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
    await payments.recordLegacySessionEvidence(f.database, { ...evidence, sessionStatus: "expired" }, now);
    expect(await payments.finalizeInvoiceVoid(f.database, legacy.id, f.userId, now)).toMatchObject({ status: "void" });
  });
});

describe("connection lifecycle receipts and deletion using real migrations", () => {
  it("rolls back the receipt when a lifecycle mutation fails", async () => {
    const f = await fixture();
    await env.PAYMENT_DB.prepare(`CREATE TRIGGER reject_lifecycle_update BEFORE UPDATE OF charges_enabled ON stripe_connections
      WHEN OLD.id = '${f.connection.id}'
      BEGIN SELECT RAISE(ABORT, 'fixture database write failure'); END;`).run();
    await expect(connections.processConnectionEvent(f.database, {
      eventId: "evt_rollback", eventType: "account.updated", stripeAccountId: f.connection.stripe_account_id,
      livemode: false, expectedAuthorizationRevision: f.connection.authorization_revision, observedAt: later(1),
      observation: { kind: "authorized", account: { stripe_account_id: f.connection.stripe_account_id, livemode: false,
        charges_enabled: false, payouts_enabled: false, details_submitted: true } },
    }, later(2))).rejects.toThrow();
    expect(await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_id, "evt_rollback"))).toEqual([]);
    expect((await connections.getConnectionById(f.database, f.connection.id))?.charges_enabled).toBe(true);
  });
  it("atomically clears the matching pending disconnect with verified deauthorization and retains history", async () => {
    const f = await fixture();
    await f.database.update(invoiceRows).set({ status: "void" }).where(eq(invoiceRows.id, f.invoice.id));
    const pending = await connections.disconnectAccount(f.database, f.connection.id, f.userId, later(1));
    const input = { eventId: "evt_verified_deauth", eventType: "account.application.deauthorized" as const,
      stripeAccountId: pending.stripe_account_id, livemode: false, expectedAuthorizationRevision: pending.authorization_revision,
      observedAt: later(2), observation: { kind: "deauthorized" as const } };
    expect(await connections.processConnectionEvent(f.database, input, later(3))).toEqual({ kind: "processed", result: "applied" });
    expect(await connections.getConnectionById(f.database, pending.id)).toMatchObject({
      stripe_account_id: pending.stripe_account_id, disconnect_operation_id: null, disconnected_at: expect.any(String),
    });
    expect(await connections.getCurrentOperation(f.database, f.userId)).toBeNull();
    expect(await connections.processConnectionEvent(f.database, input, later(3))).toEqual({ kind: "duplicate", result: "applied" });
  });
  it("atomically applies capabilities and requirements and ignores observations across same-account reauthorization", async () => {
    const f = await fixture();
    const requirements = { disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
      past_due: ["individual.verification.document"], pending_verification: [], errors: [] };
    const input = { eventId: "evt_lifecycle", eventType: "account.updated" as const, stripeAccountId: f.connection.stripe_account_id, livemode: false, expectedAuthorizationRevision: f.connection.authorization_revision, observedAt: later(1), observation: { kind: "authorized" as const, account: { stripe_account_id: f.connection.stripe_account_id, livemode: false, charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements } } };
    expect(await connections.processConnectionEvent(f.database, input, later(2))).toEqual({ kind: "processed", result: "applied" });
    expect(await connections.processConnectionEvent(f.database, input, later(2))).toEqual({ kind: "duplicate", result: "applied" });
    expect((await connections.getConnectionById(f.database, f.connection.id))?.charges_enabled).toBe(false);
    expect((await connections.getConnectionById(f.database, f.connection.id))?.requirements).toEqual(requirements);
    expect(await connections.processConnectionEvent(f.database, { ...input, eventId: "evt_stale_requirements", observedAt: now,
      observation: { kind: "authorized", account: { ...input.observation.account, requirements: null } } }, later(3)))
      .toEqual({ kind: "processed", result: "ignored" });
    expect((await connections.getConnectionById(f.database, f.connection.id))?.requirements).toEqual(requirements);
    await f.database.update(stripeConnections).set({ authorization_revision: "reconnected", charges_enabled: true }).where(eq(stripeConnections.id, f.connection.id));
    expect(await connections.processConnectionEvent(f.database, { ...input, eventId: "evt_old_deauth", eventType: "account.application.deauthorized", observation: { kind: "deauthorized" } }, later(3))).toEqual({ kind: "processed", result: "ignored" });
    expect(await connections.getConnectionById(f.database, f.connection.id)).toMatchObject({ disconnected_at: null, authorization_revision: "reconnected", charges_enabled: true });
  });
  it.each(["creating", "open", "processing", "unknown"] as const)("blocks disconnect and user deletion for unresolved %s attempts even on void invoices", async (state) => {
    const f = await fixture();
    const attempt = await payments.reserveCheckoutAttempt(f.database, f.input, now);
    await f.database.update(invoiceCheckoutAttempts).set({ state }).where(eq(invoiceCheckoutAttempts.id, attempt.id));
    await f.database.update(invoiceRows).set({ status: "void" }).where(eq(invoiceRows.id, f.invoice.id));
    await expect(connections.disconnectAccount(f.database, f.connection.id, f.userId, now)).rejects.toBeInstanceOf(ConflictError);
    await connections.markExternalDeauthorization(f.database, { stripeAccountId: f.connection.stripe_account_id, livemode: false, expectedAuthorizationRevision: f.connection.authorization_revision }, later(1));
    await expect(deleteUser(f.database, f.userId)).rejects.toBeInstanceOf(ConflictError);
  });
  it("blocks account deletion after external revocation while a sent invoice remains", async () => {
    const f = await fixture();
    await connections.markExternalDeauthorization(f.database, { stripeAccountId: f.connection.stripe_account_id, livemode: false, expectedAuthorizationRevision: f.connection.authorization_revision }, later(1));
    await expect(deleteUser(f.database, f.userId)).rejects.toBeInstanceOf(ConflictError);
    expect(await connections.getAccountDeletionBlock(f.database, f.userId)).toBe("outstanding_payments");
  });
  it("allows same-account OAuth recovery after verified revocation without redirecting an outstanding invoice", async () => {
    const f = await fixture();
    await connections.processConnectionEvent(f.database, {
      eventId: "evt_external_revoke_recovery", eventType: "account.application.deauthorized",
      stripeAccountId: f.connection.stripe_account_id, livemode: false,
      expectedAuthorizationRevision: f.connection.authorization_revision,
      expectedDisconnectOperationId: null, observedAt: later(1), observation: { kind: "deauthorized" },
    }, later(2));
    const state = await connections.createOAuthState(f.database, {
      userId: f.userId, state: "recovery-state", livemode: false,
    }, later(3));
    await connections.consumeOAuthState(f.database, {
      userId: f.userId, state: "recovery-state", livemode: false,
    }, later(4));
    await connections.recordAuthorizedAccount(f.database, {
      userId: f.userId, operationId: state.operation_id!, stripeAccountId: f.connection.stripe_account_id,
    }, later(5));
    const recovered = await connections.persistAuthorizedConnection(f.database, {
      userId: f.userId, operationId: state.operation_id!, livemode: false,
    }, later(6));
    expect(recovered).toMatchObject({ outcome: "persisted", connection: {
      id: f.connection.id, stripe_account_id: f.connection.stripe_account_id, disconnected_at: null,
    } });
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, f.invoice.id));
    expect(invoice).toMatchObject({ status: "sent", stripe_connection_id: f.connection.id,
      stripe_account_id: f.connection.stripe_account_id, stripe_livemode: false });
    expect(await connections.getAccountDeletionBlock(f.database, f.userId)).toBe("outstanding_payments");
  });
  it("serializes invoice sending against disconnect using the real migrations", async () => {
    const f = await fixture();
    await f.database.update(invoiceRows).set({ status: "void" }).where(eq(invoiceRows.id, f.invoice.id));
    const draft = await createDraftInvoice(f.database, { userId: f.userId, client_name: "Client", client_email: "client@example.com",
      due_date: "2026-11-01", line_items: [{ description: "Service", quantity: 1, unit_price: 1500 }] });
    const results = await Promise.allSettled([
      markInvoiceSent(f.database, draft.id, f.userId, false),
      connections.disconnectAccount(f.database, f.connection.id, f.userId, later(1)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [invoice] = await f.database.select().from(invoiceRows).where(eq(invoiceRows.id, draft.id));
    const connection = await connections.getConnectionById(f.database, f.connection.id);
    if (invoice.status === "sent") expect(connection?.disconnected_at).toBeNull();
    else expect(connection?.disconnect_operation_id).not.toBeNull();
  });
  it("cannot complete a new disconnect operation using an observation captured before it", async () => {
    const f = await fixture();
    await f.database.update(invoiceRows).set({ status: "void" }).where(eq(invoiceRows.id, f.invoice.id));
    const pending = await connections.disconnectAccount(f.database, f.connection.id, f.userId, later(1));
    expect(await connections.processConnectionEvent(f.database, {
      eventId: "evt_old_disconnect_state", eventType: "account.application.deauthorized", stripeAccountId: pending.stripe_account_id,
      livemode: false, expectedAuthorizationRevision: pending.authorization_revision, expectedDisconnectOperationId: null,
      observedAt: later(1), observation: { kind: "deauthorized" },
    }, later(2))).toEqual({ kind: "processed", result: "ignored" });
    expect(await connections.getConnectionById(f.database, pending.id)).toMatchObject({ disconnect_operation_id: pending.disconnect_operation_id });
  });
  it("deliberately removes terminal audit in FK order on authorized account deletion", async () => {
    const f = await fixture();
    const attempt = await open(f);
    await payments.processInvoicePaymentEvent(f.database, event(f.invoice, attempt), now);
    await connections.markExternalDeauthorization(f.database, { stripeAccountId: f.connection.stripe_account_id, livemode: false, expectedAuthorizationRevision: f.connection.authorization_revision }, later(1));
    expect(await deleteUser(f.database, f.userId)).toEqual({ fileKeys: [] });
    expect(await f.database.select().from(invoiceCheckoutAttempts).where(eq(invoiceCheckoutAttempts.invoice_id, f.invoice.id))).toEqual([]);
    expect(await f.database.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.invoice_id, f.invoice.id))).toEqual([]);
  });
});
