import type { APIRoute } from "astro";
import { createDb, expenses, finalizeExpenseSchema } from "@quickspense/domain";

/**
 * Finalize a `needs_review` expense: copy the user-confirmed fields onto the
 * expense and transition to `active`.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
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

    if (expense.status !== "needs_review") {
      return new Response(
        JSON.stringify({
          error: `Cannot finalize expense in '${expense.status}' state`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await request.json();
    const parsed = finalizeExpenseSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await expenses.finalizeExpense(db, expenseId, {
      merchant: parsed.data.merchant,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      expense_date: parsed.data.expense_date,
      category_id: parsed.data.category_id,
      notes: parsed.data.notes,
    });

    const finalized = await expenses.getExpense(db, expenseId, user.id);

    return new Response(JSON.stringify({ expense: finalized }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    console.error("Finalize error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
