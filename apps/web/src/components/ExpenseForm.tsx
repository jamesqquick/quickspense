import { useState } from "react";
import { toast } from "sonner";
import type { Category } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export type ExpenseFormValues = {
  merchant: string;
  amount: string;
  currency: string;
  expense_date: string;
  category_id: string;
  notes: string;
  /** Optional image file. Stored as-is; not parsed. */
  file?: File | null;
};

type ExpenseFormProps = {
  categories: Category[];
  initialValues?: ExpenseFormValues;
  onSubmit: (values: ExpenseFormValues) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
  submittingLabel: string;
  /** Show the optional image attachment field. Defaults to false (legacy edit modal). */
  showImageField?: boolean;
};

const defaultValues: ExpenseFormValues = {
  merchant: "",
  amount: "",
  currency: "USD",
  expense_date: "",
  category_id: "",
  notes: "",
  file: null,
};

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export function ExpenseForm({
  categories,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel,
  submittingLabel,
  showImageField = false,
}: ExpenseFormProps) {
  const [values, setValues] = useState<ExpenseFormValues>(
    initialValues ?? defaultValues,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: keyof ExpenseFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setValidationError("Image must be JPEG, PNG, or WEBP");
        e.target.value = "";
        return;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        setValidationError("Image must be under 10MB");
        e.target.value = "";
        return;
      }
    }
    setValidationError(null);
    setValues((v) => ({ ...v, file }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const amountCents = Math.round(parseFloat(values.amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      setValidationError("Amount must be greater than 0");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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
          <Label>Category</Label>
          <Select
            value={values.category_id || "__none__"}
            onValueChange={(v) =>
              setValues((prev) => ({ ...prev, category_id: v === "__none__" ? "" : v }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      {showImageField && (
        <div>
          <Label htmlFor="image">Receipt image (optional)</Label>
          <Input
            id="image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
          />
          <p className="text-xs text-slate-500 mt-1">
            JPEG, PNG, or WEBP up to 10MB. Image is stored alongside the
            expense, not parsed.
          </p>
          {values.file && (
            <p className="text-xs text-slate-400 mt-1">
              Selected: {values.file.name}
            </p>
          )}
        </div>
      )}
      {validationError && (
        <p className="text-red-400 text-sm" role="alert">
          {validationError}
        </p>
      )}
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
