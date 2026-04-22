import { useState, useEffect } from "react";
import type { Receipt } from "@quickspense/domain";

const STATUS_COLORS: Record<string, string> = {
  uploaded: "bg-slate-500/20 text-slate-300",
  processing: "bg-yellow-500/20 text-yellow-300",
  needs_review: "bg-blue-500/20 text-blue-300",
  finalized: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
};

const STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  needs_review: "Needs Review",
  finalized: "Finalized",
  failed: "Failed",
};

const TABS = [
  { value: "", label: "All" },
  { value: "needs_review", label: "Needs Review" },
  { value: "processing", label: "Processing" },
  { value: "uploaded", label: "Uploaded" },
  { value: "finalized", label: "Finalized" },
  { value: "failed", label: "Failed" },
];

export function ReceiptList() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("limit", "50");

    fetch(`/api/receipts?${params}`)
      .then((r) => r.json())
      .then((data) => setReceipts(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <div>
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatus(tab.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 cursor-pointer ${
              status === tab.value
                ? "bg-primary-500 text-white"
                : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : receipts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400">No receipts found.</p>
          <a
            href="/receipts/upload"
            className="text-primary-400 hover:text-primary-300 text-sm mt-2 inline-block transition-colors duration-200"
          >
            Upload your first receipt
          </a>
        </div>
      ) : (
        <div className="space-y-2">
          {receipts.map((r) => (
            <a
              key={r.id}
              href={`/receipts/${r.id}`}
              className="block glass rounded-xl p-4 hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-white">{r.file_name}</p>
                  <p className="text-sm text-slate-500">
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] || ""}`}
                >
                  {STATUS_LABELS[r.status] || r.status}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
