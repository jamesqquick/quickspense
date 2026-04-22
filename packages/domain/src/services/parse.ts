import type { ParsedReceipt } from "../types.js";
import { NotFoundError } from "../errors.js";

export async function createParsedReceipt(
  db: D1Database,
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

  await db
    .prepare(
      `INSERT INTO parsed_receipts
       (id, receipt_id, ocr_text, merchant, total_amount, subtotal_amount, tax_amount, tip_amount, currency, purchase_date, suggested_category, confidence_score, raw_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.receiptId,
      params.ocrText ?? null,
      params.merchant ?? null,
      params.totalAmount ?? null,
      params.subtotalAmount ?? null,
      params.taxAmount ?? null,
      params.tipAmount ?? null,
      params.currency ?? null,
      params.purchaseDate ?? null,
      params.suggestedCategory ?? null,
      params.confidenceScore ?? null,
      params.rawResponse ?? null,
    )
    .run();

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
  db: D1Database,
  receiptId: string,
): Promise<ParsedReceipt | null> {
  const row = await db
    .prepare(
      "SELECT * FROM parsed_receipts WHERE receipt_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(receiptId)
    .first<ParsedReceipt>();
  return row ?? null;
}

export async function updateParsedReceiptFields(
  db: D1Database,
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
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) {
    const existing = await db
      .prepare("SELECT * FROM parsed_receipts WHERE id = ?")
      .bind(parsedReceiptId)
      .first<ParsedReceipt>();
    if (!existing) throw new NotFoundError("ParsedReceipt", parsedReceiptId);
    return existing;
  }

  values.push(parsedReceiptId);
  await db
    .prepare(`UPDATE parsed_receipts SET ${setClauses.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await db
    .prepare("SELECT * FROM parsed_receipts WHERE id = ?")
    .bind(parsedReceiptId)
    .first<ParsedReceipt>();
  if (!updated) throw new NotFoundError("ParsedReceipt", parsedReceiptId);
  return updated;
}
