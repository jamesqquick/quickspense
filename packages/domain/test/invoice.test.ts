import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { PAYMENT_GUARD_TABLES_SQL } from "./helpers/migrations.js";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { createInvoiceSchema, updateInvoiceSchema } from "../src/schema.js";
import {
  invoices as invoiceRows,
  stripeConnections,
  users,
} from "../src/db/schema.js";
import {
  ConflictError,
  InvalidStateTransitionError,
  NoReadyStripeConnectionError,
  ValidationError,
} from "../src/errors.js";
import * as invoices from "../src/services/invoice.js";
import * as stripeConnectionService from "../src/services/stripeConnection.js";

async function createTestUser(db: ReturnType<typeof createDb>, email: string) {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({ id, name: email.split("@")[0], email, emailVerified: false, createdAt: now, updatedAt: now });
  return { id, email };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  requirements TEXT,
  disconnected_at TEXT,
  disconnect_operation_id TEXT,
  disconnect_started_at TEXT,
  authorization_revision TEXT NOT NULL,
  stripe_status_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_connections_account
  ON stripe_connections(stripe_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_connections_active_user
  ON stripe_connections(user_id) WHERE disconnected_at IS NULL;
CREATE TABLE IF NOT EXISTS stripe_connection_operations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('connect', 'disconnect')),
  connection_id TEXT REFERENCES stripe_connections(id),
  expires_at TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('authorizing', 'authorized', 'disconnecting')),
  stripe_account_id TEXT,
  attempt_id TEXT,
  attempt_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'connect' AND connection_id IS NULL AND expires_at IS NOT NULL)
    OR
    (kind = 'disconnect' AND connection_id IS NOT NULL AND expires_at IS NULL)
  ),
  CHECK (
    (kind = 'connect' AND ((phase = 'authorizing' AND stripe_account_id IS NULL) OR (phase = 'authorized' AND stripe_account_id IS NOT NULL)) AND attempt_id IS NULL AND attempt_expires_at IS NULL)
    OR
    (kind = 'disconnect' AND phase = 'disconnecting' AND stripe_account_id IS NULL AND ((attempt_id IS NULL AND attempt_expires_at IS NULL) OR (attempt_id IS NOT NULL AND attempt_expires_at IS NOT NULL)))
  )
);
CREATE TABLE IF NOT EXISTS stripe_connect_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  livemode INTEGER NOT NULL,
  operation_id TEXT REFERENCES stripe_connection_operations(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  pay_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_address TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  due_date TEXT NOT NULL,
  issued_at TEXT,
  paid_at TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_connection_id TEXT REFERENCES stripe_connections(id),
  stripe_account_id TEXT,
  stripe_livemode INTEGER,
  stripe_charge_scope TEXT CHECK (stripe_charge_scope IN ('platform', 'connected')),
  stripe_checkout_attempt INTEGER NOT NULL DEFAULT 0,
  stripe_void_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_number ON invoices(user_id, invoice_number);
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER invoices_require_connected_snapshot_on_send
BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'draft'
  AND NEW.status = 'sent'
  AND NOT (
    NEW.stripe_connection_id IS NOT NULL
    AND NEW.stripe_account_id IS NOT NULL
    AND NEW.stripe_livemode IS NOT NULL
    AND NEW.stripe_charge_scope = 'connected'
    AND EXISTS (
      SELECT 1
      FROM stripe_connections
      WHERE id = NEW.stripe_connection_id
        AND user_id = NEW.user_id
        AND stripe_account_id = NEW.stripe_account_id
        AND livemode = NEW.stripe_livemode
        AND disconnected_at IS NULL
        AND disconnect_operation_id IS NULL
        AND disconnect_started_at IS NULL
        AND (livemode = 0 OR (details_submitted = 1 AND charges_enabled = 1 AND payouts_enabled = 1))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'sent invoice requires a ready connected Stripe snapshot');
END;
CREATE TRIGGER invoices_preserve_stripe_snapshot_after_draft
BEFORE UPDATE OF
  stripe_connection_id,
  stripe_account_id,
  stripe_livemode,
  stripe_charge_scope
ON invoices
WHEN OLD.status <> 'draft'
  AND (
    NEW.stripe_connection_id IS NOT OLD.stripe_connection_id
    OR NEW.stripe_account_id IS NOT OLD.stripe_account_id
    OR NEW.stripe_livemode IS NOT OLD.stripe_livemode
    OR NEW.stripe_charge_scope IS NOT OLD.stripe_charge_scope
  )
BEGIN
  SELECT RAISE(ABORT, 'sent invoice Stripe snapshot is immutable');
END;
`;

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_checkout_attempts").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_webhook_events").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_legacy_session_evidence").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_line_items").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoices").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connect_states").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connection_operations").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connections").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
  for (const stmt of (SCHEMA_SQL + PAYMENT_GUARD_TABLES_SQL).split(/;\s*(?=CREATE)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

async function createStripeConnection(
  db: ReturnType<typeof createDb>,
  userId: string,
  overrides: Partial<typeof stripeConnections.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const connection = {
    id: crypto.randomUUID(),
    user_id: userId,
    stripe_account_id: `acct_${crypto.randomUUID().replaceAll("-", "")}`,
    livemode: false,
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    disconnected_at: null,
    disconnect_operation_id: null,
    disconnect_started_at: null,
    authorization_revision: crypto.randomUUID(),
    stripe_status_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  } satisfies typeof stripeConnections.$inferInsert;
  await db.insert(stripeConnections).values(connection);
  return connection;
}

async function sendTestInvoice(
  db: ReturnType<typeof createDb>,
  invoiceId: string,
  userId: string,
  expectedLivemode = false,
) {
  const [active] = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(eq(stripeConnections.user_id, userId));
  if (!active) await createStripeConnection(db, userId);
  return invoices.markInvoiceSent(db, invoiceId, userId, expectedLivemode);
}

const baseInvoice = {
  client_name: "Acme Inc",
  client_email: "billing@acme.test",
  due_date: "2099-12-31",
  line_items: [
    { description: "Consulting hours", quantity: 10, unit_price: 15000 }, // $150
    { description: "Setup fee", quantity: 1, unit_price: 25000 }, // $250
  ],
  tax_amount: 12500, // $125
};

describe("invoices", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("computes subtotal, tax, and total in cents", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    expect(createInvoiceSchema.parse(baseInvoice).currency).toBe("USD");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    // 10*15000 + 1*25000 = 175000
    expect(invoice.subtotal).toBe(175000);
    expect(invoice.tax_amount).toBe(12500);
    expect(invoice.total).toBe(187500);
    expect(invoice.currency).toBe("USD");
    expect(invoice.line_items).toHaveLength(2);
    expect(invoice.line_items[0].line_total).toBe(150000);
    expect(invoice.line_items[1].line_total).toBe(25000);
  });

  it("requires invoice line item quantities to be positive integers", () => {
    const integerLineItem = {
      description: "Consulting hours",
      quantity: 2,
      unit_price: 15000,
    };
    const fractionalLineItem = { ...integerLineItem, quantity: 1.5 };

    expect(
      createInvoiceSchema.safeParse({
        ...baseInvoice,
        line_items: [integerLineItem],
      }).success,
    ).toBe(true);
    expect(
      createInvoiceSchema.safeParse({
        ...baseInvoice,
        line_items: [fractionalLineItem],
      }).success,
    ).toBe(false);
    expect(
      createInvoiceSchema.safeParse({
        ...baseInvoice,
        line_items: [{ ...integerLineItem, quantity: 0 }],
      }).success,
    ).toBe(false);
    expect(
      updateInvoiceSchema.safeParse({
        line_items: [fractionalLineItem],
      }).success,
    ).toBe(false);
  });

  it("creates and reads an invoice in EUR without converting minor-unit amounts", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "eur@test.com");

    const created = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
      currency: "EUR",
    });
    const fetched = await invoices.getInvoice(db, created.id, user.id);

    expect(created.currency).toBe("EUR");
    expect(fetched?.currency).toBe("EUR");
    expect(fetched?.subtotal).toBe(175000);
    expect(fetched?.tax_amount).toBe(12500);
    expect(fetched?.total).toBe(187500);
  });

  it("assigns sequential invoice numbers per user", async () => {
    const db = createDb(env.DB);
    const userA = await createTestUser(db, "a@test.com");
    const userB = await createTestUser(db, "b@test.com");

    const a1 = await invoices.createDraftInvoice(db, {
      userId: userA.id,
      ...baseInvoice,
    });
    const a2 = await invoices.createDraftInvoice(db, {
      userId: userA.id,
      ...baseInvoice,
    });
    const b1 = await invoices.createDraftInvoice(db, {
      userId: userB.id,
      ...baseInvoice,
    });

    expect(a1.invoice_number).toBe("INV-0001");
    expect(a2.invoice_number).toBe("INV-0002");
    expect(b1.invoice_number).toBe("INV-0001");
  });

  it("enforces draft -> sent transition only", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");
    const connection = await createStripeConnection(db, user.id, {
      stripe_account_id: "acct_invoice_snapshot",
      livemode: true,
    });

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    const sent = await invoices.markInvoiceSent(db, invoice.id, user.id, true);
    expect(sent.status).toBe("sent");
    expect(sent.issued_at).toBeTruthy();
    expect(sent).toMatchObject({
      stripe_connection_id: connection.id,
      stripe_account_id: "acct_invoice_snapshot",
      stripe_livemode: true,
      stripe_charge_scope: "connected",
    });

    // Idempotent - calling again returns same status
    const sentAgain = await invoices.markInvoiceSent(
      db,
      invoice.id,
      user.id,
      true,
    );
    expect(sentAgain).toEqual(sent);
  });

  it.each([
    ["missing details", { details_submitted: false }],
    ["charges disabled", { charges_enabled: false }],
    ["payouts disabled", { payouts_enabled: false }],
  ])("requires %s to be resolved for live invoice sending", async (_, overrides) => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, `${crypto.randomUUID()}@test.com`);
    const invoice = await invoices.createDraftInvoice(db, { userId: user.id, ...baseInvoice });
    await createStripeConnection(db, user.id, { ...overrides, livemode: true });
    await expect(invoices.markInvoiceSent(db, invoice.id, user.id, true)).rejects.toBeInstanceOf(NoReadyStripeConnectionError);
    expect((await invoices.getInvoice(db, invoice.id, user.id))?.status).toBe("draft");
  });

  it("allows sandbox invoice sending with disabled readiness flags", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, `${crypto.randomUUID()}@test.com`);
    const invoice = await invoices.createDraftInvoice(db, { userId: user.id, ...baseInvoice });
    await createStripeConnection(db, user.id, { charges_enabled: false, payouts_enabled: false, details_submitted: false });
    expect((await invoices.markInvoiceSent(db, invoice.id, user.id, false)).status).toBe("sent");
  });

  it.each([
    [
      "pending disconnect",
      {
        disconnected_at: "2026-01-01T00:00:00.000Z",
        disconnect_operation_id: "operation_pending",
        disconnect_started_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    ["disconnected", { disconnected_at: "2026-01-01T00:00:00.000Z" }],
    ["disconnect started", { disconnect_started_at: "2026-01-01T00:00:00.000Z" }],
    ["mode mismatch", { livemode: true }],
  ])("leaves an invoice draft when the Stripe connection has %s", async (_, overrides) => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, `${crypto.randomUUID()}@test.com`);
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await createStripeConnection(db, user.id, overrides);

    await expect(
      invoices.markInvoiceSent(db, invoice.id, user.id, false),
    ).rejects.toBeInstanceOf(NoReadyStripeConnectionError);
    await expect(invoices.getInvoice(db, invoice.id, user.id)).resolves.toMatchObject({
      status: "draft",
      issued_at: null,
      stripe_connection_id: null,
      stripe_account_id: null,
      stripe_livemode: null,
      stripe_charge_scope: null,
    });
  });

  it("leaves an invoice draft when the user has no Stripe connection", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "no-connection@test.com");
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    await expect(
      invoices.markInvoiceSent(db, invoice.id, user.id, false),
    ).rejects.toBeInstanceOf(NoReadyStripeConnectionError);
    await expect(invoices.getInvoice(db, invoice.id, user.id)).resolves.toMatchObject({
      status: "draft",
      stripe_connection_id: null,
    });
  });

  it("does not reroute a sent invoice after the user reconnects", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "reconnect@test.com");
    const firstConnection = await createStripeConnection(db, user.id, {
      stripe_account_id: "acct_original",
    });
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    const sent = await invoices.markInvoiceSent(db, invoice.id, user.id, false);

    await db
      .update(stripeConnections)
      .set({ disconnected_at: "2026-01-01T00:00:00.000Z" })
      .where(eq(stripeConnections.id, firstConnection.id));
    await createStripeConnection(db, user.id, {
      stripe_account_id: "acct_reconnected",
    });

    const resent = await invoices.markInvoiceSent(db, invoice.id, user.id, false);
    expect(resent).toEqual(sent);
    expect(resent).toMatchObject({
      stripe_connection_id: firstConnection.id,
      stripe_account_id: "acct_original",
      stripe_livemode: false,
      stripe_charge_scope: "connected",
    });
  });

  it("serializes invoice send against Stripe disconnect", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "send-disconnect-race@test.com");
    const connection = await createStripeConnection(db, user.id, {
      stripe_account_id: "acct_send_disconnect_race",
    });
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    const results = await Promise.allSettled([
      invoices.markInvoiceSent(db, invoice.id, user.id, false),
      stripeConnectionService.disconnectAccount(db, connection.id, user.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const [storedInvoice] = await db
      .select()
      .from(invoiceRows)
      .where(eq(invoiceRows.id, invoice.id));
    const [storedConnection] = await db
      .select()
      .from(stripeConnections)
      .where(eq(stripeConnections.id, connection.id));
    if (storedInvoice.status === "sent") {
      expect(storedConnection.disconnected_at).toBeNull();
      expect(storedInvoice.stripe_connection_id).toBe(connection.id);
    } else {
      expect(storedInvoice.status).toBe("draft");
      expect(storedConnection.disconnected_at).not.toBeNull();
    }
    expect(
      storedInvoice.status === "sent" && storedConnection.disconnected_at !== null,
    ).toBe(false);
  });

  it("rejects paid and void to sent transitions", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "invalid-send-state@test.com");
    await createStripeConnection(db, user.id);
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await db
      .update(invoiceRows)
      .set({ status: "paid" })
      .where(eq(invoiceRows.id, invoice.id));

    await expect(
      invoices.markInvoiceSent(db, invoice.id, user.id, false),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await db
      .update(invoiceRows)
      .set({ status: "void" })
      .where(eq(invoiceRows.id, invoice.id));
    await expect(
      invoices.markInvoiceSent(db, invoice.id, user.id, false),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("enforces the durable Stripe snapshot invariants", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "snapshot-trigger@test.com");
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    await expect(
      env.DB.prepare("UPDATE invoices SET status = 'sent' WHERE id = ?")
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/ready connected Stripe snapshot/i);
    const sent = await sendTestInvoice(db, invoice.id, user.id);
    await expect(
      env.DB.prepare(
        "UPDATE invoices SET stripe_account_id = 'acct_rerouted' WHERE id = ?",
      )
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/snapshot is immutable/i);
    await expect(invoices.getInvoice(db, invoice.id, user.id)).resolves.toMatchObject({
      stripe_account_id: sent.stripe_account_id,
      stripe_connection_id: sent.stripe_connection_id,
    });
  });

  it("keeps historical sent platform invoices readable and unmodified", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "historical-platform@test.com");
    const historicalId = crypto.randomUUID();
    await db.insert(invoiceRows).values({
      id: historicalId,
      user_id: user.id,
      invoice_number: "INV-HISTORICAL",
      pay_token: crypto.randomUUID(),
      status: "sent",
      client_name: "Historical Client",
      client_email: "historical@example.com",
      due_date: "2025-01-01",
      issued_at: "2024-12-01T00:00:00.000Z",
      stripe_session_id: "cs_test_historical",
      stripe_charge_scope: "platform",
    });
    await createStripeConnection(db, user.id, {
      stripe_account_id: "acct_current",
      livemode: true,
    });

    const resent = await invoices.markInvoiceSent(db, historicalId, user.id, true);
    expect(resent).toMatchObject({
      status: "sent",
      stripe_session_id: "cs_test_historical",
      stripe_connection_id: null,
      stripe_account_id: null,
      stripe_livemode: null,
      stripe_charge_scope: "platform",
      issued_at: "2024-12-01T00:00:00.000Z",
    });
  });

  it("blocks editing a non-draft invoice", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);

    await expect(
      invoices.updateDraftInvoice(db, invoice.id, user.id, {
        client_name: "Other",
      }),
    ).rejects.toThrow(/draft/i);
  });

  it.each([
    { client_name: "Changed client", currency: "EUR" as const, tax_amount: 0 },
    {
      client_name: "Changed client",
      currency: "EUR" as const,
      tax_amount: 0,
      line_items: [{ description: "Replacement", quantity: 1, unit_price: 99 }],
    },
  ])("rejects an edit when sending commits after the draft read", async (fields) => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "edit-send-race@test.com");
    await createStripeConnection(db, user.id);
    const invoice = await invoices.createDraftInvoice(db, { userId: user.id, ...baseInvoice });
    const batch = db.batch.bind(db);
    let sent = invoice;
    const interleave = vi.spyOn(db, "batch").mockImplementationOnce(async (queries) => {
      sent = await invoices.markInvoiceSent(db, invoice.id, user.id, false);
      return batch(queries);
    });

    try {
      await expect(invoices.updateDraftInvoice(db, invoice.id, user.id, fields))
        .rejects.toBeInstanceOf(ConflictError);
      expect(interleave).toHaveBeenCalledOnce();
      expect(await invoices.getInvoice(db, invoice.id, user.id)).toEqual(sent);
      expect(sent.line_items).toEqual(invoice.line_items);
    } finally {
      interleave.mockRestore();
    }
  });

  it("sends the complete edited terms when the edit commits after the send read", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "send-edit-race@test.com");
    await createStripeConnection(db, user.id);
    const invoice = await invoices.createDraftInvoice(db, { userId: user.id, ...baseInvoice });
    const run = db.run.bind(db);
    let edited = invoice;
    const interleave = vi.spyOn(db, "run").mockImplementationOnce(async (query) => {
      edited = await invoices.updateDraftInvoice(db, invoice.id, user.id, {
        currency: "EUR",
        tax_amount: 11,
        line_items: [{ description: "Edited before send", quantity: 3, unit_price: 33 }],
      });
      return run(query);
    });

    try {
      const sent = await invoices.markInvoiceSent(db, invoice.id, user.id, false);
      expect(interleave).toHaveBeenCalledOnce();
      expect(sent).toMatchObject({ status: "sent", currency: "EUR", subtotal: 99, tax_amount: 11, total: 110 });
      expect(sent.line_items).toEqual(edited.line_items);
    } finally {
      interleave.mockRestore();
    }
  });

  it("rolls back invoice terms and line items when replacement fails", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "edit-rollback@test.com");
    const invoice = await invoices.createDraftInvoice(db, { userId: user.id, ...baseInvoice });
    await env.DB.prepare(`
      CREATE TRIGGER reject_replacement BEFORE INSERT ON invoice_line_items
      WHEN NEW.description = 'Rejected replacement'
      BEGIN SELECT RAISE(ABORT, 'replacement rejected'); END
    `).run();

    await expect(invoices.updateDraftInvoice(db, invoice.id, user.id, {
      currency: "EUR",
      tax_amount: 0,
      line_items: [{ description: "Rejected replacement", quantity: 1, unit_price: 99 }],
    })).rejects.toThrow(/replacement rejected/);
    expect(await invoices.getInvoice(db, invoice.id, user.id)).toEqual(invoice);
  });

  it("blocks deleting a sent invoice (must be voided first)", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);

    await expect(
      invoices.deleteInvoice(db, invoice.id, user.id),
    ).rejects.toThrow(/draft or void/i);
  });

  it("blocks deleting a paid invoice", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);
    await invoices.markInvoicePaidByPayToken(db, invoice.pay_token, {
      stripeSessionId: "cs_test_paid",
      amountTotal: invoice.total,
      currency: "usd",
    });

    await expect(
      invoices.deleteInvoice(db, invoice.id, user.id),
    ).rejects.toThrow(/draft or void/i);
  });

  it("deletes a draft invoice and its line items", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    await invoices.deleteInvoice(db, invoice.id, user.id);

    const fetched = await invoices.getInvoice(db, invoice.id, user.id);
    expect(fetched).toBeNull();
  });

  it("deletes a void invoice", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);
    await invoices.voidInvoice(db, invoice.id, user.id);

    await invoices.deleteInvoice(db, invoice.id, user.id);

    const fetched = await invoices.getInvoice(db, invoice.id, user.id);
    expect(fetched).toBeNull();
  });

  it("blocks voiding a paid invoice", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);
    await invoices.markInvoicePaidByPayToken(db, invoice.pay_token, {
      stripeSessionId: "cs_test",
      amountTotal: invoice.total,
      currency: "usd",
    });

    await expect(
      invoices.voidInvoice(db, invoice.id, user.id),
    ).rejects.toThrow();
  });

  it("markInvoicePaidByPayToken is idempotent", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);

    const first = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      {
        stripeSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: invoice.total,
        currency: "usd",
      },
    );
    expect(first.kind).toBe("paid");
    const firstPaidAt = first.kind === "paid" ? first.invoice.paid_at : null;
    expect(firstPaidAt).toBeTruthy();

    // Second call should not change paid_at
    const second = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      {
        stripeSessionId: "cs_2",
        stripePaymentIntentId: "pi_2",
        amountTotal: invoice.total,
        currency: "usd",
      },
    );
    expect(second.kind).toBe("paid");
    if (second.kind === "paid") {
      expect(second.invoice.paid_at).toBe(firstPaidAt);
      // Original session/PI should be preserved (idempotent no-op)
      expect(second.invoice.stripe_session_id).toBe("cs_1");
    }
  });

  it("returns unknown_token for unknown pay token", async () => {
    const db = createDb(env.DB);
    const result = await invoices.markInvoicePaidByPayToken(db, "nope", {
      amountTotal: 100,
      currency: "usd",
    });
    expect(result.kind).toBe("unknown_token");
  });

  it("refuses to mark paid when amount_total mismatches invoice total", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);

    // Attacker pays $0.01 for a $1875 invoice
    const result = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      {
        stripeSessionId: "cs_attacker",
        amountTotal: 1, // 1 cent
        currency: "usd",
      },
    );

    expect(result.kind).toBe("amount_mismatch");
    if (result.kind === "amount_mismatch") {
      expect(result.expectedAmount).toBe(invoice.total);
      expect(result.gotAmount).toBe(1);
    }

    // Invoice must still be in 'sent' state
    const reread = await invoices.getInvoice(db, invoice.id, user.id);
    expect(reread?.status).toBe("sent");
  });

  it("refuses to mark paid when currency mismatches", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);

    const result = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      {
        stripeSessionId: "cs_wrong_currency",
        amountTotal: invoice.total,
        currency: "eur",
      },
    );

    expect(result.kind).toBe("amount_mismatch");
    const reread = await invoices.getInvoice(db, invoice.id, user.id);
    expect(reread?.status).toBe("sent");
  });

  it("refuses void -> paid transition", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await sendTestInvoice(db, invoice.id, user.id);
    await invoices.voidInvoice(db, invoice.id, user.id);

    // Late async payment after void must NOT flip status back
    const result = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      {
        stripeSessionId: "cs_late",
        amountTotal: invoice.total,
        currency: "usd",
      },
    );

    expect(result.kind).toBe("void");
    const reread = await invoices.getInvoice(db, invoice.id, user.id);
    expect(reread?.status).toBe("void");
  });

  it("updateDraftInvoice replaces line items and recomputes totals", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "user@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    const updated = await invoices.updateDraftInvoice(db, invoice.id, user.id, {
      line_items: [{ description: "Single item", quantity: 1, unit_price: 5000 }],
      tax_amount: 0,
    });

    expect(updated.line_items).toHaveLength(1);
    expect(updated.subtotal).toBe(5000);
    expect(updated.tax_amount).toBe(0);
    expect(updated.total).toBe(5000);
  });

  it("allows changing a draft invoice currency to EUR", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "update-currency@test.com");
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    const updated = await invoices.updateDraftInvoice(db, invoice.id, user.id, {
      currency: "EUR",
    });

    expect(updated.currency).toBe("EUR");
    expect(updated.subtotal).toBe(invoice.subtotal);
    expect(updated.total).toBe(invoice.total);
  });

  it("preserves invoice currency when a draft update omits currency", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "preserve-currency@test.com");
    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
      currency: "EUR",
    });

    const updated = await invoices.updateDraftInvoice(db, invoice.id, user.id, {
      notes: "Keep the existing currency",
    });

    expect(updated.currency).toBe("EUR");
  });

  it("rejects invalid currency values in schemas and service inputs", async () => {
    const db = createDb(env.DB);
    const user = await createTestUser(db, "invalid-currency@test.com");
    const invalidCurrencies = ["GBP", "", null] as const;

    for (const currency of invalidCurrencies) {
      expect(
        createInvoiceSchema.safeParse({ ...baseInvoice, currency }).success,
      ).toBe(false);
      expect(updateInvoiceSchema.safeParse({ currency }).success).toBe(false);
      await expect(
        invoices.createDraftInvoice(
          db,
          { userId: user.id, ...baseInvoice, currency } as never,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    expect((await invoices.listInvoices(db, user.id)).total).toBe(0);

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    for (const currency of invalidCurrencies) {
      await expect(
        invoices.updateDraftInvoice(
          db,
          invoice.id,
          user.id,
          { currency } as never,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    expect((await invoices.getInvoice(db, invoice.id, user.id))?.currency).toBe(
      "USD",
    );
  });

  it("getInvoice scopes by user", async () => {
    const db = createDb(env.DB);
    const userA = await createTestUser(db, "a@test.com");
    const userB = await createTestUser(db, "b@test.com");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: userA.id,
      ...baseInvoice,
    });

    const ownerView = await invoices.getInvoice(db, invoice.id, userA.id);
    const otherView = await invoices.getInvoice(db, invoice.id, userB.id);
    expect(ownerView).not.toBeNull();
    expect(otherView).toBeNull();
  });
});
