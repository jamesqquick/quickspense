import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { Expense, ExpenseStatus, ParsedExpense, Category } from "@quickspense/domain";
import { ExpenseDeleteConfirm } from "./ExpenseDeleteConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";

type Props = {
  expenseId: string;
};

type StatusUpdate = {
  status: string;
  step: string;
  detail: string;
  timestamp: number;
};

function formatCents(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

function parseCents(value: string): number | null {
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

type BadgeVariant = "muted" | "warning" | "info" | "success" | "destructive";

const STATUS_BADGE_VARIANT: Record<ExpenseStatus, BadgeVariant> = {
  active: "success",
  processing: "warning",
  needs_review: "info",
  failed: "destructive",
};

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  active: "active",
  processing: "processing",
  needs_review: "needs review",
  failed: "failed",
};

const STEP_LABELS: Record<string, string> = {
  "mark-processing": "Starting...",
  ocr: "Reading receipt text...",
  extract: "Extracting receipt data...",
  normalize: "Normalizing data...",
  "persist-results": "Saving results...",
  complete: "Processing complete!",
  error: "Processing failed",
};

const PROGRESS_STEPS = [
  "mark-processing",
  "ocr",
  "extract",
  "normalize",
  "persist-results",
  "complete",
];

/**
 * Unified expense detail view. Behavior depends on `expense.status`:
 *   - `processing`: live progress UI (WebSocket + polling fallback), read-only.
 *   - `needs_review`: editable parsed fields + Finalize button.
 *   - `active`: editable expense fields, image preview if attached.
 *   - `failed`: error message + Reprocess button + manual entry fallback.
 */
export function ExpenseReview({ expenseId }: Props) {
  const [expense, setExpense] = useState<Expense | null>(null);
  const [parsed, setParsed] = useState<ParsedExpense | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [progressDetail, setProgressDetail] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [usingWebSocket, setUsingWebSocket] = useState(false);
  const [pollGaveUp, setPollGaveUp] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Editable fields
  const [merchant, setMerchant] = useState("");
  const [total, setTotal] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [tip, setTip] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryList, setCategoryList] = useState<Category[]>([]);

  const populateFromExpense = useCallback(
    (exp: Expense, p: ParsedExpense | null) => {
      // For active expenses, the user-confirmed values live on the expense.
      // For needs_review, parsed_expenses holds the AI draft. For processing/
      // failed, both may be sparse — we just show whatever we have.
      const isActive = exp.status === "active";
      setMerchant((isActive ? exp.merchant : p?.merchant) ?? "");
      setTotal(formatCents(isActive ? exp.amount : p?.total_amount ?? null));
      setSubtotal(formatCents(p?.subtotal_amount ?? null));
      setTax(formatCents(p?.tax_amount ?? null));
      setTip(formatCents(p?.tip_amount ?? null));
      setCurrency(exp.currency || p?.currency || "USD");
      setDate((isActive ? exp.expense_date : p?.purchase_date) ?? "");
      setCategory(exp.category_id ?? "");
      setNotes(exp.notes ?? "");
    },
    [],
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/expenses/${expenseId}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setExpense(data.expense);
      setParsed(data.parsed);
      populateFromExpense(data.expense, data.parsed);
    } catch {
      toast.error("Failed to load expense");
    } finally {
      setLoading(false);
    }
  }, [expenseId, populateFromExpense]);

  useEffect(() => {
    // Categories first so we can map suggested_category name -> id
    fetch("/api/categories")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Category[]) => {
        setCategoryList(data);
        fetchData().then(() => {
          setParsed((prev) => {
            if (prev?.suggested_category) {
              const match = data.find(
                (c) =>
                  c.name.toLowerCase() ===
                  prev.suggested_category?.toLowerCase(),
              );
              if (match) setCategory((cur) => cur || match.id);
            }
            return prev;
          });
        });
      })
      .catch(() => {
        fetchData();
      });
  }, [expenseId, fetchData]);

  // WebSocket for real-time workflow updates while processing
  useEffect(() => {
    if (expense?.status !== "processing") return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/expenses/${expenseId}/ws`;

      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setUsingWebSocket(true);
        };

        ws.onmessage = (event) => {
          try {
            const update: StatusUpdate = JSON.parse(event.data);
            setProgressDetail(update.detail);
            setCurrentStep(update.step);
            if (update.status === "needs_review" || update.status === "failed") {
              fetchData();
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          setUsingWebSocket(false);
          if (!closed) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          wsRef.current = null;
          setUsingWebSocket(false);
        };
      } catch {
        setUsingWebSocket(false);
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      wsRef.current = null;
      setUsingWebSocket(false);
      setProgressDetail(null);
      setCurrentStep(null);
    };
  }, [expense?.status, expenseId, fetchData]);

  // Polling fallback when WebSocket is unavailable
  useEffect(() => {
    if (expense?.status !== "processing") {
      setPollGaveUp(false);
      return;
    }
    if (usingWebSocket) return;

    const delays = [3000, 5000, 10000, 30000];
    const MAX_TOTAL_MS = 5 * 60 * 1000;
    const startedAt = Date.now();
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      if (Date.now() - startedAt >= MAX_TOTAL_MS) {
        setPollGaveUp(true);
        return;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      timer = setTimeout(async () => {
        if (cancelled) return;
        await fetchData();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [expense?.status, usingWebSocket, fetchData]);

  const handleFinalize = async () => {
    if (!merchant || !total || !date) {
      toast.error("Merchant, amount, and date are required to finalize");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/expenses/${expenseId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant,
          amount: parseCents(total),
          currency,
          expense_date: date,
          category_id: category || undefined,
          notes: notes || undefined,
        }),
      });
      if (res.ok) {
        toast.success("Expense finalized.");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Finalize failed");
      }
    } catch {
      toast.error("Finalize failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveActive = async () => {
    if (!merchant || !total || !date) {
      toast.error("Merchant, amount, and date are required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/expenses/${expenseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant,
          amount: parseCents(total),
          currency,
          expense_date: date,
          category_id: category || null,
          notes: notes || null,
        }),
      });
      if (res.ok) {
        toast.success("Expense saved");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Save failed");
      }
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    try {
      const res = await fetch(`/api/expenses/${expenseId}/reprocess`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Reprocessing started");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Reprocess failed");
      }
    } catch {
      toast.error("Reprocess failed");
    } finally {
      setReprocessing(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Skeleton className="w-full aspect-[3/4] rounded-2xl" />
        <div className="space-y-6">
          <Skeleton className="h-7 w-28 rounded-full" />
          <div className="space-y-4">
            <div>
              <Skeleton className="h-4 w-16 mb-2" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i}>
                  <Skeleton className="h-4 w-20 mb-2" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-9 w-full sm:w-24" />
        </div>
      </div>
    );
  }

  if (!expense) {
    return <p className="text-red-400">Expense not found</p>;
  }

  const hasImage = !!expense.file_key;
  const isProcessing = expense.status === "processing";
  const isNeedsReview = expense.status === "needs_review";
  const isActive = expense.status === "active";
  const isFailed = expense.status === "failed";
  const isEditable = isNeedsReview || isActive;

  const currentStepIndex = currentStep
    ? PROGRESS_STEPS.indexOf(currentStep)
    : -1;
  const progressPercent = currentStep
    ? Math.min(100, Math.round(((currentStepIndex + 1) / PROGRESS_STEPS.length) * 100))
    : 0;

  return (
    <div
      className={
        hasImage
          ? "grid grid-cols-1 lg:grid-cols-2 gap-8"
          : "max-w-2xl"
      }
    >
      {/* Image (if attached) */}
      {hasImage && (
        <div>
          <img
            src={`/api/expenses/${expenseId}/image`}
            alt="Receipt"
            className="w-full rounded-2xl border border-white/10"
          />
        </div>
      )}

      <div className="space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge
            variant={STATUS_BADGE_VARIANT[expense.status]}
            className="px-3 py-1 text-sm"
          >
            {STATUS_LABEL[expense.status]}
          </Badge>
          {expense.error_message && (
            <span className="text-sm text-red-400">{expense.error_message}</span>
          )}
        </div>

        {parsed?.confidence_score !== null &&
          parsed?.confidence_score !== undefined && (
            <div>
              <p className="text-sm text-slate-400 mb-1">
                AI Confidence: {Math.round(parsed.confidence_score * 100)}%
              </p>
              <div className="w-full bg-white/10 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-500 ${
                    parsed.confidence_score > 0.7
                      ? "bg-green-400"
                      : parsed.confidence_score > 0.4
                        ? "bg-yellow-400"
                        : "bg-red-400"
                  }`}
                  style={{ width: `${parsed.confidence_score * 100}%` }}
                />
              </div>
            </div>
          )}

        {isProcessing ? (
          <div className="text-center py-8">
            {pollGaveUp && !usingWebSocket ? (
              <>
                <p className="text-slate-300 font-medium mb-2">Still processing...</p>
                <p className="text-sm text-slate-500 mb-4">
                  This is taking longer than expected. Refresh the page later
                  to check status.
                </p>
                <Button variant="link" onClick={fetchData}>
                  Check now
                </Button>
              </>
            ) : (
              <>
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-400 mx-auto mb-4" />
                <p className="text-slate-400 mb-2">
                  {progressDetail || "Processing receipt..."}
                </p>
                {currentStep && (
                  <div className="w-full max-w-xs mx-auto">
                    <div className="w-full bg-white/10 rounded-full h-1.5 mb-2">
                      <div
                        className="h-1.5 rounded-full bg-primary-400 transition-all duration-700"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {PROGRESS_STEPS.slice(0, -1).map((step, i) => (
                        <span
                          key={step}
                          className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                            i <= currentStepIndex
                              ? "bg-primary-400/20 text-primary-300"
                              : "bg-white/5 text-slate-600"
                          }`}
                        >
                          {STEP_LABELS[step] || step}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Merchant</Label>
              <Input
                type="text"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                disabled={!isEditable}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Total ($)</Label>
                <Input
                  type="text"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  disabled={!isEditable}
                />
              </div>
              {isNeedsReview && (
                <>
                  <div>
                    <Label>Subtotal ($)</Label>
                    <Input
                      type="text"
                      value={subtotal}
                      onChange={(e) => setSubtotal(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Tax ($)</Label>
                    <Input
                      type="text"
                      value={tax}
                      onChange={(e) => setTax(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Tip ($)</Label>
                    <Input
                      type="text"
                      value={tip}
                      onChange={(e) => setTip(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Currency</Label>
                <Input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={!isEditable}
                  maxLength={3}
                />
              </div>
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={!isEditable}
                />
              </div>
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={category || "__none__"}
                onValueChange={(v) =>
                  setCategory(v === "__none__" ? "" : v)
                }
                disabled={!isEditable}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select a category</SelectItem>
                  {categoryList.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!isEditable}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          {isNeedsReview && (
            <Button
              variant="success"
              onClick={handleFinalize}
              disabled={saving}
              className="w-full sm:w-auto"
            >
              {saving ? "Finalizing..." : "Finalize"}
            </Button>
          )}
          {isActive && (
            <Button
              variant="success"
              onClick={handleSaveActive}
              disabled={saving}
              className="w-full sm:w-auto"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          {(isFailed || isNeedsReview) && hasImage && (
            <Button
              variant="outline"
              onClick={handleReprocess}
              disabled={reprocessing}
            >
              {reprocessing ? "Starting..." : "Reprocess"}
            </Button>
          )}
          {isActive && (
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(true)}
              className="text-red-400 hover:text-red-300 ml-auto"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {confirmingDelete && expense && (
        <ExpenseDeleteConfirm
          expense={expense}
          onConfirm={() => {
            setConfirmingDelete(false);
            window.location.href = "/expenses";
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
