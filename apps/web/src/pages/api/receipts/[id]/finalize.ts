import type { APIRoute } from "astro";
import { createDb, receipts, expenses, finalizeReceiptSchema } from "@quickspense/domain";

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const receiptId = params.id!;

    const receipt = await receipts.getReceipt(db, receiptId, user.id);
    if (!receipt) {
      return new Response(JSON.stringify({ error: "Receipt not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (receipt.status !== "needs_review") {
      return new Response(
        JSON.stringify({
          error: `Cannot finalize receipt in '${receipt.status}' state`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await request.json();
    const parsed = finalizeReceiptSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Create expense
    const expense = await expenses.createExpenseFromReceipt(db, {
      receiptId,
      userId: user.id,
      merchant: parsed.data.merchant,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      date: parsed.data.expense_date,
      categoryId: parsed.data.category_id,
      notes: parsed.data.notes,
    });

    // Mark receipt as finalized
    await receipts.finalizeReceipt(db, receiptId);

    return new Response(JSON.stringify({ expense }), {
      status: 201,
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
