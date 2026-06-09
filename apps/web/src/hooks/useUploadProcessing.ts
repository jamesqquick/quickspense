import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  EXPENSE_PROGRESS_STEPS,
  type ExpenseStatusUpdate,
} from "@quickspense/domain";
import {
  computeUploadProgress,
  type UploadStage,
} from "@/lib/uploadProgress";

export type { UploadStage };

export type FileItem = {
  id: string;
  file: File;
  preview: string;
  status: "pending" | "uploading" | "success" | "failed";
  expenseId?: string;
  error?: string;
};

export type UploadProcessingState = {
  stage: UploadStage;
  detail: string | null;
  progressPercent: number;
  /** True while processing a file but no workflow step has arrived yet. */
  indeterminate: boolean;
};

const TERMINAL_STATUSES = new Set(["needs_review", "active", "failed"]);
const MAX_PROCESS_MS = 5 * 60 * 1000; // 5 minutes
const POLL_DELAYS = [2000, 3000, 5000, 10000];

type Params = {
  /** When true, kicks off the upload + processing run exactly once. */
  active: boolean;
  items: FileItem[];
  onComplete: (successIds: string[]) => void;
  onError: () => void;
};

/**
 * Owns the upload → AI-processing → navigate state machine for a batch of
 * receipt files. Uploads sequentially (deliberately, to avoid hammering the
 * local D1 with concurrent writes), then waits for each expense to reach a
 * terminal status. Completion is detected by always-on polling (the source of
 * truth, which also owns the timeout); the per-expense WebSocket runs in
 * parallel purely to enrich live step detail and resolve early.
 *
 * Returns derived display state so the consuming component can stay purely
 * presentational.
 */
export function useUploadProcessing({
  active,
  items,
  onComplete,
  onError,
}: Params): UploadProcessingState {
  const [stage, setStage] = useState<UploadStage>({
    type: "uploading",
    current: 0,
    total: items.length,
  });
  const [detail, setDetail] = useState<string | null>(null);
  // Step index for the file currently being processed; -1 when no WS step has
  // arrived yet (drives the indeterminate shimmer).
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);

  const hasStarted = useRef(false);
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Keep latest callbacks in refs so the run effect depends only on `active`
  // and never tears down in-flight work on an incidental re-render.
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
            // Timed out — treat as success so the user can finish manually on
            // the detail page.
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

        poll(0);

        // --- WebSocket enrichment (best-effort, runs in parallel) ---
        try {
          const protocol =
            window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${protocol}//${window.location.host}/api/expenses/${expenseId}/ws`;
          const ws = new WebSocket(wsUrl);
          wsRefs.current.set(expenseId, ws);

          ws.onmessage = (event) => {
            try {
              const update: ExpenseStatusUpdate = JSON.parse(event.data);
              setDetail(update.detail);
              const idx = EXPENSE_PROGRESS_STEPS.indexOf(
                update.step as (typeof EXPENSE_PROGRESS_STEPS)[number],
              );
              if (idx >= 0) setCurrentStepIndex(idx);
              if (TERMINAL_STATUSES.has(update.status)) {
                done(update.status !== "failed");
              }
            } catch {
              // Ignore non-JSON messages
            }
          };
          // No onclose/onerror handling needed: the always-on poll already
          // guarantees completion detection.
        } catch {
          // WebSocket unavailable — polling still drives completion.
        }
      });
    },
    [checkExpenseStatus],
  );

  useEffect(() => {
    if (!active || hasStarted.current || items.length === 0) return;
    hasStarted.current = true;

    const run = async () => {
      const total = items.length;
      const successIds: string[] = [];
      let failedCount = 0;

      // Phase 1: Upload all files sequentially.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setStage({ type: "uploading", current: i, total });
        setDetail(null);

        const form = new FormData();
        form.append("file", item.file);
        form.append("parse", "true");

        try {
          const res = await fetch("/api/expenses", {
            method: "POST",
            body: form,
          });
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
        toast.error(
          `Upload failed for all ${total} file${total === 1 ? "" : "s"}`,
        );
        setTimeout(() => onErrorRef.current(), 1500);
        return;
      }

      // Phase 2: Wait for AI processing of each created expense.
      const processingTotal = successIds.length;

      for (let i = 0; i < successIds.length; i++) {
        setCurrentStepIndex(-1);
        setDetail(null);
        setStage({ type: "processing", current: i, total: processingTotal });

        await waitForProcessing(successIds[i]);

        setStage({
          type: "processing",
          current: i + 1,
          total: processingTotal,
        });
      }

      // Phase 3: Done.
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
      setTimeout(() => onCompleteRef.current(successIds), 800);
    };

    run();

    return () => {
      cleanup();
    };
  }, [active, items, waitForProcessing, cleanup]);

  useEffect(() => {
    if (!active) hasStarted.current = false;
  }, [active]);

  return {
    stage,
    detail,
    progressPercent: computeUploadProgress(stage, currentStepIndex),
    indeterminate: stage.type === "processing" && currentStepIndex < 0,
  };
}
