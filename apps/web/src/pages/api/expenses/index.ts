import type { APIRoute } from "astro";
import { expenses, listExpensesSchema, createManualExpenseSchema } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;

  const params = listExpensesSchema.safeParse({
    startDate: url.searchParams.get("startDate") || undefined,
    endDate: url.searchParams.get("endDate") || undefined,
    categoryId: url.searchParams.get("categoryId") || undefined,
    limit: url.searchParams.get("limit") || 20,
    offset: url.searchParams.get("offset") || 0,
  });

  if (!params.success) {
    return new Response(
      JSON.stringify({ error: params.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const list = await expenses.listExpenses(db, user.id, params.data);
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = locals.runtime.env.DB;

    const body = await request.json();
    const parsed = createManualExpenseSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const expense = await expenses.createManualExpense(db, {
      userId: user.id,
      merchant: parsed.data.merchant,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      date: parsed.data.expense_date,
      categoryId: parsed.data.category_id,
      notes: parsed.data.notes,
    });

    return new Response(JSON.stringify(expense), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    console.error("Create expense error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
