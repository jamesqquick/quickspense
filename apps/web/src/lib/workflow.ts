import { expenses, type Logger, type Database } from "@quickspense/domain";

type TriggerResult =
  | { success: true; workflowId: string }
  | { success: false; error: string };

/**
 * Trigger the expense-processing workflow (OCR + extract + persist parsed
 * data on an expense uploaded as an image).
 *
 * In production, uses the Service Binding (`worker.fetch`).
 * In local dev (when `workerDevUrl` is set), uses a plain HTTP fetch to the
 * locally-running worker because Service Bindings don't cross separate
 * `wrangler dev` / `astro dev` processes reliably.
 *
 * Retries once on failure. If both attempts fail, marks the expense as
 * `failed` with a descriptive error message so the user can see what
 * happened and reprocess.
 */
export async function triggerExpenseWorkflow(
  db: Database,
  worker: Fetcher,
  expenseId: string,
  userId: string,
  logger?: Logger,
  workerDevUrl?: string,
): Promise<TriggerResult> {
  const body = JSON.stringify({ expenseId, userId });
  let lastError: unknown = null;

  const useDirectFetch = Boolean(workerDevUrl);
  const targetUrl = workerDevUrl
    ? `${workerDevUrl.replace(/\/$/, "")}/workflow/trigger`
    : "https://worker/workflow/trigger";

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
        await expenses.updateExpenseWorkflowId(db, expenseId, workflowId);
        return { success: true, workflowId };
      }

      lastError = new Error(`Worker returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }

    if (attempt === 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const errorMessage =
    lastError instanceof Error
      ? `Workflow trigger failed: ${lastError.message}`
      : "Workflow trigger failed";

  logger?.error("Workflow trigger failed after retries", {
    expenseId,
    userId,
    error: lastError,
  });

  // Move to 'failed' only for newly created `processing` expenses (initial
  // upload). Reprocess attempts leave the expense in its existing state and
  // surface the error via HTTP status.
  try {
    const current = await expenses.getExpense(db, expenseId);
    if (current?.status === "processing" && !current.workflow_id) {
      await expenses.updateExpenseStatus(db, expenseId, "failed", errorMessage);
    }
  } catch (e) {
    logger?.error("Failed to mark expense as failed", { expenseId, error: e });
  }

  return { success: false, error: errorMessage };
}
