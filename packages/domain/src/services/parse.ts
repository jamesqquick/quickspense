import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { parsedExpenses } from "../db/schema.js";
import type { ParsedExpense } from "../types.js";
import { NotFoundError } from "../errors.js";

export async function createParsedExpense(
  db: Database,
  params: {
    expenseId: string;
    ocrText?: string | null;
    merchant?: string | null;
    totalAmount?: number | null;
    subtotalAmount?: number | null;
    taxAmount?: number | null;
    tipAmount?: number | null;
    currency?: string | null;
    purchaseDate?: string | null;
    suggestedCategory?: string | null;
    confidenceScore?: number | null;
    rawResponse?: string | null;
  },
): Promise<ParsedExpense> {
  const id = crypto.randomUUID();

  await db.insert(parsedExpenses).values({
    id,
    expense_id: params.expenseId,
    ocr_text: params.ocrText ?? null,
    merchant: params.merchant ?? null,
    total_amount: params.totalAmount ?? null,
    subtotal_amount: params.subtotalAmount ?? null,
    tax_amount: params.taxAmount ?? null,
    tip_amount: params.tipAmount ?? null,
    currency: params.currency ?? null,
    purchase_date: params.purchaseDate ?? null,
    suggested_category: params.suggestedCategory ?? null,
    confidence_score: params.confidenceScore ?? null,
    raw_response: params.rawResponse ?? null,
  });

  return {
    id,
    expense_id: params.expenseId,
    ocr_text: params.ocrText ?? null,
    merchant: params.merchant ?? null,
    total_amount: params.totalAmount ?? null,
    subtotal_amount: params.subtotalAmount ?? null,
    tax_amount: params.taxAmount ?? null,
    tip_amount: params.tipAmount ?? null,
    currency: params.currency ?? null,
    purchase_date: params.purchaseDate ?? null,
    suggested_category: params.suggestedCategory ?? null,
    confidence_score: params.confidenceScore ?? null,
    raw_response: params.rawResponse ?? null,
    created_at: new Date().toISOString(),
  };
}

export async function getLatestParsedExpense(
  db: Database,
  expenseId: string,
): Promise<ParsedExpense | null> {
  const [row] = await db
    .select()
    .from(parsedExpenses)
    .where(eq(parsedExpenses.expense_id, expenseId))
    .orderBy(desc(parsedExpenses.created_at))
    .limit(1);
  return row ?? null;
}

export async function updateParsedExpenseFields(
  db: Database,
  parsedExpenseId: string,
  fields: {
    merchant?: string;
    total_amount?: number;
    subtotal_amount?: number | null;
    tax_amount?: number | null;
    tip_amount?: number | null;
    currency?: string;
    purchase_date?: string;
    suggested_category?: string | null;
  },
): Promise<ParsedExpense> {
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    const [existing] = await db
      .select()
      .from(parsedExpenses)
      .where(eq(parsedExpenses.id, parsedExpenseId));
    if (!existing) throw new NotFoundError("ParsedExpense", parsedExpenseId);
    return existing;
  }

  await db
    .update(parsedExpenses)
    .set(updates)
    .where(eq(parsedExpenses.id, parsedExpenseId));

  const [updated] = await db
    .select()
    .from(parsedExpenses)
    .where(eq(parsedExpenses.id, parsedExpenseId));
  if (!updated) throw new NotFoundError("ParsedExpense", parsedExpenseId);
  return updated;
}
