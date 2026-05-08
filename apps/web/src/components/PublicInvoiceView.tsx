import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type PublicInvoice = {
  invoice_number: string;
  status: "draft" | "sent" | "paid" | "void";
  client_name: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  currency: string;
  notes: string | null;
  due_date: string;
  issued_at: string | null;
  paid_at: string | null;
  issuer_name: string;
  issuer_email: string | null;
  issuer_phone: string | null;
  issuer_address: string | null;
  line_items: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    position: number;
  }>;
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function PublicInvoiceView({
  token,
  initialSuccess = false,
}: {
  token: string;
  initialSuccess?: boolean;
}) {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`/api/invoices/public/${token}`);
        if (!res.ok) {
          if (!mounted) return;
          setError(res.status === 404 ? "Invoice not found" : "Failed to load");
          return;
        }
        const data = (await res.json()) as PublicInvoice;
        if (!mounted) return;
        setInvoice(data);
      } catch {
        if (mounted) setError("Failed to load");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [token]);

  const startCheckout = async () => {
    setPaying(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/public/${token}/checkout`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Checkout failed");
      }
      if (!data.url) throw new Error("No checkout URL returned");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6 space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </Card>
    );
  }

  if (error || !invoice) {
    return (
      <Card className="p-8 text-center">
        <p className="text-red-400">{error ?? "Invoice not available"}</p>
      </Card>
    );
  }

  const isPayable = invoice.status === "sent";
  const isPaid = invoice.status === "paid";
  const isVoid = invoice.status === "void";

  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <p className="text-sm text-slate-400">Invoice from</p>
        <p className="text-xl font-semibold text-white">{invoice.issuer_name}</p>
        {invoice.issuer_address && (
          <p className="text-sm text-slate-400 whitespace-pre-line">
            {invoice.issuer_address}
          </p>
        )}
        {(invoice.issuer_email || invoice.issuer_phone) && (
          <p className="text-sm text-slate-400">
            {[invoice.issuer_email, invoice.issuer_phone]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>

      {initialSuccess && isPaid && (
        <Card className="p-4 bg-green-500/10 border-green-500/30 text-center">
          <p className="text-green-300 font-medium">Payment successful</p>
          <p className="text-sm text-green-400/80 mt-1">
            Thank you for your payment.
          </p>
        </Card>
      )}

      {initialSuccess && !isPaid && (
        <Card className="p-4 bg-blue-500/10 border-blue-500/30 text-center">
          <p className="text-blue-300 font-medium">Processing your payment</p>
          <p className="text-sm text-blue-400/80 mt-1">
            We're confirming with the payment processor. Refresh in a moment.
          </p>
        </Card>
      )}

      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">
              Invoice
            </p>
            <p className="text-2xl font-bold text-white">
              {invoice.invoice_number}
            </p>
          </div>
          <div className="text-right text-sm">
            {invoice.issued_at && (
              <p className="text-slate-400">
                Issued {invoice.issued_at.split("T")[0]}
              </p>
            )}
            <p className="text-slate-400">Due {invoice.due_date}</p>
            {isPaid && invoice.paid_at && (
              <p className="text-green-300">
                Paid {invoice.paid_at.split("T")[0]}
              </p>
            )}
            {isVoid && <p className="text-red-300">Voided</p>}
          </div>
        </div>

        <div className="border-t border-white/10 pt-4">
          <p className="text-xs uppercase tracking-wide text-slate-400 mb-1">
            Bill to
          </p>
          <p className="text-white">{invoice.client_name}</p>
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
            <span>Total due</span>
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

      {error && (
        <p className="text-sm text-red-400 text-center" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col items-center gap-3">
        {isPayable && (
          <Button size="lg" onClick={startCheckout} disabled={paying}>
            {paying ? "Redirecting..." : `Pay $${formatCents(invoice.total)}`}
          </Button>
        )}
        {isPaid && (
          <p className="text-green-300 text-center">
            This invoice has been paid.
          </p>
        )}
        {isVoid && (
          <p className="text-red-300 text-center">
            This invoice has been voided.
          </p>
        )}
        {(isPayable || isPaid) && (
          <Button variant="outline" asChild>
            <a
              href={`/api/invoices/public/${token}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download PDF
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
