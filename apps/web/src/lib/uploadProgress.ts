import { EXPENSE_PROGRESS_STEPS } from "@quickspense/domain";

export type UploadStage =
  | { type: "uploading"; current: number; total: number }
  | { type: "processing"; current: number; total: number }
  | { type: "complete" }
  | { type: "error"; successCount: number; totalCount: number };

/**
 * Overall progress as a percentage (0-100). During processing, blends the
 * completed-file count with the in-file workflow step fraction so the bar
 * advances smoothly even for a single receipt. `stepIndex` is the index into
 * EXPENSE_PROGRESS_STEPS for the file currently processing, or -1 when no step
 * has arrived yet.
 */
export function computeUploadProgress(
  stage: UploadStage,
  stepIndex: number,
): number {
  if (stage.type === "uploading") {
    if (stage.total === 0) return 0;
    return Math.round((stage.current / stage.total) * 100);
  }
  if (stage.type === "processing") {
    if (stage.total === 0) return 0;
    const stepFraction =
      stepIndex >= 0 ? (stepIndex + 1) / EXPENSE_PROGRESS_STEPS.length : 0;
    const overall = (stage.current + stepFraction) / stage.total;
    return Math.min(100, Math.round(overall * 100));
  }
  return 0;
}

/**
 * Display text for a given stage. The processing position is clamped so it
 * never reads "(N+1 of N)" during the brief window where the run loop sets
 * current === total before switching to the "complete" stage.
 */
export function getUploadStageLabel(
  stage: UploadStage,
  detail: string | null,
): { title: string; subtitle: string } {
  switch (stage.type) {
    case "uploading":
      return {
        title:
          stage.total === 1
            ? "Uploading receipt..."
            : `Uploading receipts... (${stage.current} of ${stage.total})`,
        subtitle: detail ?? "Sending your files",
      };
    case "processing": {
      const position = Math.min(stage.current + 1, stage.total);
      return {
        title:
          stage.total === 1
            ? "Reading your receipt..."
            : `Processing receipts... (${position} of ${stage.total})`,
        subtitle: detail ?? "Extracting details with AI",
      };
    }
    case "complete":
      return { title: "All done!", subtitle: "Redirecting you now..." };
    case "error":
      return {
        title: "Upload failed",
        subtitle:
          stage.successCount > 0
            ? `${stage.successCount} of ${stage.totalCount} uploaded`
            : "Something went wrong",
      };
  }
}
