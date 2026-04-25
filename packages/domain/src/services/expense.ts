import { eq, and, or, desc, gte, lte, like, sql, sum, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { expenses, categories } from "../db/schema.js";
import type { Expense, ExpenseSummary } from "../types.js";
import { NotFoundError } from "../errors.js";

export async function createExpenseFromReceipt(
  db: Database,
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

  await db.insert(expenses).values({
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
  });

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
  db: Database,
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

  await db.insert(expenses).values({
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
  });

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
  db: Database,
  userId: string,
  opts: {
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Expense[]> {
  const { startDate, endDate, categoryId, search, limit = 20, offset = 0 } = opts;

  const conditions: SQL[] = [eq(expenses.user_id, userId)];
  if (startDate) conditions.push(gte(expenses.expense_date, startDate));
  if (endDate) conditions.push(lte(expenses.expense_date, endDate));
  if (categoryId) conditions.push(eq(expenses.category_id, categoryId));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(like(expenses.merchant, pattern), like(expenses.notes, pattern))!,
    );
  }

  return db
    .select()
    .from(expenses)
    .where(and(...conditions))
    .orderBy(desc(expenses.expense_date), desc(expenses.created_at))
    .limit(limit)
    .offset(offset) as Promise<Expense[]>;
}

export async function getExpense(
  db: Database,
  expenseId: string,
  userId: string,
): Promise<Expense | null> {
  const [row] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.user_id, userId)));
  return (row as Expense | undefined) ?? null;
}

export async function updateExpense(
  db: Database,
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

  const updates: Record<string, unknown> = { updated_at: sql`datetime('now')` };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  await db
    .update(expenses)
    .set(updates)
    .where(and(eq(expenses.id, expenseId), eq(expenses.user_id, userId)));

  const updated = await getExpense(db, expenseId, userId);
  if (!updated) throw new NotFoundError("Expense", expenseId);
  return updated;
}

export async function deleteExpense(
  db: Database,
  expenseId: string,
  userId: string,
): Promise<void> {
  const existing = await getExpense(db, expenseId, userId);
  if (!existing) throw new NotFoundError("Expense", expenseId);

  await db
    .delete(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.user_id, userId)));
}

export async function getExpenseSummary(
  db: Database,
  userId: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<ExpenseSummary> {
  const { startDate, endDate } = opts;

  const conditions: SQL[] = [eq(expenses.user_id, userId)];
  if (startDate) conditions.push(gte(expenses.expense_date, startDate));
  if (endDate) conditions.push(lte(expenses.expense_date, endDate));

  const where = and(...conditions);

  // Total and count
  const [totals] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
      count: count(),
    })
    .from(expenses)
    .where(where);

  // By category
  const byCategory = await db
    .select({
      category_id: expenses.category_id,
      category_name: categories.name,
      total: sql<number>`SUM(${expenses.amount})`,
      count: count(),
    })
    .from(expenses)
    .leftJoin(categories, eq(expenses.category_id, categories.id))
    .where(where)
    .groupBy(expenses.category_id, categories.name)
    .orderBy(desc(sql`SUM(${expenses.amount})`));

  return {
    total: totals?.total ?? 0,
    count: totals?.count ?? 0,
    byCategory,
  };
}
