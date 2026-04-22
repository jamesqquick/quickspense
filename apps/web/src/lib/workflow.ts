import { receipts, type Logger } from "@quickspense/domain";

type TriggerResult =
  | { success: true; workflowId: string }
  | { success: false; error: string };

/**
 * Trigger the receipt-processing workflow.
 *
 * In production, uses the Service Binding (`worker.fetch`).
 * In local dev (when `workerDevUrl` is set), uses a plain HTTP fetch to the
 * locally-running worker because Service Bindings don't cross separate
 * `wrangler dev` / `astro dev` processes reliably.
 *
 * Retries once on failure. If both attempts fail, marks the receipt as 'failed'
 * with a descriptive error message so the user can see what happened and retry.
 */
export async function triggerReceiptWorkflow(
  db: D1Database,
  worker: Fetcher,
  receiptId: string,
  userId: string,
  logger?: Logger,
  workerDevUrl?: string,
): Promise<TriggerResult> {
  const body = JSON.stringify({ receiptId, userId });
  let lastError: unknown = null;

  // Dev path: call the worker via its public HTTP URL rather than the Service Binding.
  // This avoids the "Network connection lost" error from miniflare's proxy worker
  // when the web dev server can't reach the separately-running worker dev instance.
  const useDirectFetch = Boolean(workerDevUrl);
  const targetUrl = workerDevUrl
    ? `${workerDevUrl.replace(/\/$/, "")}/workflow/trigger`
    : "https://worker/workflow/trigger";

  // Two attempts total: initial + one retry
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = useDirectFetch
        ? await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
        : await worker.fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });

      if (res.ok) {
        const { workflowId } = (await res.json()) as { workflowId: string };
        await receipts.updateReceiptWorkflowId(db, receiptId, workflowId);
        return { success: true, workflowId };
      }

      lastError = new Error(`Worker returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }

    if (attempt === 1) {
      // Brief delay before retry
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Both attempts failed.
  const errorMessage =
    lastError instanceof Error
      ? `Workflow trigger failed: ${lastError.message}`
      : "Workflow trigger failed";

  logger?.error("Workflow trigger failed after retries", {
    receiptId,
    userId,
    error: lastError,
  });

  // Only move to 'failed' if the receipt is still in 'uploaded' state
  // (i.e. this is the initial upload, not a reprocess).
  // Reprocess attempts leave the receipt in its existing state (needs_review / failed)
  // and the API route surfaces the error via HTTP status.
  try {
    const current = await receipts.getReceipt(db, receiptId);
    if (current?.status === "uploaded") {
      await receipts.updateReceiptStatus(db, receiptId, "failed", errorMessage);
    }
  } catch (e) {
    logger?.error("Failed to mark receipt as failed", { receiptId, error: e });
  }

  return { success: false, error: errorMessage };
}
