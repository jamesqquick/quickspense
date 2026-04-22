import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  receipts,
  parse,
  expenses,
  categories,
  ConflictError,
  NotFoundError,
  InvalidStateTransitionError,
} from "@quickspense/domain";
import type { Env } from "../index.js";

/**
 * Convert a domain error into an MCP tool error response.
 */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Wrap a tool handler so domain errors are converted to MCP error responses
 * rather than bubbling up as unhandled exceptions.
 */
async function runTool<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await fn();
    return {
      content: [
        { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
      ],
    };
  } catch (e: unknown) {
    if (
      e instanceof NotFoundError ||
      e instanceof ConflictError ||
      e instanceof InvalidStateTransitionError
    ) {
      return errorResponse(e.message);
    }
    console.error("MCP tool error:", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error");
  }
}

export function createServer(env: Env, userId: string): McpServer {
  const server = new McpServer({
    name: "Quickspense MCP",
    version: "1.0.0",
  });

  const db = env.DB;

  // --- RECEIPT TOOLS ---

  server.tool(
    "list_receipts",
    "List user's receipts, optionally filtered by status",
    {
      status: z
        .enum(["uploaded", "processing", "needs_review", "finalized", "failed"])
        .optional()
        .describe("Filter by receipt status"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
      offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
    },
    async ({ status, limit, offset }) =>
      runTool(() => receipts.listReceipts(db, userId, { status, limit, offset })),
  );

  server.tool(
    "get_receipt",
    "Get receipt detail including latest parsed data",
    {
      receiptId: z.string().describe("Receipt ID"),
    },
    async ({ receiptId }) =>
      runTool(async () => {
        const receipt = await receipts.getReceipt(db, receiptId, userId);
        if (!receipt) throw new NotFoundError("Receipt", receiptId);
        const parsed = await parse.getLatestParsedReceipt(db, receiptId);
        return { receipt, parsed };
      }),
  );

  server.tool(
    "reprocess_receipt",
    "Trigger fresh AI processing for a receipt",
    {
      receiptId: z.string().describe("Receipt ID"),
    },
    async ({ receiptId }) =>
      runTool(async () => {
        const receipt = await receipts.getReceipt(db, receiptId, userId);
        if (!receipt) throw new NotFoundError("Receipt", receiptId);
        if (!["needs_review", "failed"].includes(receipt.status)) {
          throw new InvalidStateTransitionError(receipt.status, "processing");
        }
        const instance = await env.RECEIPT_WORKFLOW.create({
          params: { receiptId, userId },
        });
        await receipts.updateReceiptWorkflowId(db, receiptId, instance.id);
        return `Reprocessing started. Workflow ID: ${instance.id}`;
      }),
  );

  server.tool(
    "update_receipt_fields",
    "Edit parsed fields on a receipt",
    {
      receiptId: z.string().describe("Receipt ID"),
      merchant: z.string().optional().describe("Merchant name"),
      total_amount: z.number().int().optional().describe("Total in cents"),
      subtotal_amount: z.number().int().nullable().optional().describe("Subtotal in cents"),
      tax_amount: z.number().int().nullable().optional().describe("Tax in cents"),
      tip_amount: z.number().int().nullable().optional().describe("Tip in cents"),
      currency: z.string().max(3).optional().describe("Currency code"),
      purchase_date: z.string().optional().describe("Date YYYY-MM-DD"),
      suggested_category: z.string().nullable().optional().describe("Category suggestion"),
    },
    async ({ receiptId, ...fields }) =>
      runTool(async () => {
        // Authz: confirm receipt belongs to user before touching parsed data
        const receipt = await receipts.getReceipt(db, receiptId, userId);
        if (!receipt) throw new NotFoundError("Receipt", receiptId);

        const latest = await parse.getLatestParsedReceipt(db, receiptId);
        if (!latest) throw new NotFoundError("ParsedReceipt for", receiptId);

        const updated = await parse.updateParsedReceiptFields(db, latest.id, fields);
        return updated;
      }),
  );

  server.tool(
    "finalize_receipt",
    "Confirm receipt and create an expense record",
    {
      receiptId: z.string().describe("Receipt ID"),
      merchant: z.string().describe("Merchant name"),
      amount: z.number().int().positive().describe("Amount in cents"),
      currency: z.string().max(3).describe("Currency code"),
      expense_date: z.string().describe("Date YYYY-MM-DD"),
      category_id: z.string().optional().describe("Category ID"),
      notes: z.string().optional().describe("Notes"),
    },
    async ({ receiptId, merchant, amount, currency, expense_date, category_id, notes }) =>
      runTool(async () => {
        const receipt = await receipts.getReceipt(db, receiptId, userId);
        if (!receipt) throw new NotFoundError("Receipt", receiptId);
        if (receipt.status !== "needs_review") {
          throw new InvalidStateTransitionError(receipt.status, "finalized");
        }
        const expense = await expenses.createExpenseFromReceipt(db, {
          receiptId,
          userId,
          merchant,
          amount,
          currency,
          date: expense_date,
          categoryId: category_id,
          notes,
        });
        // Direct status update since updateReceiptStatus enforces valid transitions and we already checked
        await db
          .prepare(
            "UPDATE receipts SET status = 'finalized', updated_at = datetime('now') WHERE id = ?",
          )
          .bind(receiptId)
          .run();
        return expense;
      }),
  );

  // --- EXPENSE TOOLS ---

  server.tool(
    "list_expenses",
    "List expenses with optional filters",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      categoryId: z.string().optional().describe("Category ID filter"),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    async ({ startDate, endDate, categoryId, limit, offset }) =>
      runTool(() =>
        expenses.listExpenses(db, userId, { startDate, endDate, categoryId, limit, offset }),
      ),
  );

  server.tool(
    "create_expense",
    "Create a manual expense (no receipt)",
    {
      merchant: z.string().describe("Merchant name"),
      amount: z.number().int().positive().describe("Amount in cents"),
      currency: z.string().max(3).default("USD").describe("Currency code"),
      expense_date: z.string().describe("Date YYYY-MM-DD"),
      category_id: z.string().optional().describe("Category ID"),
      notes: z.string().optional().describe("Notes"),
    },
    async ({ merchant, amount, currency, expense_date, category_id, notes }) =>
      runTool(() =>
        expenses.createManualExpense(db, {
          userId,
          merchant,
          amount,
          currency,
          date: expense_date,
          categoryId: category_id,
          notes,
        }),
      ),
  );

  server.tool(
    "update_expense",
    "Update an existing expense",
    {
      expenseId: z.string().describe("Expense ID"),
      merchant: z.string().optional(),
      amount: z.number().int().positive().optional(),
      currency: z.string().max(3).optional(),
      expense_date: z.string().optional(),
      category_id: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    async ({ expenseId, ...fields }) =>
      runTool(() => expenses.updateExpense(db, expenseId, userId, fields)),
  );

  // --- CATEGORY TOOLS ---

  server.tool(
    "list_categories",
    "List all expense categories",
    {},
    async () => runTool(() => categories.listCategories(db, userId)),
  );

  server.tool(
    "create_category",
    "Create a new expense category",
    {
      name: z.string().min(1).max(100).describe("Category name"),
    },
    async ({ name }) =>
      runTool(() => categories.createCategory(db, userId, name)),
  );

  // --- RESOURCES ---

  server.resource(
    "receipt-detail",
    "receipt://{id}",
    { description: "Receipt record with parsed data" },
    async (uri) => {
      const receiptId = uri.pathname.replace(/^\/\//, "");
      const receipt = await receipts.getReceipt(db, receiptId, userId);
      const parsed = receipt ? await parse.getLatestParsedReceipt(db, receiptId) : null;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ receipt, parsed }, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "receipt-text",
    "receipt://{id}/text",
    { description: "Raw OCR text from receipt" },
    async (uri) => {
      const receiptId = uri.pathname.replace(/^\/\//, "").split("/")[0];
      // Authz check first
      const receipt = await receipts.getReceipt(db, receiptId, userId);
      const text = receipt
        ? (await parse.getLatestParsedReceipt(db, receiptId))?.ocr_text || "No OCR text available"
        : "Receipt not found";
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text }],
      };
    },
  );

  server.resource(
    "expense-detail",
    "expense://{id}",
    { description: "Expense record" },
    async (uri) => {
      const expenseId = uri.pathname.replace(/^\/\//, "");
      const expense = await expenses.getExpense(db, expenseId, userId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(expense, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "dashboard-summary",
    "summary://dashboard",
    { description: "Spending summary stats" },
    async (uri) => {
      const summary = await expenses.getExpenseSummary(db, userId);
      const receiptCounts = await receipts.countReceiptsByStatus(db, userId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ summary, receiptCounts }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
