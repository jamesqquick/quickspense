import { useEffect, useState } from "react";
import type { InvoiceWithLineItems } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import {
  InvoiceForm,
  buildInvoicePayload,
  type InvoiceFormValues,
} from "./InvoiceForm";

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function invoiceToFormValues(invoice: InvoiceWithLineItems): InvoiceFormValues {
  return {
    client_name: invoice.client_name,
    client_email: invoice.client_email,
    client_address: invoice.client_address ?? "",
    due_date: invoice.due_date ?? "",
    notes: invoice.notes ?? "",
    tax_amount: (invoice.tax_amount / 100).toFixed(2),
    line_items:
      invoice.line_items.length > 0
        ? invoice.line_items.map((item) => ({
            description: item.description,
            quantity: String(item.quantity),
            unit_price: (item.unit_price / 100).toFixed(2),
          }))
        : [{ description: "", quantity: "1", unit_price: "0.00" }],
  };
}

export function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  const [invoice, setInvoice] = useState<InvoiceWithLineItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}`);
      if (res.ok) {
        setInvoice(await res.json());
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const update = async (values: InvoiceFormValues) => {
    const res = await fetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildInvoicePayload(values)),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to update invoice");
    }
    const updated = (await res.json()) as InvoiceWithLineItems;
    setInvoice(updated);
    setEditing(false);
  };

  const performAction = async (
    path: string,
    confirmMessage?: string,
    method: "POST" | "DELETE" = "POST",
  ) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setActionError(null);
    setActionPending(true);
    try {
      const res = await fetch(path, { method });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Action failed");
      }
      if (path.endsWith("/send") || path.endsWith("/void")) {
        const data = await res.json().catch(() => null);
        if (data) setInvoice(data);
        else load();
      } else if (method === "DELETE") {
        window.location.href = "/invoices";
        return;
      } else {
        load();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Card className="p-6 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </div>
    );
  }

  if (!invoice) {
    return <p className="text-slate-400">Invoice not found.</p>;
  }

  const payUrl = `${window.location.origin}/pay/${invoice.pay_token}`;

  if (editing && invoice.status === "draft") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-white">
          Edit {invoice.invoice_number}
        </h1>
        <InvoiceForm
          initialValues={invoiceToFormValues(invoice)}
          onCancel={() => setEditing(false)}
          submitLabel="Save changes"
          onSubmit={update}
          secondaryAction={{
            label: "Save & send",
            onClick: async (values) => {
              await update(values);
              await performAction(`/api/invoices/${invoiceId}/send`);
            },
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-white">
              {invoice.invoice_number}
            </h1>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {invoice.client_name} &middot; {invoice.client_email}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {invoice.status === "draft" && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                disabled={actionPending}
                onClick={() => performAction(`/api/invoices/${invoiceId}/send`)}
              >
                {actionPending ? "Sending..." : "Send invoice"}
              </Button>
              <Button
                variant="ghost"
                disabled={actionPending}
                onClick={() =>
                  performAction(
                    `/api/invoices/${invoiceId}`,
                    "Delete this draft? This cannot be undone.",
                    "DELETE",
                  )
                }
                className="hover:text-red-400"
              >
                Delete
              </Button>
            </>
          )}
          {invoice.status === "sent" && (
            <>
              <Button
                variant="outline"
                disabled={actionPending}
                onClick={() => performAction(`/api/invoices/${invoiceId}/send`)}
              >
                {actionPending ? "Resending..." : "Resend email"}
              </Button>
              <Button
                variant="ghost"
                disabled={actionPending}
                onClick={() =>
                  performAction(
                    `/api/invoices/${invoiceId}/void`,
                    "Void this invoice? It can no longer be paid.",
                  )
                }
                className="hover:text-red-400"
              >
                Void
              </Button>
            </>
          )}
        </div>
      </div>

      {actionError && (
        <p className="text-sm text-red-400" role="alert">
          {actionError}
        </p>
      )}

      {invoice.status !== "draft" && (
        <Card className="p-4 space-y-2">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Public pay link
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 text-xs text-slate-300 bg-black/30 px-2 py-1 rounded truncate">
              {payUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard?.writeText(payUrl)}
            >
              Copy
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={payUrl} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">
              Bill to
            </p>
            <p className="text-white font-medium">{invoice.client_name}</p>
            <p className="text-slate-400">{invoice.client_email}</p>
            {invoice.client_address && (
              <p className="text-slate-400 whitespace-pre-line mt-1">
                {invoice.client_address}
              </p>
            )}
          </div>
          <div className="sm:text-right space-y-1">
            {invoice.issued_at && (
              <p className="text-slate-400">
                <span className="text-xs uppercase tracking-wide mr-2">
                  Issued
                </span>
                {invoice.issued_at.split("T")[0]}
              </p>
            )}
            {invoice.due_date && (
              <p className="text-slate-400">
                <span className="text-xs uppercase tracking-wide mr-2">
                  Due
                </span>
                {invoice.due_date}
              </p>
            )}
            {invoice.paid_at && (
              <p className="text-green-300">
                <span className="text-xs uppercase tracking-wide mr-2">
                  Paid
                </span>
                {invoice.paid_at.split("T")[0]}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 pt-4">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left py-2">Description</th>
                <th className="text-right py-2">Qty</th>
                <th className="text-right py-2">Unit</th>
                <th className="text-right py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {invoice.line_items.map((item) => (
                <tr key={item.id} className="border-t border-white/5">
                  <td className="py-2 text-slate-200">{item.description}</td>
                  <td className="py-2 text-right text-slate-300">
                    {item.quantity}
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    ${formatCents(item.unit_price)}
                  </td>
                  <td className="py-2 text-right text-white">
                    ${formatCents(item.line_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-white/10 pt-4 space-y-1 text-sm">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span>${formatCents(invoice.subtotal)}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>Tax</span>
            <span>${formatCents(invoice.tax_amount)}</span>
          </div>
          <div className="flex justify-between text-white font-semibold text-base">
            <span>Total</span>
            <span>${formatCents(invoice.total)}</span>
          </div>
        </div>

        {invoice.notes && (
          <div className="border-t border-white/10 pt-4">
            <p className="text-xs uppercase tracking-wide text-slate-400 mb-1">
              Notes
            </p>
            <p className="text-sm text-slate-300 whitespace-pre-line">
              {invoice.notes}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
