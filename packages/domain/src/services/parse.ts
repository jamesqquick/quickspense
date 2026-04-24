import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { parsedReceipts } from "../db/schema.js";
import type { ParsedReceipt } from "../types.js";
import { NotFoundError } from "../errors.js";

export async function createParsedReceipt(
  db: Database,
  params: {
    receiptId: string;
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
): Promise<ParsedReceipt> {
  const id = crypto.randomUUID();

  await db.insert(parsedReceipts).values({
    id,
    receipt_id: params.receiptId,
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
    receipt_id: params.receiptId,
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

export async function getLatestParsedReceipt(
  db: Database,
  receiptId: string,
): Promise<ParsedReceipt | null> {
  const [row] = await db
    .select()
    .from(parsedReceipts)
    .where(eq(parsedReceipts.receipt_id, receiptId))
    .orderBy(desc(parsedReceipts.created_at))
    .limit(1);
  return row ?? null;
}

export async function updateParsedReceiptFields(
  db: Database,
  parsedReceiptId: string,
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
): Promise<ParsedReceipt> {
  // Filter out undefined values to build the SET clause
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    const [existing] = await db
      .select()
      .from(parsedReceipts)
      .where(eq(parsedReceipts.id, parsedReceiptId));
    if (!existing) throw new NotFoundError("ParsedReceipt", parsedReceiptId);
    return existing;
  }

  await db
    .update(parsedReceipts)
    .set(updates)
    .where(eq(parsedReceipts.id, parsedReceiptId));

  const [updated] = await db
    .select()
    .from(parsedReceipts)
    .where(eq(parsedReceipts.id, parsedReceiptId));
  if (!updated) throw new NotFoundError("ParsedReceipt", parsedReceiptId);
  return updated;
}
