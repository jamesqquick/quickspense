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
const POLL_DELAYS = [3000, 5000, 10000, 30000];

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
  const hasStarted = useRef(false);
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

        // Check if already complete before opening WS (handles fast workflows)
        checkExpenseStatus(expenseId).then((status) => {
          if (resolved) return;
          if (status && TERMINAL_STATUSES.has(status)) {
            done(status !== "failed");
            return;
          }
          connectWebSocket();
        });

        function connectWebSocket() {
          if (resolved) return;

          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${protocol}//${window.location.host}/api/expenses/${expenseId}/ws`;
          let wsConnected = false;

          try {
            const ws = new WebSocket(wsUrl);
            wsRefs.current.set(expenseId, ws);

            ws.onopen = () => {
              wsConnected = true;
              // Re-check status after WS connects to catch the race where
              // the workflow finished between the initial check and WS open
              checkExpenseStatus(expenseId).then((status) => {
                if (resolved) return;
                if (status && TERMINAL_STATUSES.has(status)) {
                  done(status !== "failed");
                }
              });
            };

            ws.onmessage = (event) => {
              try {
                const update: StatusUpdate = JSON.parse(event.data);
                setProcessingDetail(update.detail);
                if (TERMINAL_STATUSES.has(update.status)) {
                  done(update.status !== "failed");
                }
              } catch {
                // Ignore non-JSON messages
              }
            };

            ws.onclose = () => {
              wsRefs.current.delete(expenseId);
              if (!resolved && !wsConnected) {
                startPolling();
              }
            };

            ws.onerror = () => {
              wsRefs.current.delete(expenseId);
              if (!resolved) {
                startPolling();
              }
            };
          } catch {
            startPolling();
          }
        }

        // Polling fallback
        function startPolling() {
          let attempt = 0;

          const poll = async () => {
            if (resolved) return;
            if (Date.now() - startedAt >= MAX_PROCESS_MS) {
              // Timed out — treat as success so user can finish manually
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
            attempt += 1;
            const timer = setTimeout(poll, delay);
            pollTimers.current.set(expenseId, timer);
          };

          poll();
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
        setTimeout(() => onError(), 1500);
        return;
      }

      // Phase 2: Wait for AI processing
      const processingTotal = successIds.length;

      for (let i = 0; i < successIds.length; i++) {
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
        onComplete(successIds);
      }, 800);
    };

    run();

    return () => {
      cleanup();
    };
  }, [open, items, onComplete, onError, waitForProcessing, cleanup]);

  // Reset when overlay closes
  useEffect(() => {
    if (!open) {
      hasStarted.current = false;
    }
  }, [open]);

  const stageLabel = getStageLabel(stage, processingDetail);

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
              <div className="w-full bg-white/10 rounded-full h-1.5">
                <div
                  className="h-1.5 rounded-full bg-primary-400 transition-all duration-700 ease-out"
                  style={{
                    width: `${Math.round((stage.current / stage.total) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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
          : `Processing receipts... (${stage.current} of ${stage.total})`,
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
