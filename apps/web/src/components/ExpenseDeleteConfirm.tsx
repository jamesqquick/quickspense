import { useState, useEffect, useRef } from "react";
import type { Expense } from "@quickspense/domain";

type ExpenseDeleteConfirmProps = {
  expense: Expense;
  onConfirm: () => void;
  onCancel: () => void;
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function ExpenseDeleteConfirm({
  expense,
  onConfirm,
  onCancel,
}: ExpenseDeleteConfirmProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onCancel]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onCancel();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/expenses/${expense.id}`, {
        method: "DELETE",
      });

      if (res.ok || res.status === 204) {
        onConfirm();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete expense");
      }
    } catch {
      setError("Failed to delete expense");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="glass rounded-2xl p-6 w-full max-w-sm border border-white/10">
        <h2 className="text-lg font-semibold text-white mb-2">
          Delete Expense
        </h2>
        <p className="text-slate-400 text-sm mb-4">
          Are you sure you want to delete{" "}
          <span className="text-white font-medium">{expense.merchant}</span> for{" "}
          <span className="text-white font-medium">
            ${formatCents(expense.amount)}
          </span>
          ? This cannot be undone.
        </p>
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        <div className="flex gap-3">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="bg-red-500/20 text-red-300 px-4 py-2 rounded-xl hover:bg-red-500/30 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
          <button
            onClick={onCancel}
            className="text-slate-400 px-4 py-2 rounded-xl hover:bg-white/10 text-sm font-medium transition-colors duration-200 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
