import type { Expense, ExpenseSummary } from "../types.js";
import { NotFoundError, ValidationError } from "../errors.js";

export async function createExpenseFromReceipt(
  db: D1Database,
  params: {
    receiptId: string;
    userId: string;
    merchant: string;
    amount: number;
    currency: string;
    date: string;
    categoryId?: string;
    notes?: string;
  },
): Promise<Expense> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO expenses (id, user_id, receipt_id, merchant, amount, currency, expense_date, category_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.userId,
      params.receiptId,
      params.merchant,
      params.amount,
      params.currency,
      params.date,
      params.categoryId ?? null,
      params.notes ?? null,
      now,
      now,
    )
    .run();

  return {
    id,
    user_id: params.userId,
    receipt_id: params.receiptId,
    merchant: params.merchant,
    amount: params.amount,
    currency: params.currency,
    expense_date: params.date,
    category_id: params.categoryId ?? null,
    notes: params.notes ?? null,
    created_at: now,
    updated_at: now,
  };
}

export async function createManualExpense(
  db: D1Database,
  params: {
    userId: string;
    merchant: string;
    amount: number;
    currency: string;
    date: string;
    categoryId?: string;
    notes?: string;
  },
): Promise<Expense> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO expenses (id, user_id, receipt_id, merchant, amount, currency, expense_date, category_id, notes, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.userId,
      params.merchant,
      params.amount,
      params.currency,
      params.date,
      params.categoryId ?? null,
      params.notes ?? null,
      now,
      now,
    )
    .run();

  return {
    id,
    user_id: params.userId,
    receipt_id: null,
    merchant: params.merchant,
    amount: params.amount,
    currency: params.currency,
    expense_date: params.date,
    category_id: params.categoryId ?? null,
    notes: params.notes ?? null,
    created_at: now,
    updated_at: now,
  };
}

export async function listExpenses(
  db: D1Database,
  userId: string,
  opts: {
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Expense[]> {
  const { startDate, endDate, categoryId, limit = 20, offset = 0 } = opts;
  const conditions = ["user_id = ?"];
  const bindings: unknown[] = [userId];

  if (startDate) {
    conditions.push("expense_date >= ?");
    bindings.push(startDate);
  }
  if (endDate) {
    conditions.push("expense_date <= ?");
    bindings.push(endDate);
  }
  if (categoryId) {
    conditions.push("category_id = ?");
    bindings.push(categoryId);
  }

  bindings.push(limit, offset);
  const sql = `SELECT * FROM expenses WHERE ${conditions.join(" AND ")} ORDER BY expense_date DESC, created_at DESC LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(...bindings).all<Expense>();
  return results;
}

export async function getExpense(
  db: D1Database,
  expenseId: string,
  userId: string,
): Promise<Expense | null> {
  const row = await db
    .prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?")
    .bind(expenseId, userId)
    .first<Expense>();
  return row ?? null;
}

export async function updateExpense(
  db: D1Database,
  expenseId: string,
  userId: string,
  fields: {
    merchant?: string;
    amount?: number;
    currency?: string;
    expense_date?: string;
    category_id?: string | null;
    notes?: string | null;
  },
): Promise<Expense> {
  const existing = await getExpense(db, expenseId, userId);
  if (!existing) throw new NotFoundError("Expense", expenseId);

  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(expenseId, userId);
  await db
    .prepare(
      `UPDATE expenses SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
    )
    .bind(...values)
    .run();

  const updated = await getExpense(db, expenseId, userId);
  if (!updated) throw new NotFoundError("Expense", expenseId);
  return updated;
}

export async function getExpenseSummary(
  db: D1Database,
  userId: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<ExpenseSummary> {
  const { startDate, endDate } = opts;
  const conditions = ["e.user_id = ?"];
  const bindings: unknown[] = [userId];

  if (startDate) {
    conditions.push("e.expense_date >= ?");
    bindings.push(startDate);
  }
  if (endDate) {
    conditions.push("e.expense_date <= ?");
    bindings.push(endDate);
  }

  const where = conditions.join(" AND ");

  // Total and count
  const totals = await db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) as total, COUNT(*) as count FROM expenses e WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number; count: number }>();

  // By category
  const { results: byCategory } = await db
    .prepare(
      `SELECT e.category_id, c.name as category_name, SUM(e.amount) as total, COUNT(*) as count
       FROM expenses e LEFT JOIN categories c ON e.category_id = c.id
       WHERE ${where}
       GROUP BY e.category_id, c.name
       ORDER BY total DESC`,
    )
    .bind(...bindings)
    .all<{
      category_id: string | null;
      category_name: string | null;
      total: number;
      count: number;
    }>();

  return {
    total: totals?.total ?? 0,
    count: totals?.count ?? 0,
    byCategory,
  };
}
