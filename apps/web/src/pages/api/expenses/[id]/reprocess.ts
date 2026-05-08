import type { APIRoute } from "astro";
import { expenses, createDb } from "@quickspense/domain";
import { triggerExpenseWorkflow } from "../../../../lib/workflow";

/**
 * Re-trigger AI parse on an expense currently in `needs_review` or `failed`.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const worker = locals.runtime.env.WORKER;
  const expenseId = params.id!;

  const expense = await expenses.getExpense(db, expenseId, user.id);
  if (!expense) {
    return new Response(JSON.stringify({ error: "Expense not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!["needs_review", "failed"].includes(expense.status)) {
    return new Response(
      JSON.stringify({
        error: `Cannot reprocess expense in '${expense.status}' state`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!expense.file_key) {
    return new Response(
      JSON.stringify({ error: "Expense has no attached image to reprocess" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const logger = locals.logger.child({ expenseId: expense.id });
  logger.info("Reprocessing expense");
  const triggerResult = await triggerExpenseWorkflow(
    db,
    worker,
    expense.id,
    user.id,
    logger,
    locals.runtime.env.WORKER_DEV_URL,
  );

  if (!triggerResult.success) {
    return new Response(
      JSON.stringify({ error: triggerResult.error }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ success: true, workflowId: triggerResult.workflowId }),
    { headers: { "Content-Type": "application/json" } },
  );
};
