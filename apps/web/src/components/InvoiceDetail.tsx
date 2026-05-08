import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { BusinessProfile, InvoiceWithLineItems } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { navigateWithFlashToast } from "@/lib/flashToast";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import {
  InvoiceForm,
  buildInvoicePayload,
  type InvoiceFormValues,
} from "./InvoiceForm";

type ConfirmState = {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  variant?: "default" | "destructive";
  run: () => Promise<void>;
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function invoiceToFormValues(invoice: InvoiceWithLineItems): InvoiceFormValues {
  return {
    client_name: invoice.client_name,
    client_email: invoice.client_email,
    client_address: invoice.client_address ?? "",
    due_date: invoice.due_date,
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
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [devEmailSkipped, setDevEmailSkipped] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      // Fetch invoice and business profile in parallel. Profile is best-effort
      // (404 = user hasn't set one up yet); we still render the invoice.
      const [invoiceRes, profileRes] = await Promise.all([
        fetch(`/api/invoices/${invoiceId}`),
        fetch("/api/me/business-profile"),
      ]);
      if (invoiceRes.ok) {
        setInvoice(await invoiceRes.json());
      }
      if (profileRes.ok) {
        setProfile(await profileRes.json());
      } else {
        setProfile(null);
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
    toast.success("Invoice updated");
  };

  const performAction = async (
    path: string,
    method: "POST" | "DELETE" = "POST",
  ) => {
    setActionPending(true);
    try {
      const res = await fetch(path, { method });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Action failed");
      }
      if (path.endsWith("/send") || path.endsWith("/void")) {
        const data = await res.json().catch(() => null);
        if (data) {
          if (data.dev_email_skipped && data.dev_pay_url) {
            setDevEmailSkipped(data.dev_pay_url);
          } else {
            setDevEmailSkipped(null);
          }
          setInvoice(data);
        } else load();
        if (path.endsWith("/send")) toast.success("Invoice sent");
        if (path.endsWith("/void")) toast.success("Invoice voided");
      } else if (method === "DELETE") {
        navigateWithFlashToast("/invoices", "success", "Invoice deleted");
        return;
      } else {
        load();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };

  const requestDelete = () => {
    setConfirm({
      title: "Delete invoice?",
      description:
        "This permanently removes the invoice and its line items. This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
      run: () => performAction(`/api/invoices/${invoiceId}`, "DELETE"),
    });
  };

  const requestVoid = () => {
    setConfirm({
      title: "Void this invoice?",
      description:
        "Voiding marks the invoice as cancelled. The pay link will stop working.",
      confirmLabel: "Void invoice",
      variant: "destructive",
      run: () => performAction(`/api/invoices/${invoiceId}/void`),
    });
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
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
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
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 w-full sm:w-auto">
          {invoice.status === "draft" && (
            <>
              <Button
                variant="outline"
                onClick={() => setEditing(true)}
                className="w-full sm:w-auto"
              >
                Edit
              </Button>
              <Button
                disabled={actionPending}
                onClick={() => performAction(`/api/invoices/${invoiceId}/send`)}
                className="w-full sm:w-auto"
              >
                {actionPending ? "Sending..." : "Send invoice"}
              </Button>
              <Button
                variant="ghost"
                disabled={actionPending}
                onClick={requestDelete}
                className="w-full sm:w-auto hover:text-red-400"
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
                className="w-full sm:w-auto"
              >
                {actionPending ? "Resending..." : "Resend email"}
              </Button>
              <Button
                variant="ghost"
                disabled={actionPending}
                onClick={requestVoid}
                className="w-full sm:w-auto hover:text-red-400"
              >
                Void
              </Button>
            </>
          )}
          {invoice.status === "void" && (
            <Button
              variant="ghost"
              disabled={actionPending}
              onClick={requestDelete}
              className="w-full sm:w-auto hover:text-red-400"
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !actionPending) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        variant={confirm?.variant}
        pending={actionPending}
        onConfirm={async () => {
          if (!confirm) return;
          await confirm.run();
          setConfirm(null);
        }}
      />

      {devEmailSkipped && (
        <Card className="p-4 bg-yellow-500/10 border-yellow-500/30 space-y-2">
          <p className="text-xs uppercase tracking-wide text-yellow-300">
            Local dev — email skipped
          </p>
          <p className="text-sm text-yellow-200/90">
            The send_email binding isn't available under <code>astro dev</code>.
            Open the pay link directly to continue testing:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 text-xs text-slate-300 bg-black/30 px-2 py-1 rounded truncate">
              {devEmailSkipped}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard?.writeText(devEmailSkipped);
                  toast.success("Copied to clipboard");
                } catch {
                  toast.error("Failed to copy");
                }
              }}
            >
              Copy
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={devEmailSkipped} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            </Button>
          </div>
        </Card>
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
              onClick={async () => {
                try {
                  await navigator.clipboard?.writeText(payUrl);
                  toast.success("Copied to clipboard");
                } catch {
                  toast.error("Failed to copy");
                }
              }}
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
        {!profile && (
          <div className="rounded border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
            You haven't set up your business profile yet. Clients will see a
            generic issuer name on this invoice.{" "}
            <a href="/settings" className="underline hover:text-yellow-100">
              Set it up in settings
            </a>
            .
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">
              From
            </p>
            <p className="text-white font-medium">
              {profile?.business_name ?? "—"}
            </p>
            {profile?.business_email && (
              <p className="text-slate-400">{profile.business_email}</p>
            )}
            {profile?.business_phone && (
              <p className="text-slate-400">{profile.business_phone}</p>
            )}
            {profile?.business_address && (
              <p className="text-slate-400 whitespace-pre-line mt-1">
                {profile.business_address}
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
            <p className="text-slate-400">
              <span className="text-xs uppercase tracking-wide mr-2">
                Due
              </span>
              {invoice.due_date}
            </p>
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
