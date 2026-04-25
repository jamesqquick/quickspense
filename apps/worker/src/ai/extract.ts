export type ExtractedData = {
  merchant: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  currency: string | null;
  date: string | null;
  category: string | null;
  confidence: number | null;
};

const EXTRACTION_PROMPT = `You are a receipt parser. Given the OCR text from a receipt, extract the following fields as JSON:

{
  "merchant": "store/restaurant name",
  "total": total amount as a number (e.g., 42.50),
  "subtotal": subtotal before tax as a number or null,
  "tax": tax amount as a number or null,
  "tip": tip amount as a number or null,
  "currency": "USD" or other 3-letter code,
  "date": "YYYY-MM-DD" format or null,
  "category": best guess from these categories: "Food & Dining", "Groceries", "Transportation", "Shopping", "Entertainment", "Healthcare", "Utilities", "Housing", "Insurance", "Education", "Personal Care", "Travel", "Subscriptions", "Gifts & Donations", "Automotive", "Home & Garden", "Pets", "Office & Business", "Taxes & Fees", "Other",
  "confidence": your confidence in the extraction from 0.0 to 1.0
}

Rules:
- Output ONLY valid JSON, no other text
- Use null for fields you cannot determine
- Monetary values should be plain numbers (not strings)
- Date must be YYYY-MM-DD format
- If you can't determine the currency, use "USD"`;

export async function extractStructuredData(
  ai: Ai,
  ocrText: string,
): Promise<ExtractedData> {
  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: ocrText },
    ],
    max_tokens: 512,
  }) as { response?: string };

  const raw = response.response || "{}";

  // Try to extract JSON from the response
  let parsed: Record<string, unknown>;
  try {
    // Try direct parse first
    parsed = JSON.parse(raw);
  } catch {
    // Try to find JSON in the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = {};
      }
    } else {
      parsed = {};
    }
  }

  return {
    merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
    total: typeof parsed.total === "number" ? parsed.total : null,
    subtotal: typeof parsed.subtotal === "number" ? parsed.subtotal : null,
    tax: typeof parsed.tax === "number" ? parsed.tax : null,
    tip: typeof parsed.tip === "number" ? parsed.tip : null,
    currency: typeof parsed.currency === "string" ? parsed.currency : null,
    date: typeof parsed.date === "string" ? parsed.date : null,
    category: typeof parsed.category === "string" ? parsed.category : null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
  };
}

/** Convert dollar amount to cents (integer) */
function toCents(amount: number | null): number | null {
  if (amount === null) return null;
  return Math.round(amount * 100);
}

/** Normalize date to YYYY-MM-DD */
function normalizeDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

/** Title-case a merchant name */
function normalizeMerchant(merchant: string | null): string | null {
  if (!merchant) return null;
  return merchant
    .trim()
    .replace(
      /\w\S*/g,
      (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase(),
    );
}

/** Clamp confidence to 0-1 range */
function normalizeConfidence(conf: number | null): number | null {
  if (conf === null) return null;
  return Math.max(0, Math.min(1, conf));
}

export function normalizeExtractedData(data: ExtractedData) {
  return {
    merchant: normalizeMerchant(data.merchant),
    totalAmount: toCents(data.total),
    subtotalAmount: toCents(data.subtotal),
    taxAmount: toCents(data.tax),
    tipAmount: toCents(data.tip),
    currency: data.currency?.toUpperCase().slice(0, 3) || "USD",
    purchaseDate: normalizeDate(data.date),
    suggestedCategory: data.category,
    confidenceScore: normalizeConfidence(data.confidence),
  };
}
