import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { createDb, createLogger, receipts, parse } from "@quickspense/domain";
import type { Env } from "./index.js";
import { extractTextFromImage } from "./ai/ocr.js";
import {
  extractStructuredData,
  normalizeExtractedData,
} from "./ai/extract.js";
import type { ReceiptStatusDO, StatusUpdate } from "./receipt-status.js";

type WorkflowParams = {
  receiptId: string;
  userId: string;
};

export class ReceiptProcessingWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowParams
> {
  private notifyStatus(receiptId: string, update: Omit<StatusUpdate, "timestamp">): void {
    const stub = this.env.RECEIPT_STATUS_DO.idFromName(receiptId);
    const obj = this.env.RECEIPT_STATUS_DO.get(stub) as DurableObjectStub<ReceiptStatusDO>;
    obj.notify({ ...update, timestamp: Date.now() }).catch(() => {
      // Best-effort: don't fail the workflow if notification fails
    });
  }

  async run(
    event: WorkflowEvent<WorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { receiptId, userId } = event.payload;
    const logger = createLogger({
      service: "worker",
      workflow: "receipt-processing",
      workflowId: event.instanceId,
      receiptId,
      userId,
    });
    logger.info("Workflow starting");

    const db = createDb(this.env.DB);

    // Idempotency guard: no-op if the receipt is already finalized or actively processing.
    const shouldSkip = await step.do("idempotency-check", async () => {
      const receipt = await receipts.getReceipt(db, receiptId);
      if (!receipt) return true;
      if (receipt.status === "finalized") return true;
      return false;
    });

    if (shouldSkip) {
      logger.info("Workflow skipped by idempotency check");
      return;
    }

    try {
      // Step 1: Mark as processing
      await step.do("mark-processing", async () => {
        await receipts.updateReceiptStatus(db, receiptId, "processing");
      });
      this.notifyStatus(receiptId, {
        status: "processing",
        step: "mark-processing",
        detail: "Starting receipt processing...",
      });

      // Step 2: Load file from R2 and OCR in a single step to avoid the
      // 1 MiB Workflow step-output limit (base64 images easily exceed it).
      const ocrText = await step.do(
        "ocr",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => {
          const receipt = await receipts.getReceipt(db, receiptId);
          if (!receipt) throw new Error(`Receipt ${receiptId} not found`);

          const object = await this.env.BUCKET.get(receipt.file_key);
          if (!object)
            throw new Error(`File not found in R2: ${receipt.file_key}`);

          const arrayBuffer = await object.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);

          return extractTextFromImage(
            this.env.AI,
            base64,
            receipt.file_type,
          );
        },
      );
      this.notifyStatus(receiptId, {
        status: "processing",
        step: "ocr",
        detail: "Reading receipt text...",
      });

      // Step 3: Extract structured data
      const extracted = await step.do(
        "extract",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => {
          return extractStructuredData(this.env.AI, ocrText);
        },
      );
      this.notifyStatus(receiptId, {
        status: "processing",
        step: "extract",
        detail: "Extracting receipt data...",
      });

      // Step 4: Normalize
      const normalized = await step.do("normalize", async () => {
        return normalizeExtractedData(extracted);
      });
      this.notifyStatus(receiptId, {
        status: "processing",
        step: "normalize",
        detail: "Normalizing data...",
      });

      // Step 5: Persist parsed results
      await step.do("persist-results", async () => {
        await parse.createParsedReceipt(db, {
          receiptId,
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
      this.notifyStatus(receiptId, {
        status: "processing",
        step: "persist-results",
        detail: "Saving results...",
      });

      // Step 6: Mark as needs_review
      await step.do("mark-needs-review", async () => {
        await receipts.updateReceiptStatus(db, receiptId, "needs_review");
      });
      this.notifyStatus(receiptId, {
        status: "needs_review",
        step: "complete",
        detail: "Processing complete! Ready for review.",
      });
      logger.info("Workflow completed successfully");
    } catch (error) {
      logger.error("Workflow failed", { error });
      await step.do("mark-failed", async () => {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await receipts.updateReceiptStatus(
          db,
          receiptId,
          "failed",
          message,
        );
      });
      this.notifyStatus(receiptId, {
        status: "failed",
        step: "error",
        detail: error instanceof Error ? error.message : "Processing failed",
      });
    }
  }
}
