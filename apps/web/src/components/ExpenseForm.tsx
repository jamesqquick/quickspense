import { useState } from "react";
import type { Category } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";

export type ExpenseFormValues = {
  merchant: string;
  amount: string;
  currency: string;
  expense_date: string;
  category_id: string;
  notes: string;
};

type ExpenseFormProps = {
  categories: Category[];
  initialValues?: ExpenseFormValues;
  onSubmit: (values: ExpenseFormValues) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
  submittingLabel: string;
};

const defaultValues: ExpenseFormValues = {
  merchant: "",
  amount: "",
  currency: "USD",
  expense_date: "",
  category_id: "",
  notes: "",
};

export function ExpenseForm({
  categories,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel,
  submittingLabel,
}: ExpenseFormProps) {
  const [values, setValues] = useState<ExpenseFormValues>(
    initialValues ?? defaultValues,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: keyof ExpenseFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const amountCents = Math.round(parseFloat(values.amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      setError("Amount must be greater than 0");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="merchant">Merchant</Label>
          <Input
            id="merchant"
            type="text"
            value={values.merchant}
            onChange={set("merchant")}
            required
          />
        </div>
        <div>
          <Label htmlFor="amount">Amount ($)</Label>
          <Input
            id="amount"
            type="number"
            step="0.01"
            value={values.amount}
            onChange={set("amount")}
            required
          />
        </div>
        <div>
          <Label htmlFor="expense_date">Date</Label>
          <Input
            id="expense_date"
            type="date"
            value={values.expense_date}
            onChange={set("expense_date")}
            required
          />
        </div>
        <div>
          <Label htmlFor="category_id">Category</Label>
          <NativeSelect
            id="category_id"
            value={values.category_id}
            onChange={set("category_id")}
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Notes</Label>
        <Input
          id="notes"
          type="text"
          value={values.notes}
          onChange={set("notes")}
        />
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3">
        <Button type="submit" variant="success" disabled={submitting}>
          {submitting ? submittingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
