import { useEffect, useRef } from "react";
import type { Expense, Category } from "@quickspense/domain";
import { ExpenseForm, type ExpenseFormValues } from "./ExpenseForm";

type ExpenseEditModalProps = {
  expense: Expense;
  categories: Category[];
  onSave: (updated: Expense) => void;
  onClose: () => void;
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function ExpenseEditModal({
  expense,
  categories,
  onSave,
  onClose,
}: ExpenseEditModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const initialValues: ExpenseFormValues = {
    merchant: expense.merchant,
    amount: formatCents(expense.amount),
    currency: expense.currency,
    expense_date: expense.expense_date,
    category_id: expense.category_id ?? "",
    notes: expense.notes ?? "",
  };

  const handleSubmit = async (values: ExpenseFormValues) => {
    const amountCents = Math.round(parseFloat(values.amount) * 100);

    const res = await fetch(`/api/expenses/${expense.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant: values.merchant,
        amount: amountCents,
        currency: values.currency || "USD",
        expense_date: values.expense_date,
        category_id: values.category_id || null,
        notes: values.notes || null,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to update expense");
    }

    const updated: Expense = await res.json();
    onSave(updated);
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="glass rounded-2xl p-6 w-full max-w-lg border border-white/10">
        <h2 className="text-lg font-semibold text-white mb-4">Edit Expense</h2>
        <ExpenseForm
          categories={categories}
          initialValues={initialValues}
          onSubmit={handleSubmit}
          onCancel={onClose}
          submitLabel="Save Changes"
          submittingLabel="Saving..."
        />
      </div>
    </div>
  );
}
