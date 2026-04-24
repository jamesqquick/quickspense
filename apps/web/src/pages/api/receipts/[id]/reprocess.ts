import type { APIRoute } from "astro";
import { receipts, createDb } from "@quickspense/domain";
import { triggerReceiptWorkflow } from "../../../../lib/workflow";

export const POST: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const worker = locals.runtime.env.WORKER;
  const receiptId = params.id!;

  const receipt = await receipts.getReceipt(db, receiptId, user.id);
  if (!receipt) {
    return new Response(JSON.stringify({ error: "Receipt not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!["needs_review", "failed"].includes(receipt.status)) {
    return new Response(
      JSON.stringify({ error: `Cannot reprocess receipt in '${receipt.status}' state` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const logger = locals.logger.child({ receiptId: receipt.id });
  logger.info("Reprocessing receipt");
  const triggerResult = await triggerReceiptWorkflow(
    db,
    worker,
    receipt.id,
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
