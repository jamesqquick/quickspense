import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { createDb, createLogger, expenses, parse } from "@quickspense/domain";
import type { Env } from "./index.js";
import { extractTextFromImage } from "./ai/ocr.js";
import {
  extractStructuredData,
  normalizeExtractedData,
} from "./ai/extract.js";
import type { ExpenseStatusDO, StatusUpdate } from "./expense-status.js";

type WorkflowParams = {
  expenseId: string;
  userId: string;
};

/**
 * Renamed from `ReceiptProcessingWorkflow`. Processes an expense's attached
 * image: OCR -> structured extract -> normalize -> persist parsed data ->
 * status `needs_review`. The user then reviews and finalizes.
 */
export class ExpenseProcessingWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowParams
> {
  private notifyStatus(expenseId: string, update: Omit<StatusUpdate, "timestamp">): void {
    const stub = this.env.EXPENSE_STATUS_DO.idFromName(expenseId);
    const obj = this.env.EXPENSE_STATUS_DO.get(stub) as DurableObjectStub<ExpenseStatusDO>;
    obj.notify({ ...update, timestamp: Date.now() }).catch(() => {
      // Best-effort: don't fail the workflow if notification fails
    });
  }

  async run(
    event: WorkflowEvent<WorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { expenseId, userId } = event.payload;
    const logger = createLogger({
      service: "worker",
      workflow: "expense-processing",
      workflowId: event.instanceId,
      expenseId,
      userId,
    });
    logger.info("Workflow starting");

    const db = createDb(this.env.DB);

    // Idempotency guard: no-op if the expense is already active or finalized
    // through another path.
    const shouldSkip = await step.do("idempotency-check", async () => {
      const expense = await expenses.getExpense(db, expenseId);
      if (!expense) return true;
      if (expense.status === "active") return true;
      return false;
    });

    if (shouldSkip) {
      logger.info("Workflow skipped by idempotency check");
      return;
    }

    try {
      // Expense is created in `processing` already (or transitioning back from
      // failed/needs_review on reprocess). Ensure it's set if the caller
      // bypassed that for any reason.
      this.notifyStatus(expenseId, {
        status: "processing",
        step: "mark-processing",
        detail: "Starting receipt processing...",
      });

      // OCR step. Combines R2 fetch + OCR call to keep step output under 1 MiB.
      const ocrText = await step.do(
        "ocr",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => {
          const expense = await expenses.getExpense(db, expenseId);
          if (!expense) throw new Error(`Expense ${expenseId} not found`);
          if (!expense.file_key || !expense.file_type) {
            throw new Error(`Expense ${expenseId} has no attached image`);
          }

          const object = await this.env.BUCKET.get(expense.file_key);
          if (!object) throw new Error(`File not found in R2: ${expense.file_key}`);

          const arrayBuffer = await object.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);

          return extractTextFromImage(this.env.AI, base64, expense.file_type);
        },
      );
      this.notifyStatus(expenseId, {
        status: "processing",
        step: "ocr",
        detail: "Reading receipt text...",
      });

      const extracted = await step.do(
        "extract",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => extractStructuredData(this.env.AI, ocrText),
      );
      this.notifyStatus(expenseId, {
        status: "processing",
        step: "extract",
        detail: "Extracting receipt data...",
      });

      const normalized = await step.do("normalize", async () =>
        normalizeExtractedData(extracted),
      );
      this.notifyStatus(expenseId, {
        status: "processing",
        step: "normalize",
        detail: "Normalizing data...",
      });

      await step.do("persist-results", async () => {
        await parse.createParsedExpense(db, {
          expenseId,
          ocrText,
          merchant: normalized.merchant,
          totalAmount: normalized.totalAmount,
          subtotalAmount: normalized.subtotalAmount,
          taxAmount: normalized.taxAmount,
          tipAmount: normalized.tipAmount,
          currency: normalized.currency,
          purchaseDate: normalized.purchaseDate,
          suggestedCategory: normalized.suggestedCategory,
          confidenceScore: normalized.confidenceScore,
          rawResponse: JSON.stringify(extracted),
        });
      });
      this.notifyStatus(expenseId, {
        status: "processing",
        step: "persist-results",
        detail: "Saving results...",
      });

      await step.do("mark-needs-review", async () => {
        await expenses.updateExpenseStatus(db, expenseId, "needs_review");
      });
      this.notifyStatus(expenseId, {
        status: "needs_review",
        step: "complete",
        detail: "Processing complete! Ready for review.",
      });
      logger.info("Workflow completed successfully");
    } catch (error) {
      // Log full error detail for observability; surface a friendly message
      // to the user. We never want to leak stack traces, fetch errors, or
      // AI provider responses into the UI.
      logger.error("Workflow failed", { error });
      const userMessage =
        "We couldn't read this receipt. Try uploading a clearer image, or enter the expense manually.";
      await step.do("mark-failed", async () => {
        await expenses.updateExpenseStatus(db, expenseId, "failed", userMessage);
      });
      this.notifyStatus(expenseId, {
        status: "failed",
        step: "error",
        detail: userMessage,
      });
    }
  }
}
