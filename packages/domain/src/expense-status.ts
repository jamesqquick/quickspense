/**
 * Shared contract for live expense-processing status updates.
 *
 * Produced by the background worker's expense-processing workflow, fanned out
 * over a Durable Object WebSocket, and consumed by the web app (upload overlay
 * and expense review page). Keep this as the single source of truth so the
 * producer and consumers can't drift.
 */

/** A single workflow step in the order it runs. */
export type ExpenseProcessingStep =
  | "mark-processing"
  | "ocr"
  | "extract"
  | "normalize"
  | "persist-results"
  | "complete"
  | "error";

/** Message sent to connected clients as the workflow progresses. */
export type ExpenseStatusUpdate = {
  status: string;
  step: ExpenseProcessingStep | string;
  detail: string;
  timestamp: number;
};

/**
 * Ordered steps that represent forward progress, used to compute a percentage.
 * Excludes the terminal "error" step.
 */
export const EXPENSE_PROGRESS_STEPS: ExpenseProcessingStep[] = [
  "mark-processing",
  "ocr",
  "extract",
  "normalize",
  "persist-results",
  "complete",
];

/** Human-friendly labels for each step. */
export const EXPENSE_STEP_LABELS: Record<string, string> = {
  "mark-processing": "Starting...",
  ocr: "Reading receipt text...",
  extract: "Extracting receipt data...",
  normalize: "Normalizing data...",
  "persist-results": "Saving results...",
  complete: "Processing complete!",
  error: "Processing failed",
};
