import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { createLogger } from "@quickspense/domain";
import type { Env } from "./index.js";
import { extractTextFromImage } from "./ai/ocr.js";
import {
  extractStructuredData,
  normalizeExtractedData,
} from "./ai/extract.js";

type WorkflowParams = {
  receiptId: string;
  userId: string;
};

export class ReceiptProcessingWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowParams
> {
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

    // Idempotency guard: no-op if the receipt is already finalized or actively processing.
    // Prevents duplicate AI spend from accidental double-triggers (e.g. rapid reprocess clicks).
    const shouldSkip = await step.do("idempotency-check", async () => {
      const receipt = await this.env.DB.prepare(
        "SELECT status FROM receipts WHERE id = ?",
      )
        .bind(receiptId)
        .first<{ status: string }>();

      if (!receipt) {
        // Receipt was deleted between trigger and execution. Safe to skip.
        return true;
      }
      // Already finalized: nothing to do.
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
        await this.env.DB.prepare(
          "UPDATE receipts SET status = 'processing', updated_at = datetime('now') WHERE id = ?",
        )
          .bind(receiptId)
          .run();
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
          const receipt = await this.env.DB.prepare(
            "SELECT file_key, file_type FROM receipts WHERE id = ?",
          )
            .bind(receiptId)
            .first<{ file_key: string; file_type: string }>();

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

      // Step 4: Normalize
      const normalized = await step.do("normalize", async () => {
        return normalizeExtractedData(extracted);
      });

      // Step 5: Persist parsed results
      await step.do("persist-results", async () => {
        const id = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO parsed_receipts
           (id, receipt_id, ocr_text, merchant, total_amount, subtotal_amount, tax_amount, tip_amount, currency, purchase_date, suggested_category, confidence_score, raw_response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            receiptId,
            ocrText,
            normalized.merchant,
            normalized.totalAmount,
            normalized.subtotalAmount,
            normalized.taxAmount,
            normalized.tipAmount,
            normalized.currency,
            normalized.purchaseDate,
            normalized.suggestedCategory,
            normalized.confidenceScore,
            JSON.stringify(extracted),
          )
          .run();
      });

      // Step 6: Mark as needs_review
      await step.do("mark-needs-review", async () => {
        await this.env.DB.prepare(
          "UPDATE receipts SET status = 'needs_review', updated_at = datetime('now') WHERE id = ?",
        )
          .bind(receiptId)
          .run();
      });
      logger.info("Workflow completed successfully");
    } catch (error) {
      logger.error("Workflow failed", { error });
      // Mark as failed
      await step.do("mark-failed", async () => {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await this.env.DB.prepare(
          "UPDATE receipts SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
        )
          .bind(message, receiptId)
          .run();
      });
    }
  }
}
