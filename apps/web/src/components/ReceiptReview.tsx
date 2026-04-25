import { useState, useEffect } from "react";
import type { Receipt, ParsedReceipt } from "@quickspense/domain";
import { Skeleton } from "./Skeleton";

type Props = {
  receiptId: string;
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

const STATUS_COLORS: Record<string, string> = {
  uploaded: "bg-slate-500/20 text-slate-300",
  processing: "bg-yellow-500/20 text-yellow-300",
  needs_review: "bg-blue-500/20 text-blue-300",
  finalized: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
};

export function ReceiptReview({ receiptId }: Props) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showOcr, setShowOcr] = useState(false);

  // Editable fields
  const [merchant, setMerchant] = useState("");
  const [total, setTotal] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [tip, setTip] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("");

  const fetchData = async () => {
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
        setCategory(data.parsed.suggested_category || "");
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load receipt" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [receiptId]);

  // Poll when processing with exponential backoff.
  const [pollGaveUp, setPollGaveUp] = useState(false);
  useEffect(() => {
    if (receipt?.status !== "processing") {
      setPollGaveUp(false);
      return;
    }

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
  }, [receipt?.status]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/receipts/${receiptId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: merchant || undefined,
          total_amount: parseCents(total) ?? undefined,
          subtotal_amount: parseCents(subtotal),
          tax_amount: parseCents(tax),
          tip_amount: parseCents(tip),
          currency: currency || undefined,
          purchase_date: date || undefined,
          suggested_category: category || null,
        }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Changes saved" });
        const updated = await res.json();
        setParsed(updated);
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Save failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/receipts/${receiptId}/reprocess`, {
        method: "POST",
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Reprocessing started" });
        await fetchData();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Reprocess failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Reprocess failed" });
    } finally {
      setReprocessing(false);
    }
  };

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
          category_id: undefined,
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
        {/* Image placeholder */}
        <Skeleton className="w-full aspect-[3/4] rounded-2xl" />

        {/* Form fields placeholder */}
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
          <div className="flex gap-3">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
      </div>
    );
  }

  if (!receipt) {
    return <p className="text-red-400">Receipt not found</p>;
  }

  const isEditable = receipt.status === "needs_review";
  const canReprocess = ["needs_review", "failed"].includes(receipt.status);
  const canFinalize = receipt.status === "needs_review";

  const inputClasses =
    "w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent disabled:bg-white/5 disabled:text-slate-500 disabled:border-white/10";
  const labelClasses = "block text-sm font-medium text-slate-300 mb-1";

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
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[receipt.status] || ""}`}
          >
            {receipt.status.replace("_", " ")}
          </span>
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
            {pollGaveUp ? (
              <>
                <p className="text-slate-300 font-medium mb-2">
                  Still processing...
                </p>
                <p className="text-sm text-slate-500 mb-4">
                  This is taking longer than expected. Refresh the page later to check status.
                </p>
                <button
                  onClick={fetchData}
                  className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200 cursor-pointer"
                >
                  Check now
                </button>
              </>
            ) : (
              <>
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-400 mx-auto mb-4" />
                <p className="text-slate-400">Processing receipt...</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className={labelClasses}>Merchant</label>
              <input
                type="text"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                disabled={!isEditable}
                className={inputClasses}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClasses}>Total ($)</label>
                <input
                  type="text"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  disabled={!isEditable}
                  className={inputClasses}
                />
              </div>
              <div>
                <label className={labelClasses}>Subtotal ($)</label>
                <input
                  type="text"
                  value={subtotal}
                  onChange={(e) => setSubtotal(e.target.value)}
                  disabled={!isEditable}
                  className={inputClasses}
                />
              </div>
              <div>
                <label className={labelClasses}>Tax ($)</label>
                <input
                  type="text"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                  disabled={!isEditable}
                  className={inputClasses}
                />
              </div>
              <div>
                <label className={labelClasses}>Tip ($)</label>
                <input
                  type="text"
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                  disabled={!isEditable}
                  className={inputClasses}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClasses}>Currency</label>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={!isEditable}
                  maxLength={3}
                  className={inputClasses}
                />
              </div>
              <div>
                <label className={labelClasses}>Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={!isEditable}
                  className={inputClasses}
                />
              </div>
            </div>
            <div>
              <label className={labelClasses}>
                Suggested Category
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={!isEditable}
                className={inputClasses}
              />
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
        <div className="flex gap-3 flex-wrap">
          {isEditable && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-white/10 text-white px-4 py-2 rounded-xl hover:bg-white/20 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
            >
              {saving ? "Saving..." : "Save Edits"}
            </button>
          )}
          {canReprocess && (
            <button
              onClick={handleReprocess}
              disabled={reprocessing}
              className="bg-yellow-500/20 text-yellow-300 px-4 py-2 rounded-xl hover:bg-yellow-500/30 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
            >
              {reprocessing ? "Reprocessing..." : "Reprocess"}
            </button>
          )}
          {canFinalize && (
            <button
              onClick={handleFinalize}
              disabled={finalizing}
              className="bg-green-500/20 text-green-300 px-4 py-2 rounded-xl hover:bg-green-500/30 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
            >
              {finalizing ? "Finalizing..." : "Finalize"}
            </button>
          )}
        </div>

        {/* OCR Text collapsible */}
        {parsed?.ocr_text && (
          <div>
            <button
              onClick={() => setShowOcr(!showOcr)}
              className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200 cursor-pointer"
            >
              {showOcr ? "Hide OCR Text" : "Show OCR Text"}
            </button>
            {showOcr && (
              <pre className="mt-2 p-3 bg-white/5 rounded-xl text-xs text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto border border-white/10">
                {parsed.ocr_text}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
