import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createDb } from "../src/db/index.js";
import * as auth from "../src/services/auth.js";
import * as receipts from "../src/services/receipt.js";
import * as expenses from "../src/services/expense.js";

/**
 * Minimal schema applied before each test. Mirrors migrations/0001_initial.sql
 * but only the tables exercised by these tests.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK(status IN ('uploaded','processing','needs_review','finalized','failed')),
  error_message TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_global_name ON categories(name) WHERE is_global = 1;
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id TEXT REFERENCES receipts(id),
  merchant TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  expense_date TEXT NOT NULL,
  category_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS expenses").run();
  await env.DB.prepare("DROP TABLE IF EXISTS categories").run();
  await env.DB.prepare("DROP TABLE IF EXISTS receipts").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

describe("multi-tenant authorization", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("User B cannot access User A's receipt", async () => {
    const db = createDb(env.DB);

    // Arrange: create two users
    const userA = await auth.createUser(db, "a@example.com", "passwordA123");
    const userB = await auth.createUser(db, "b@example.com", "passwordB123");

    // User A creates a receipt
    const receipt = await receipts.createReceipt(db, {
      userId: userA.id,
      fileKey: "receipts/abc/test.jpg",
      fileName: "test.jpg",
      fileSize: 1024,
      fileType: "image/jpeg",
    });

    // Act + Assert 1: User A can read their own receipt
    const ownReceipt = await receipts.getReceipt(db, receipt.id, userA.id);
    expect(ownReceipt).not.toBeNull();
    expect(ownReceipt?.id).toBe(receipt.id);

    // Act + Assert 2: User B cannot read User A's receipt (returns null, not the row)
    const crossReceipt = await receipts.getReceipt(db, receipt.id, userB.id);
    expect(crossReceipt).toBeNull();

    // Act + Assert 3: User B's receipt list does not include User A's receipt
    const userBReceipts = await receipts.listReceipts(db, userB.id);
    expect(userBReceipts).toHaveLength(0);

    // Act + Assert 4: User A's expense list does not include User B's data (and vice versa)
    await expenses.createManualExpense(db, {
      userId: userA.id,
      merchant: "A's Store",
      amount: 1000,
      currency: "USD",
      date: "2025-01-01",
    });
    await expenses.createManualExpense(db, {
      userId: userB.id,
      merchant: "B's Store",
      amount: 2000,
      currency: "USD",
      date: "2025-01-01",
    });

    const userAExpenses = await expenses.listExpenses(db, userA.id);
    const userBExpenses = await expenses.listExpenses(db, userB.id);
    expect(userAExpenses).toHaveLength(1);
    expect(userAExpenses[0].merchant).toBe("A's Store");
    expect(userBExpenses).toHaveLength(1);
    expect(userBExpenses[0].merchant).toBe("B's Store");
  });
});
