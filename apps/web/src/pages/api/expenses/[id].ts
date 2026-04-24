import type { APIRoute } from "astro";
import { expenses, updateExpenseSchema, createDb } from "@quickspense/domain";

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const expenseId = params.id!;

    const body = await request.json();
    const parsed = updateExpenseSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await expenses.updateExpense(db, expenseId, user.id, parsed.data);
    return new Response(JSON.stringify(updated), {
      headers: { "Content-Type": "application/json" },
    });
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
