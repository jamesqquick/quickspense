import type { APIRoute } from "astro";
import {
  expenses,
  parse,
  updateExpenseSchema,
  updateParsedFieldsSchema,
  createDb,
} from "@quickspense/domain";

/**
 * Get a single expense and its latest parsed data (if any).
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const expenseId = params.id!;

  const expense = await expenses.getExpense(db, expenseId, user.id);
  if (!expense) {
    return new Response(JSON.stringify({ error: "Expense not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parsed = await parse.getLatestParsedExpense(db, expenseId);

  return new Response(JSON.stringify({ expense, parsed }), {
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Update an expense.
 *
 * Behavior depends on status:
 *   - active: updates the expense row directly using `updateExpenseSchema`.
 *   - needs_review: updates the latest parsed_expenses row (parse fields)
 *     using `updateParsedFieldsSchema`. The user is editing the AI's draft
 *     before they finalize.
 *   - processing/failed: not editable, returns 400.
 */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const expenseId = params.id!;

    const expense = await expenses.getExpense(db, expenseId, user.id);
    if (!expense) {
      return new Response(JSON.stringify({ error: "Expense not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();

    if (expense.status === "active") {
      const parsed = updateExpenseSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: parsed.error.issues[0].message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const updated = await expenses.updateExpense(
        db,
        expenseId,
        user.id,
        parsed.data,
      );
      return new Response(JSON.stringify(updated), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (expense.status === "needs_review") {
      const parsed = updateParsedFieldsSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: parsed.error.issues[0].message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const latest = await parse.getLatestParsedExpense(db, expenseId);
      if (!latest) {
        return new Response(
          JSON.stringify({ error: "No parsed data to update" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      const updated = await parse.updateParsedExpenseFields(
        db,
        latest.id,
        parsed.data,
      );
      return new Response(JSON.stringify(updated), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: `Cannot edit expense in '${expense.status}' state`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NotFoundError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Update expense error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const expenseId = params.id!;

    await expenses.deleteExpense(db, expenseId, user.id);
    return new Response(null, { status: 204 });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NotFoundError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Delete expense error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
