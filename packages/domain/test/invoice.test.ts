import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createDb } from "../src/db/index.js";
import * as auth from "../src/services/auth.js";
import * as invoices from "../src/services/invoice.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
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
`;

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_line_items").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoices").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
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
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    // 10*15000 + 1*25000 = 175000
    expect(invoice.subtotal).toBe(175000);
    expect(invoice.tax_amount).toBe(12500);
    expect(invoice.total).toBe(187500);
    expect(invoice.line_items).toHaveLength(2);
    expect(invoice.line_items[0].line_total).toBe(150000);
    expect(invoice.line_items[1].line_total).toBe(25000);
  });

  it("assigns sequential invoice numbers per user", async () => {
    const db = createDb(env.DB);
    const userA = await auth.createUser(db, "a@test.com", "password123");
    const userB = await auth.createUser(db, "b@test.com", "password123");

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
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });

    const sent = await invoices.markInvoiceSent(db, invoice.id, user.id);
    expect(sent.status).toBe("sent");
    expect(sent.issued_at).toBeTruthy();

    // Idempotent - calling again returns same status
    const sentAgain = await invoices.markInvoiceSent(db, invoice.id, user.id);
    expect(sentAgain.status).toBe("sent");
  });

  it("blocks editing a non-draft invoice", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await invoices.markInvoiceSent(db, invoice.id, user.id);

    await expect(
      invoices.updateDraftInvoice(db, invoice.id, user.id, {
        client_name: "Other",
      }),
    ).rejects.toThrow(/draft/i);
  });

  it("blocks deleting a non-draft invoice", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await invoices.markInvoiceSent(db, invoice.id, user.id);

    await expect(
      invoices.deleteDraftInvoice(db, invoice.id, user.id),
    ).rejects.toThrow(/draft/i);
  });

  it("blocks voiding a paid invoice", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await invoices.markInvoiceSent(db, invoice.id, user.id);
    await invoices.markInvoicePaidByPayToken(db, invoice.pay_token, {
      stripeSessionId: "cs_test",
    });

    await expect(
      invoices.voidInvoice(db, invoice.id, user.id),
    ).rejects.toThrow();
  });

  it("markInvoicePaidByPayToken is idempotent", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const invoice = await invoices.createDraftInvoice(db, {
      userId: user.id,
      ...baseInvoice,
    });
    await invoices.markInvoiceSent(db, invoice.id, user.id);

    const first = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      { stripeSessionId: "cs_1", stripePaymentIntentId: "pi_1" },
    );
    expect(first?.status).toBe("paid");
    const firstPaidAt = first?.paid_at;

    // Second call should not change paid_at
    const second = await invoices.markInvoicePaidByPayToken(
      db,
      invoice.pay_token,
      { stripeSessionId: "cs_2", stripePaymentIntentId: "pi_2" },
    );
    expect(second?.status).toBe("paid");
    expect(second?.paid_at).toBe(firstPaidAt);
    // Original session/PI should be preserved (idempotent no-op)
    expect(second?.stripe_session_id).toBe("cs_1");
  });

  it("returns null for unknown pay token", async () => {
    const db = createDb(env.DB);
    const result = await invoices.markInvoicePaidByPayToken(db, "nope", {});
    expect(result).toBeNull();
  });

  it("updateDraftInvoice replaces line items and recomputes totals", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

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

  it("getInvoice scopes by user", async () => {
    const db = createDb(env.DB);
    const userA = await auth.createUser(db, "a@test.com", "password123");
    const userB = await auth.createUser(db, "b@test.com", "password123");

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
