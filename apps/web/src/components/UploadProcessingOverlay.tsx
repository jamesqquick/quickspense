import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";

export type FileItem = {
  id: string;
  file: File;
  preview: string;
  status: "pending" | "uploading" | "success" | "failed";
  expenseId?: string;
  error?: string;
};

type OverlayStage =
  | { type: "uploading"; current: number; total: number }
  | { type: "processing"; current: number; total: number }
  | { type: "complete" }
  | { type: "error"; successCount: number; totalCount: number };

type StatusUpdate = {
  status: string;
  step: string;
  detail: string;
  timestamp: number;
};

const TERMINAL_STATUSES = new Set(["needs_review", "active", "failed"]);
const MAX_PROCESS_MS = 5 * 60 * 1000; // 5 minutes
const POLL_DELAYS = [2000, 3000, 5000, 10000];

// Ordered workflow steps, mirroring the worker's notifyStatus sequence.
const PROGRESS_STEPS = [
  "mark-processing",
  "ocr",
  "extract",
  "normalize",
  "persist-results",
  "complete",
];

type Props = {
  open: boolean;
  items: FileItem[];
  onComplete: (successIds: string[]) => void;
  onError: () => void;
};

export function UploadProcessingOverlay({
  open,
  items,
  onComplete,
  onError,
}: Props) {
  const [stage, setStage] = useState<OverlayStage>({
    type: "uploading",
    current: 0,
    total: items.length,
  });
  const [processingDetail, setProcessingDetail] = useState<string | null>(null);
  // Step index for the file currently being processed; -1 when no WS step
  // has arrived yet (drives the indeterminate shimmer fallback).
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);

  const hasStarted = useRef(false);
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Keep latest callbacks in refs so the main effect can depend only on `open`
  // and never re-run (and tear down in-flight work) on incidental re-renders.
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onComplete, onError]);

  const cleanup = useCallback(() => {
    for (const ws of wsRefs.current.values()) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    wsRefs.current.clear();
    for (const timer of pollTimers.current.values()) {
      clearTimeout(timer);
    }
    pollTimers.current.clear();
  }, []);

  const checkExpenseStatus = useCallback(
    async (expenseId: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/expenses/${expenseId}`);
        if (res.ok) {
          const data = await res.json();
          return data.expense?.status ?? null;
        }
      } catch {
        // Network error
      }
      return null;
    },
    [],
  );

  /**
   * Resolves once the given expense reaches a terminal status. Polling is the
   * source of truth for completion (always runs, owns the timeout). The
   * WebSocket runs in parallel purely to enrich live step detail/progress and
   * to resolve early when a terminal message arrives.
   */
  const waitForProcessing = useCallback(
    (expenseId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let resolved = false;

        const done = (success: boolean) => {
          if (resolved) return;
          resolved = true;
          const ws = wsRefs.current.get(expenseId);
          if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
          wsRefs.current.delete(expenseId);
          const timer = pollTimers.current.get(expenseId);
          if (timer) clearTimeout(timer);
          pollTimers.current.delete(expenseId);
          resolve(success);
        };

        // --- Always-on completion polling (source of truth) ---
        const poll = async (attempt: number) => {
          if (resolved) return;
          if (Date.now() - startedAt >= MAX_PROCESS_MS) {
            // Timed out — treat as success so the user can finish manually
            // on the detail page.
            done(true);
            return;
          }

          const status = await checkExpenseStatus(expenseId);
          if (resolved) return;
          if (status && TERMINAL_STATUSES.has(status)) {
            done(status !== "failed");
            return;
          }

          const delay = POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)];
          const timer = setTimeout(() => poll(attempt + 1), delay);
          pollTimers.current.set(expenseId, timer);
        };

        // Kick off the first poll immediately (handles workflows that finished
        // before this expense's turn in the queue).
        poll(0);

        // --- WebSocket enrichment (best-effort, runs in parallel) ---
        try {
          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${protocol}//${window.location.host}/api/expenses/${expenseId}/ws`;
          const ws = new WebSocket(wsUrl);
          wsRefs.current.set(expenseId, ws);

          ws.onmessage = (event) => {
            try {
              const update: StatusUpdate = JSON.parse(event.data);
              setProcessingDetail(update.detail);
              const idx = PROGRESS_STEPS.indexOf(update.step);
              if (idx >= 0) setCurrentStepIndex(idx);
              if (TERMINAL_STATUSES.has(update.status)) {
                done(update.status !== "failed");
              }
            } catch {
              // Ignore non-JSON messages
            }
          };

          // No onclose/onerror -> polling handling needed; the always-on poll
          // already guarantees completion detection.
        } catch {
          // WebSocket unavailable — polling still drives completion.
        }
      });
    },
    [checkExpenseStatus],
  );

  useEffect(() => {
    if (!open || hasStarted.current || items.length === 0) return;
    hasStarted.current = true;

    const run = async () => {
      const total = items.length;
      const successIds: string[] = [];
      let failedCount = 0;

      // Phase 1: Upload all files
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setStage({ type: "uploading", current: i, total });
        setProcessingDetail(null);

        const form = new FormData();
        form.append("file", item.file);
        form.append("parse", "true");

        try {
          const res = await fetch("/api/expenses", { method: "POST", body: form });
          if (res.ok) {
            const expense = (await res.json()) as { id: string };
            successIds.push(expense.id);
          } else {
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
        }
        setStage({ type: "uploading", current: i + 1, total });
      }

      if (successIds.length === 0) {
        setStage({ type: "error", successCount: 0, totalCount: total });
        toast.error(`Upload failed for all ${total} file${total === 1 ? "" : "s"}`);
        setTimeout(() => onErrorRef.current(), 1500);
        return;
      }

      // Phase 2: Wait for AI processing
      const processingTotal = successIds.length;

      for (let i = 0; i < successIds.length; i++) {
        setCurrentStepIndex(-1);
        setProcessingDetail(null);
        setStage({
          type: "processing",
          current: i,
          total: processingTotal,
        });

        await waitForProcessing(successIds[i]);

        setStage({
          type: "processing",
          current: i + 1,
          total: processingTotal,
        });
      }

      // Phase 3: Done
      if (failedCount > 0) {
        toast.warning(
          `${successIds.length} of ${total} uploaded successfully. ${failedCount} failed.`,
        );
      } else {
        toast.success(
          `${successIds.length} expense${successIds.length === 1 ? "" : "s"} created`,
        );
      }

      setStage({ type: "complete" });

      // Brief pause on "All done!" before navigating
      setTimeout(() => {
        onCompleteRef.current(successIds);
      }, 800);
    };

    run();

    return () => {
      cleanup();
    };
  }, [open, items, waitForProcessing, cleanup]);

  // Reset when overlay closes
  useEffect(() => {
    if (!open) {
      hasStarted.current = false;
    }
  }, [open]);

  const stageLabel = getStageLabel(stage, processingDetail);
  const progressPercent = computeProgress(stage, currentStepIndex);
  const indeterminate =
    stage.type === "processing" && currentStepIndex < 0;

  return (
    <Dialog open={open}>
      <DialogContent
        showClose={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="max-w-sm text-center"
      >
        <div className="flex flex-col items-center gap-6 py-4">
          {/* Animated icon */}
          <div className="relative w-20 h-20">
            {stage.type === "complete" ? (
              <CompleteIcon />
            ) : (
              <ProcessingIcon />
            )}
          </div>

          {/* Stage label */}
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-white">
              {stageLabel.title}
            </h3>
            <p className="text-sm text-slate-400">
              {stageLabel.subtitle}
            </p>
          </div>

          {/* Progress bar */}
          {(stage.type === "uploading" || stage.type === "processing") && (
            <div className="w-full max-w-xs">
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                {indeterminate ? (
                  <div className="h-1.5 w-2/5 rounded-full bg-primary-400 animate-indeterminate" />
                ) : (
                  <div
                    className="h-1.5 rounded-full bg-primary-400 transition-all duration-700 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Overall progress as a percentage. During processing, blends completed-file
 * count with the in-file workflow step fraction so the bar advances smoothly
 * even for a single receipt.
 */
function computeProgress(stage: OverlayStage, stepIndex: number): number {
  if (stage.type === "uploading") {
    return Math.round((stage.current / stage.total) * 100);
  }
  if (stage.type === "processing") {
    const stepFraction =
      stepIndex >= 0 ? (stepIndex + 1) / PROGRESS_STEPS.length : 0;
    const overall = (stage.current + stepFraction) / stage.total;
    return Math.min(100, Math.round(overall * 100));
  }
  return 0;
}

function getStageLabel(
  stage: OverlayStage,
  detail: string | null,
): { title: string; subtitle: string } {
  switch (stage.type) {
    case "uploading":
      return {
        title: stage.total === 1
          ? "Uploading receipt..."
          : `Uploading receipts... (${stage.current} of ${stage.total})`,
        subtitle: detail ?? "Sending your files",
      };
    case "processing":
      return {
        title: stage.total === 1
          ? "Reading your receipt..."
          : `Processing receipts... (${stage.current + 1} of ${stage.total})`,
        subtitle: detail ?? "Extracting details with AI",
      };
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

function ProcessingIcon() {
  return (
    <div className="w-20 h-20 relative">
      {/* Spinning dashed circle */}
      <svg
        className="w-20 h-20 animate-spin-slow"
        viewBox="0 0 80 80"
        fill="none"
      >
        <circle
          cx="40"
          cy="40"
          r="35"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="8 6"
          className="text-white/20"
        />
      </svg>
      {/* Floating receipt icon */}
      <div className="absolute inset-0 flex items-center justify-center animate-float">
        <svg
          className="w-8 h-8 text-primary-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
          <path d="M8 7h8" />
          <path d="M8 11h8" />
          <path d="M8 15h4" />
        </svg>
      </div>
    </div>
  );
}

function CompleteIcon() {
  return (
    <div className="w-20 h-20 flex items-center justify-center animate-scale-in">
      <div className="w-16 h-16 rounded-full bg-green-400/20 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-green-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    </div>
  );
}
