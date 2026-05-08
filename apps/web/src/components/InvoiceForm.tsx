import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  InvoiceLineItemsEditor,
  emptyLineItem,
  type LineItemDraft,
} from "./InvoiceLineItemsEditor";

export type InvoiceFormValues = {
  client_name: string;
  client_email: string;
  client_address: string;
  due_date: string;
  notes: string;
  tax_amount: string; // dollars
  line_items: LineItemDraft[];
};

/** Returns YYYY-MM-DD for `daysFromNow` days in the future, in local time. */
function defaultDueDate(daysFromNow = 30): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptyInvoiceForm(): InvoiceFormValues {
  return {
    client_name: "",
    client_email: "",
    client_address: "",
    due_date: defaultDueDate(30),
    notes: "",
    tax_amount: "0.00",
    line_items: [emptyLineItem()],
  };
}

function dollarsToCents(value: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function buildInvoicePayload(values: InvoiceFormValues) {
  return {
    client_name: values.client_name.trim(),
    client_email: values.client_email.trim(),
    client_address: values.client_address.trim() || null,
    due_date: values.due_date,
    notes: values.notes.trim() || null,
    tax_amount: dollarsToCents(values.tax_amount),
    line_items: values.line_items.map((item) => ({
      description: item.description.trim(),
      quantity: parseFloat(item.quantity || "0") || 0,
      unit_price: dollarsToCents(item.unit_price),
    })),
  };
}

export function InvoiceForm({
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = "Save draft",
  secondaryAction,
}: {
  initialValues?: InvoiceFormValues;
  onSubmit: (values: InvoiceFormValues) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
  /** Optional secondary action like "Save & send". */
  secondaryAction?: {
    label: string;
    onClick: (values: InvoiceFormValues) => Promise<void> | void;
  };
}) {
  const [values, setValues] = useState<InvoiceFormValues>(
    initialValues ?? emptyInvoiceForm(),
  );
  const [submitting, setSubmitting] = useState<"primary" | "secondary" | null>(
    null,
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = <K extends keyof InvoiceFormValues>(
    key: K,
    value: InvoiceFormValues[K],
  ) => setValues((prev) => ({ ...prev, [key]: value }));

  const subtotal = useMemo(
    () =>
      values.line_items.reduce((acc, item) => {
        const qty = parseFloat(item.quantity || "0");
        const price = parseFloat(item.unit_price || "0");
        if (!Number.isFinite(qty) || !Number.isFinite(price)) return acc;
        return acc + qty * price;
      }, 0),
    [values.line_items],
  );

  const tax = useMemo(() => {
    const n = parseFloat(values.tax_amount || "0");
    return Number.isFinite(n) ? n : 0;
  }, [values.tax_amount]);

  const total = subtotal + tax;

  const validate = (): string | null => {
    if (!values.client_name.trim()) return "Client name is required";
    if (!values.client_email.trim()) return "Client email is required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.client_email))
      return "Client email is invalid";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.due_date))
      return "Due date is required";
    if (values.line_items.length === 0) return "At least one line item is required";
    for (const item of values.line_items) {
      if (!item.description.trim()) return "Each line item needs a description";
      const q = parseFloat(item.quantity);
      if (!Number.isFinite(q) || q <= 0) return "Quantity must be greater than 0";
      const p = parseFloat(item.unit_price);
      if (!Number.isFinite(p) || p < 0) return "Unit price must be 0 or greater";
    }
    return null;
  };

  const handle = async (
    handler: (values: InvoiceFormValues) => Promise<void> | void,
    kind: "primary" | "secondary",
  ) => {
    setValidationError(null);
    const v = validate();
    if (v) {
      setValidationError(v);
      return;
    }
    setSubmitting(kind);
    try {
      await handler(values);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handle(onSubmit, "primary");
      }}
      className="space-y-6"
    >
      <Card className="p-6 space-y-4">
        <h2 className="text-sm font-semibold text-slate-300">Client</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Client name</Label>
            <Input
              value={values.client_name}
              onChange={(e) => update("client_name", e.target.value)}
              placeholder="Acme Inc."
              required
            />
          </div>
          <div>
            <Label>Client email</Label>
            <Input
              type="email"
              value={values.client_email}
              onChange={(e) => update("client_email", e.target.value)}
              placeholder="billing@acme.com"
              required
            />
          </div>
        </div>
        <div>
          <Label>Address (optional)</Label>
          <Textarea
            value={values.client_address}
            onChange={(e) => update("client_address", e.target.value)}
            placeholder={"123 Main St\nSpringfield, USA"}
            rows={3}
          />
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-sm font-semibold text-slate-300">Items</h2>
        <InvoiceLineItemsEditor
          items={values.line_items}
          onChange={(items) => update("line_items", items)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div>
            <Label>Tax amount (USD)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={values.tax_amount}
              onChange={(e) => update("tax_amount", e.target.value)}
            />
          </div>
          <div>
            <Label>Due date</Label>
            <Input
              type="date"
              value={values.due_date}
              onChange={(e) => update("due_date", e.target.value)}
              required
            />
          </div>
        </div>
        <div className="border-t border-white/10 pt-4 text-sm space-y-1">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span>${subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>Tax</span>
            <span>${tax.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-semibold text-white">
            <span>Total</span>
            <span>${total.toFixed(2)}</span>
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-sm font-semibold text-slate-300">Notes (optional)</h2>
        <Textarea
          value={values.notes}
          onChange={(e) => update("notes", e.target.value)}
          placeholder="Thank you for your business."
          rows={3}
        />
      </Card>

      {validationError && (
        <p className="text-sm text-red-400" role="alert">
          {validationError}
        </p>
      )}

      <div className="flex flex-wrap gap-2 justify-end">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting !== null}>
          {submitting === "primary" ? "Saving..." : submitLabel}
        </Button>
        {secondaryAction && (
          <Button
            type="button"
            variant="outline"
            disabled={submitting !== null}
            onClick={() => handle(secondaryAction.onClick, "secondary")}
          >
            {submitting === "secondary"
              ? "Working..."
              : secondaryAction.label}
          </Button>
        )}
      </div>
    </form>
  );
}
