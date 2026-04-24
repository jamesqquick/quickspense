import { useState } from "react";
import type { Category } from "@quickspense/domain";

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

const inputClasses =
  "w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent text-sm";

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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Merchant
          </label>
          <input
            type="text"
            value={values.merchant}
            onChange={set("merchant")}
            required
            className={inputClasses}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Amount ($)
          </label>
          <input
            type="number"
            step="0.01"
            value={values.amount}
            onChange={set("amount")}
            required
            className={inputClasses}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Date
          </label>
          <input
            type="date"
            value={values.expense_date}
            onChange={set("expense_date")}
            required
            className={inputClasses}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Category
          </label>
          <select
            value={values.category_id}
            onChange={set("category_id")}
            className={inputClasses}
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">
          Notes
        </label>
        <input
          type="text"
          value={values.notes}
          onChange={set("notes")}
          className={inputClasses}
        />
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-green-500/20 text-green-300 px-4 py-2 rounded-xl hover:bg-green-500/30 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
        >
          {submitting ? submittingLabel : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 px-4 py-2 rounded-xl hover:bg-white/10 text-sm font-medium transition-colors duration-200 cursor-pointer"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
