import type { APIRoute } from "astro";
import { receipts, listReceiptsSchema } from "@quickspense/domain";
import { triggerReceiptWorkflow } from "../../../lib/workflow";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;

  const params = listReceiptsSchema.safeParse({
    status: url.searchParams.get("status") || undefined,
    limit: url.searchParams.get("limit") || 20,
    offset: url.searchParams.get("offset") || 0,
  });

  if (!params.success) {
    return new Response(JSON.stringify({ error: params.error.issues[0].message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const list = await receipts.listReceipts(db, user.id, params.data);
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = locals.runtime.env.DB;
    const bucket = locals.runtime.env.BUCKET;
    const worker = locals.runtime.env.WORKER;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: "File must be JPEG, PNG, or WEBP" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (file.size > MAX_SIZE) {
      return new Response(
        JSON.stringify({ error: "File must be under 10MB" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const receiptId = crypto.randomUUID();
    const fileKey = `receipts/${receiptId}/${file.name}`;

    // Store in R2
    await bucket.put(fileKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });

    // Insert receipt record
    const receipt = await receipts.createReceipt(db, {
      userId: user.id,
      fileKey,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
    });

    // Trigger workflow with built-in retry + failure handling.
    // If trigger fails, the helper marks the receipt as 'failed' so the user
    // sees it in the UI and can reprocess to try again.
    const logger = locals.logger.child({ receiptId: receipt.id });
    logger.info("Receipt created, triggering workflow");
    const triggerResult = await triggerReceiptWorkflow(
      db,
      worker,
      receipt.id,
      user.id,
      logger,
      locals.runtime.env.WORKER_DEV_URL,
    );

    // Re-fetch the receipt so we return the current status (may be 'failed' if trigger failed)
    const finalReceipt = (await receipts.getReceipt(db, receipt.id, user.id)) ?? receipt;

    return new Response(
      JSON.stringify(triggerResult.success ? finalReceipt : { ...finalReceipt, trigger_error: triggerResult.error }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    console.error("Upload error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
