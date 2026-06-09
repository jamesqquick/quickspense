import { describe, it, expect } from "vitest";
import { EXPENSE_PROGRESS_STEPS } from "@quickspense/domain";
import {
  computeUploadProgress,
  getUploadStageLabel,
  type UploadStage,
} from "@/lib/uploadProgress";

describe("computeUploadProgress", () => {
  it("reflects uploaded-file count during the uploading stage", () => {
    expect(
      computeUploadProgress({ type: "uploading", current: 0, total: 4 }, -1),
    ).toBe(0);
    expect(
      computeUploadProgress({ type: "uploading", current: 2, total: 4 }, -1),
    ).toBe(50);
    expect(
      computeUploadProgress({ type: "uploading", current: 4, total: 4 }, -1),
    ).toBe(100);
  });

  it("stays at 0% for a single receipt with no workflow step yet", () => {
    // Regression guard: the bar must not jump to 100% the instant processing
    // begins for the in-progress file.
    expect(
      computeUploadProgress({ type: "processing", current: 0, total: 1 }, -1),
    ).toBe(0);
  });

  it("advances by workflow step within the active file", () => {
    const lastStep = EXPENSE_PROGRESS_STEPS.length - 1;
    // First step of a single receipt is a small slice, not 0 and not 100.
    const early = computeUploadProgress(
      { type: "processing", current: 0, total: 1 },
      0,
    );
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(100);
    // Final step of a single receipt reaches 100%.
    expect(
      computeUploadProgress(
        { type: "processing", current: 0, total: 1 },
        lastStep,
      ),
    ).toBe(100);
  });

  it("never exceeds 100% and handles an empty batch", () => {
    expect(
      computeUploadProgress(
        { type: "processing", current: 3, total: 3 },
        EXPENSE_PROGRESS_STEPS.length - 1,
      ),
    ).toBe(100);
    expect(
      computeUploadProgress({ type: "uploading", current: 0, total: 0 }, -1),
    ).toBe(0);
  });
});

describe("getUploadStageLabel", () => {
  it("clamps the processing position so it never reads (N+1 of N)", () => {
    // The run loop briefly sets current === total before the complete stage.
    const stage: UploadStage = { type: "processing", current: 3, total: 3 };
    expect(getUploadStageLabel(stage, null).title).toBe(
      "Processing receipts... (3 of 3)",
    );
  });

  it("uses singular copy for a single receipt and shows live detail", () => {
    const stage: UploadStage = { type: "processing", current: 0, total: 1 };
    expect(getUploadStageLabel(stage, null).title).toBe(
      "Reading your receipt...",
    );
    expect(
      getUploadStageLabel(stage, "Reading receipt text...").subtitle,
    ).toBe("Reading receipt text...");
  });

  it("summarizes partial success on the error stage", () => {
    expect(
      getUploadStageLabel(
        { type: "error", successCount: 2, totalCount: 3 },
        null,
      ).subtitle,
    ).toBe("2 of 3 uploaded");
    expect(
      getUploadStageLabel(
        { type: "error", successCount: 0, totalCount: 3 },
        null,
      ).subtitle,
    ).toBe("Something went wrong");
  });
});
