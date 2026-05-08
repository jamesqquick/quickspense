import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createDb } from "../src/db/index.js";
import * as auth from "../src/services/auth.js";
import * as expenses from "../src/services/expense.js";

/**
 * Minimal schema applied before each test. Mirrors the unified schema in
 * migrations/0001_initial.sql + 0006_merge_receipts_into_expenses.sql,
 * scoped to the tables the tests exercise.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','processing','needs_review','failed')),
  merchant TEXT,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  expense_date TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  notes TEXT,
  file_key TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_type TEXT,
  error_message TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS expenses").run();
  await env.DB.prepare("DROP TABLE IF EXISTS categories").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

describe("multi-tenant authorization", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("User B cannot access User A's expense", async () => {
    const db = createDb(env.DB);

    const userA = await auth.createUser(db, "a@example.com", "passwordA123");
    const userB = await auth.createUser(db, "b@example.com", "passwordB123");

    // User A uploads a receipt -> creates a `processing` expense.
    const aProcessing = await expenses.createExpenseForUpload(db, {
      userId: userA.id,
      file: {
        fileKey: "expenses/abc/test.jpg",
        fileName: "test.jpg",
        fileSize: 1024,
        fileType: "image/jpeg",
      },
    });

    // User A can read their own expense
    const ownExpense = await expenses.getExpense(db, aProcessing.id, userA.id);
    expect(ownExpense).not.toBeNull();
    expect(ownExpense?.id).toBe(aProcessing.id);

    // User B cannot
    const crossExpense = await expenses.getExpense(db, aProcessing.id, userB.id);
    expect(crossExpense).toBeNull();

    // User B's list doesn't include User A's expense
    const userBList = await expenses.listExpenses(db, userB.id);
    expect(userBList.items).toHaveLength(0);
    expect(userBList.total).toBe(0);

    // Each user's manual expense list stays isolated
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

    const userAList = await expenses.listExpenses(db, userA.id, {
      status: "active",
    });
    const userBList2 = await expenses.listExpenses(db, userB.id, {
      status: "active",
    });
    expect(userAList.items).toHaveLength(1);
    expect(userAList.items[0].merchant).toBe("A's Store");
    expect(userBList2.items).toHaveLength(1);
    expect(userBList2.items[0].merchant).toBe("B's Store");
  });
});
