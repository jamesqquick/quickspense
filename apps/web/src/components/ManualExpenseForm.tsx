import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Category } from "@quickspense/domain";
import { ExpenseForm, type ExpenseFormValues } from "./ExpenseForm";
import { Card } from "@/components/ui/card";

/**
 * Standalone manual expense create form for the `/expenses/new` page.
 * Optionally attaches a receipt image (no parsing).
 */
export function ManualExpenseForm() {
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const handleSubmit = async (values: ExpenseFormValues) => {
    const amountCents = Math.round(parseFloat(values.amount) * 100);

    let res: Response;
    if (values.file) {
      // Multipart submission with image attachment, no parse.
      const form = new FormData();
      form.append("file", values.file);
      form.append("merchant", values.merchant);
      form.append("amount", String(amountCents));
      form.append("currency", values.currency || "USD");
      form.append("expense_date", values.expense_date);
      if (values.category_id) form.append("category_id", values.category_id);
      if (values.notes) form.append("notes", values.notes);

      res = await fetch("/api/expenses", { method: "POST", body: form });
    } else {
      res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: values.merchant,
          amount: amountCents,
          currency: values.currency || "USD",
          expense_date: values.expense_date,
          category_id: values.category_id || undefined,
          notes: values.notes || undefined,
        }),
      });
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to create expense");
    }

    toast.success("Expense created");
    window.location.href = "/expenses";
  };

  return (
    <Card className="p-6">
      <ExpenseForm
        categories={categories}
        onSubmit={handleSubmit}
        submitLabel="Create Expense"
        submittingLabel="Creating..."
        showImageField
      />
    </Card>
  );
}
