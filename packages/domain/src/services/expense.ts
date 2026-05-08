import { eq, and, or, desc, gte, lte, like, sql, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { expenses, categories } from "../db/schema.js";
import type { Expense, ExpenseStatus, ExpenseSummary, PaginatedResult } from "../types.js";
import { NotFoundError, InvalidStateTransitionError } from "../errors.js";

// Allowed status transitions. Manual expenses are born `active`. Image-uploaded
// expenses pass through processing -> needs_review -> active. `failed` is a
// terminal-ish state from which the user can reprocess (back to processing).
const VALID_TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  active: [],
  processing: ["needs_review", "failed"],
  needs_review: ["processing", "active"],
  failed: ["processing"],
};

type FileMeta = {
  fileKey: string;
  fileName: string;
  fileSize: number;
  fileType: string;
};

/**
 * Create an expense in `processing` state from an uploaded receipt image.
 * The workflow will populate parsed data and move it to `needs_review`.
 */
export async function createExpenseForUpload(
  db: Database,
  params: {
    userId: string;
    file: FileMeta;
  },
): Promise<Expense> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(expenses).values({
    id,
    user_id: params.userId,
    status: "processing",
    merchant: null,
    amount: null,
    currency: "USD",
    expense_date: null,
    category_id: null,
    notes: null,
    file_key: params.file.fileKey,
    file_name: params.file.fileName,
    file_size: params.file.fileSize,
    file_type: params.file.fileType,
    error_message: null,
    workflow_id: null,
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    user_id: params.userId,
    status: "processing",
    merchant: null,
    amount: null,
    currency: "USD",
    expense_date: null,
    category_id: null,
    notes: null,
    file_key: params.file.fileKey,
    file_name: params.file.fileName,
    file_size: params.file.fileSize,
    file_type: params.file.fileType,
    error_message: null,
    workflow_id: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create an expense manually with all fields provided. Optionally attach an
 * image (no parsing). Result is `active` immediately.
 */
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
    file?: FileMeta;
  },
): Promise<Expense> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(expenses).values({
    id,
    user_id: params.userId,
    status: "active",
    merchant: params.merchant,
    amount: params.amount,
    currency: params.currency,
    expense_date: params.date,
    category_id: params.categoryId ?? null,
    notes: params.notes ?? null,
    file_key: params.file?.fileKey ?? null,
    file_name: params.file?.fileName ?? null,
    file_size: params.file?.fileSize ?? null,
    file_type: params.file?.fileType ?? null,
    error_message: null,
    workflow_id: null,
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    user_id: params.userId,
    status: "active",
    merchant: params.merchant,
    amount: params.amount,
    currency: params.currency,
    expense_date: params.date,
    category_id: params.categoryId ?? null,
    notes: params.notes ?? null,
    file_key: params.file?.fileKey ?? null,
    file_name: params.file?.fileName ?? null,
    file_size: params.file?.fileSize ?? null,
    file_type: params.file?.fileType ?? null,
    error_message: null,
    workflow_id: null,
    created_at: now,
    updated_at: now,
  };
}

export async function listExpenses(
  db: Database,
  userId: string,
  opts: {
    status?: ExpenseStatus;
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<PaginatedResult<Expense>> {
  const { status, startDate, endDate, categoryId, search, limit = 20, offset = 0 } = opts;

  const conditions: SQL[] = [eq(expenses.user_id, userId)];
  if (status) conditions.push(eq(expenses.status, status));
  if (startDate) conditions.push(gte(expenses.expense_date, startDate));
  if (endDate) conditions.push(lte(expenses.expense_date, endDate));
  if (categoryId) conditions.push(eq(expenses.category_id, categoryId));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(like(expenses.merchant, pattern), like(expenses.notes, pattern))!,
    );
  }

  const where = and(...conditions);

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(expenses)
      .where(where)
      .orderBy(desc(expenses.updated_at), desc(expenses.created_at))
      .limit(limit)
      .offset(offset) as Promise<Expense[]>,
    db
      .select({ total: count() })
      .from(expenses)
      .where(where),
  ]);

  return { items, total, limit, offset };
}

export async function getExpense(
  db: Database,
  expenseId: string,
  userId?: string,
): Promise<Expense | null> {
  const conditions = userId
    ? and(eq(expenses.id, expenseId), eq(expenses.user_id, userId))
    : eq(expenses.id, expenseId);

  const [row] = await db.select().from(expenses).where(conditions);
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

export async function updateExpenseStatus(
  db: Database,
  expenseId: string,
  newStatus: ExpenseStatus,
  errorMessage?: string,
): Promise<void> {
  const expense = await getExpense(db, expenseId);
  if (!expense) throw new NotFoundError("Expense", expenseId);

  const allowed = VALID_TRANSITIONS[expense.status];
  if (!allowed.includes(newStatus)) {
    throw new InvalidStateTransitionError(expense.status, newStatus);
  }

  await db
    .update(expenses)
    .set({
      status: newStatus,
      error_message: errorMessage ?? null,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(expenses.id, expenseId));
}

export async function updateExpenseWorkflowId(
  db: Database,
  expenseId: string,
  workflowId: string,
): Promise<void> {
  await db
    .update(expenses)
    .set({
      workflow_id: workflowId,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(expenses.id, expenseId));
}

/**
 * Finalize a receipt-uploaded expense: copy the user-confirmed parsed values
 * into the expense fields and transition to `active`. Bypasses the state
 * machine check; callers must verify status is `needs_review` first.
 */
export async function finalizeExpense(
  db: Database,
  expenseId: string,
  fields: {
    merchant: string;
    amount: number;
    currency: string;
    expense_date: string;
    category_id?: string;
    notes?: string;
  },
): Promise<void> {
  await db
    .update(expenses)
    .set({
      status: "active",
      merchant: fields.merchant,
      amount: fields.amount,
      currency: fields.currency,
      expense_date: fields.expense_date,
      category_id: fields.category_id ?? null,
      notes: fields.notes ?? null,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(expenses.id, expenseId));
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

export async function countExpensesByStatus(
  db: Database,
  userId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: expenses.status,
      count: count(),
    })
    .from(expenses)
    .where(eq(expenses.user_id, userId))
    .groupBy(expenses.status);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Spending summary across the user's `active` expenses. Excludes processing /
 * needs_review / failed rows so unconfirmed AI parses don't pollute totals.
 */
export async function getExpenseSummary(
  db: Database,
  userId: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<ExpenseSummary> {
  const { startDate, endDate } = opts;

  const conditions: SQL[] = [
    eq(expenses.user_id, userId),
    eq(expenses.status, "active"),
  ];
  if (startDate) conditions.push(gte(expenses.expense_date, startDate));
  if (endDate) conditions.push(lte(expenses.expense_date, endDate));

  const where = and(...conditions);

  const [totals] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
      count: count(),
    })
    .from(expenses)
    .where(where);

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
