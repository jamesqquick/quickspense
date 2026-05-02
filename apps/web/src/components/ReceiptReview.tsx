import { useState, useEffect, useRef, useCallback } from "react";
import type { Receipt, ParsedReceipt, Category } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  receiptId: string;
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

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  uploaded: "muted",
  processing: "warning",
  needs_review: "info",
  finalized: "success",
  failed: "destructive",
};

const STEP_LABELS: Record<string, string> = {
  "mark-processing": "Starting...",
  "ocr": "Reading receipt text...",
  "extract": "Extracting receipt data...",
  "normalize": "Normalizing data...",
  "persist-results": "Saving results...",
  "complete": "Processing complete!",
  "error": "Processing failed",
};

export function ReceiptReview({ receiptId }: Props) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [progressDetail, setProgressDetail] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [usingWebSocket, setUsingWebSocket] = useState(false);

  // Editable fields
  const [merchant, setMerchant] = useState("");
  const [total, setTotal] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [tip, setTip] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("");
  const [categoryList, setCategoryList] = useState<Category[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/receipts/${receiptId}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setReceipt(data.receipt);
      setParsed(data.parsed);

      if (data.parsed) {
        setMerchant(data.parsed.merchant || "");
        setTotal(formatCents(data.parsed.total_amount));
        setSubtotal(formatCents(data.parsed.subtotal_amount));
        setTax(formatCents(data.parsed.tax_amount));
        setTip(formatCents(data.parsed.tip_amount));
        setCurrency(data.parsed.currency || "USD");
        setDate(data.parsed.purchase_date || "");
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load receipt" });
    } finally {
      setLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    // Fetch categories first so we can resolve suggested_category name -> id
    fetch("/api/categories")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Category[]) => {
        setCategoryList(data);
        // Now fetch receipt data
        fetchData().then(() => {
          // After parsed data is loaded, try to resolve suggested_category to an id
          setParsed((prev) => {
            if (prev?.suggested_category) {
              const match = data.find(
                (c) => c.name.toLowerCase() === prev.suggested_category?.toLowerCase(),
              );
              if (match) setCategory(match.id);
            }
            return prev;
          });
        });
      })
      .catch(() => {
        fetchData();
      });
  }, [receiptId, fetchData]);

  // WebSocket connection for real-time status updates
  useEffect(() => {
    if (receipt?.status !== "processing") return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/receipts/${receiptId}/ws`;

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

            // Terminal states: refetch full data
            if (update.status === "needs_review" || update.status === "failed") {
              fetchData();
            }
          } catch {
            // Ignore non-JSON messages (e.g. "pong")
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          setUsingWebSocket(false);
          // Reconnect after a short delay unless we've been cleaned up
          if (!closed) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          // onerror is always followed by onclose, so reconnect happens there
          wsRef.current = null;
          setUsingWebSocket(false);
        };
      } catch {
        // WebSocket constructor can throw if URL is invalid
        setUsingWebSocket(false);
      }
    };

    connect();

    // Keep-alive ping every 30s
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send("ping");
      }
    }, 30_000);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pingInterval);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      wsRef.current = null;
      setUsingWebSocket(false);
      setProgressDetail(null);
      setCurrentStep(null);
    };
  }, [receipt?.status, receiptId, fetchData]);

  // Fallback polling when WebSocket is not connected (exponential backoff)
  const [pollGaveUp, setPollGaveUp] = useState(false);
  useEffect(() => {
    if (receipt?.status !== "processing") {
      setPollGaveUp(false);
      return;
    }

    // Don't poll if WebSocket is active
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
  }, [receipt?.status, usingWebSocket, fetchData]);

  const handleFinalize = async () => {
    if (!merchant || !total || !date) {
      setMessage({
        type: "error",
        text: "Merchant, amount, and date are required to finalize",
      });
      return;
    }

    setFinalizing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/receipts/${receiptId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant,
          amount: parseCents(total),
          currency,
          expense_date: date,
          category_id: category || undefined,
          notes: undefined,
        }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Receipt finalized. Expense created." });
        await fetchData();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Finalize failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Finalize failed" });
    } finally {
      setFinalizing(false);
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
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i}>
                  <Skeleton className="h-4 w-20 mb-2" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
            </div>
            <div>
              <Skeleton className="h-4 w-32 mb-2" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
          <Skeleton className="h-9 w-full sm:w-24" />
        </div>
      </div>
    );
  }

  if (!receipt) {
    return <p className="text-red-400">Receipt not found</p>;
  }

  const isEditable = receipt.status === "needs_review";
  const canFinalize = receipt.status === "needs_review";

  const completedSteps = ["mark-processing", "ocr", "extract", "normalize", "persist-results", "complete"];
  const currentStepIndex = currentStep ? completedSteps.indexOf(currentStep) : -1;
  const progressPercent = currentStep
    ? Math.min(100, Math.round(((currentStepIndex + 1) / completedSteps.length) * 100))
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Left: Receipt image */}
      <div>
        <img
          src={`/api/receipts/${receiptId}/image`}
          alt="Receipt"
          className="w-full rounded-2xl border border-white/10"
        />
      </div>

      {/* Right: Parsed data + actions */}
      <div className="space-y-6">
        {/* Status badge */}
        <div className="flex items-center gap-3">
          <Badge variant={STATUS_BADGE_VARIANT[receipt.status] ?? "muted"} className="px-3 py-1 text-sm">
            {receipt.status.replace("_", " ")}
          </Badge>
          {receipt.error_message && (
            <span className="text-sm text-red-400">{receipt.error_message}</span>
          )}
        </div>

        {/* Confidence score */}
        {parsed?.confidence_score !== null && parsed?.confidence_score !== undefined && (
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

        {/* Editable fields */}
        {receipt.status === "processing" ? (
          <div className="text-center py-8">
            {pollGaveUp && !usingWebSocket ? (
              <>
                <p className="text-slate-300 font-medium mb-2">
                  Still processing...
                </p>
                <p className="text-sm text-slate-500 mb-4">
                  This is taking longer than expected. Refresh the page later to check status.
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
                      {completedSteps.slice(0, -1).map((step, i) => (
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
              <div>
                <Label>Subtotal ($)</Label>
                <Input
                  type="text"
                  value={subtotal}
                  onChange={(e) => setSubtotal(e.target.value)}
                  disabled={!isEditable}
                />
              </div>
              <div>
                <Label>Tax ($)</Label>
                <Input
                  type="text"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                  disabled={!isEditable}
                />
              </div>
              <div>
                <Label>Tip ($)</Label>
                <Input
                  type="text"
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                  disabled={!isEditable}
                />
              </div>
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
                onValueChange={(v) => setCategory(v === "__none__" ? "" : v)}
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
          </div>
        )}

        {/* Messages */}
        {message && (
          <p
            className={`text-sm ${message.type === "success" ? "text-green-400" : "text-red-400"}`}
          >
            {message.text}
          </p>
        )}

        {/* Actions */}
        {canFinalize && (
          <div>
            <Button
              variant="success"
              onClick={handleFinalize}
              disabled={finalizing}
              className="w-full sm:w-auto"
            >
              {finalizing ? "Finalizing..." : "Finalize"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
