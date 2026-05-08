import { toast } from "sonner";
import type { Expense, Category } from "@quickspense/domain";
import { ExpenseForm, type ExpenseFormValues } from "./ExpenseForm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ExpenseEditModalProps = {
  expense: Expense;
  categories: Category[];
  onSave: (updated: Expense) => void;
  onClose: () => void;
};

function formatCents(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

export function ExpenseEditModal({
  expense,
  categories,
  onSave,
  onClose,
}: ExpenseEditModalProps) {
  const initialValues: ExpenseFormValues = {
    merchant: expense.merchant ?? "",
    amount: formatCents(expense.amount),
    currency: expense.currency,
    expense_date: expense.expense_date ?? "",
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
    toast.success("Expense updated");
    onSave(updated);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Expense</DialogTitle>
        </DialogHeader>
        <ExpenseForm
          categories={categories}
          initialValues={initialValues}
          onSubmit={handleSubmit}
          onCancel={onClose}
          submitLabel="Save Changes"
          submittingLabel="Saving..."
        />
      </DialogContent>
    </Dialog>
  );
}
