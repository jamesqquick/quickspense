import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  parse,
  expenses,
  categories,
  ConflictError,
  NotFoundError,
  InvalidStateTransitionError,
  ForbiddenError,
} from "@quickspense/domain";
import type { Database } from "@quickspense/domain";
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
      e instanceof InvalidStateTransitionError ||
      e instanceof ForbiddenError
    ) {
      return errorResponse(e.message);
    }
    console.error("MCP tool error:", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error");
  }
}

export function createServer(env: Env, db: Database, userId: string): McpServer {
  const server = new McpServer({
    name: "Quickspense MCP",
    version: "1.0.0",
  });

  // --- EXPENSE TOOLS ---

  server.tool(
    "list_expenses",
    "List expenses with optional status/date/category filters. Use search to find expenses by merchant or notes.",
    {
      status: z
        .enum(["active", "processing", "needs_review", "failed"])
        .optional()
        .describe("Filter by expense status"),
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      categoryId: z.string().optional().describe("Category ID filter"),
      search: z.string().max(200).optional().describe("Search merchant name or notes"),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    async ({ status, startDate, endDate, categoryId, search, limit, offset }) =>
      runTool(() =>
        expenses.listExpenses(db, userId, {
          status,
          startDate,
          endDate,
          categoryId,
          search,
          limit,
          offset,
        }),
      ),
  );

  server.tool(
    "get_expense",
    "Get expense detail including its latest parsed data (if any)",
    {
      expenseId: z.string().describe("Expense ID"),
    },
    async ({ expenseId }) =>
      runTool(async () => {
        const expense = await expenses.getExpense(db, expenseId, userId);
        if (!expense) throw new NotFoundError("Expense", expenseId);
        const parsed = await parse.getLatestParsedExpense(db, expenseId);
        return { expense, parsed };
      }),
  );

  server.tool(
    "create_expense",
    "Create a manual expense (no image attached, status='active')",
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
    "Update an active expense's fields",
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

  server.tool(
    "update_expense_parsed_fields",
    "Edit AI-parsed fields on a `needs_review` expense before finalizing",
    {
      expenseId: z.string().describe("Expense ID"),
      merchant: z.string().optional().describe("Merchant name"),
      total_amount: z.number().int().optional().describe("Total in cents"),
      subtotal_amount: z.number().int().nullable().optional().describe("Subtotal in cents"),
      tax_amount: z.number().int().nullable().optional().describe("Tax in cents"),
      tip_amount: z.number().int().nullable().optional().describe("Tip in cents"),
      currency: z.string().max(3).optional().describe("Currency code"),
      purchase_date: z.string().optional().describe("Date YYYY-MM-DD"),
      suggested_category: z.string().nullable().optional().describe("Category suggestion"),
    },
    async ({ expenseId, ...fields }) =>
      runTool(async () => {
        const expense = await expenses.getExpense(db, expenseId, userId);
        if (!expense) throw new NotFoundError("Expense", expenseId);

        const latest = await parse.getLatestParsedExpense(db, expenseId);
        if (!latest) throw new NotFoundError("ParsedExpense for", expenseId);

        const updated = await parse.updateParsedExpenseFields(db, latest.id, fields);
        return updated;
      }),
  );

  server.tool(
    "finalize_expense",
    "Confirm a `needs_review` expense and transition it to `active`",
    {
      expenseId: z.string().describe("Expense ID"),
      merchant: z.string().describe("Merchant name"),
      amount: z.number().int().positive().describe("Amount in cents"),
      currency: z.string().max(3).describe("Currency code"),
      expense_date: z.string().describe("Date YYYY-MM-DD"),
      category_id: z.string().optional().describe("Category ID"),
      notes: z.string().optional().describe("Notes"),
    },
    async ({ expenseId, merchant, amount, currency, expense_date, category_id, notes }) =>
      runTool(async () => {
        const expense = await expenses.getExpense(db, expenseId, userId);
        if (!expense) throw new NotFoundError("Expense", expenseId);
        if (expense.status !== "needs_review") {
          throw new InvalidStateTransitionError(expense.status, "active");
        }
        await expenses.finalizeExpense(db, expenseId, {
          merchant,
          amount,
          currency,
          expense_date,
          category_id,
          notes,
        });
        return await expenses.getExpense(db, expenseId, userId);
      }),
  );

  server.tool(
    "reprocess_expense",
    "Trigger fresh AI processing on an expense in `needs_review` or `failed`",
    {
      expenseId: z.string().describe("Expense ID"),
    },
    async ({ expenseId }) =>
      runTool(async () => {
        const expense = await expenses.getExpense(db, expenseId, userId);
        if (!expense) throw new NotFoundError("Expense", expenseId);
        if (!["needs_review", "failed"].includes(expense.status)) {
          throw new InvalidStateTransitionError(expense.status, "processing");
        }
        if (!expense.file_key) {
          throw new Error("Expense has no attached image to reprocess");
        }
        const instance = await env.EXPENSE_WORKFLOW.create({
          params: { expenseId, userId },
        });
        await expenses.updateExpenseWorkflowId(db, expenseId, instance.id);
        return `Reprocessing started. Workflow ID: ${instance.id}`;
      }),
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
    "expense-detail",
    "expense://{id}",
    { description: "Expense record with parsed data (if any)" },
    async (uri) => {
      const expenseId = uri.pathname.replace(/^\/\//, "");
      const expense = await expenses.getExpense(db, expenseId, userId);
      const parsed = expense ? await parse.getLatestParsedExpense(db, expenseId) : null;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ expense, parsed }, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "expense-text",
    "expense://{id}/text",
    { description: "Raw OCR text from a receipt-uploaded expense" },
    async (uri) => {
      const expenseId = uri.pathname.replace(/^\/\//, "").split("/")[0];
      const expense = await expenses.getExpense(db, expenseId, userId);
      const text = expense
        ? (await parse.getLatestParsedExpense(db, expenseId))?.ocr_text ||
          "No OCR text available"
        : "Expense not found";
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text }],
      };
    },
  );

  server.resource(
    "dashboard-summary",
    "summary://dashboard",
    { description: "Spending summary plus expense status counts" },
    async (uri) => {
      const summary = await expenses.getExpenseSummary(db, userId);
      const expenseCounts = await expenses.countExpensesByStatus(db, userId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ summary, expenseCounts }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
