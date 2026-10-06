import { useState } from "react";
import type { PublicInvoice } from "@quickspense/domain";
import { actions } from "astro:actions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatInvoiceMoney } from "@/lib/invoiceMoney";

export function PublicInvoiceView({
  token,
  initialInvoice,
  initialSuccess = false,
}: {
  token: string;
  initialInvoice: PublicInvoice | null;
  initialSuccess?: boolean;
}) {
  const [invoice, setInvoice] = useState(initialInvoice);
  const [paying, setPaying] = useState(false);
  const [processing, setProcessing] = useState(false);

  const startCheckout = async () => {
    setPaying(true);
    try {
      const { data, error } = await actions.invoice.pay({ payToken: token });
      if (error) {
        toast.error(error.message || "Payment could not be started. Please try again.");
        return;
      }
      if (data.status === "checkout") {
        window.location.href = data.url;
      } else if (data.status === "paid") {
        setInvoice((current) => current && { ...current, status: "paid" });
      } else {
        setProcessing(true);
      }
    } catch {
      toast.error("Payment could not be started. Please try again.");
    } finally {
      setPaying(false);
    }
  };

  if (!invoice) {
    return (
      <Card className="p-8 text-center">
        <p className="text-red-400">Invoice not available</p>
      </Card>
    );
  }

  const isPayable = invoice.status === "sent";
  const isPaid = invoice.status === "paid";
  const isVoid = invoice.status === "void";
  const isProcessing = isPayable && (processing || invoice.payment_processing);

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

      {(initialSuccess || isProcessing) && !isPaid && (
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
                    {formatInvoiceMoney(item.unit_price / 100, invoice.currency)}
                  </td>
                  <td className="py-2 text-right text-white">
                    {formatInvoiceMoney(item.line_total / 100, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-white/10 pt-4 space-y-1 text-sm">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span>{formatInvoiceMoney(invoice.subtotal / 100, invoice.currency)}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>Tax</span>
            <span>{formatInvoiceMoney(invoice.tax_amount / 100, invoice.currency)}</span>
          </div>
          <div className="flex justify-between text-white font-semibold text-base">
            <span>Total due</span>
            <span>{formatInvoiceMoney(invoice.total / 100, invoice.currency)}</span>
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

      <div className="flex flex-col items-center gap-3">
        {isPayable && (
          <Button size="lg" onClick={startCheckout} disabled={paying || isProcessing}>
            {isProcessing
              ? "Payment processing"
              : paying
              ? "Confirming..."
              : `Pay ${formatInvoiceMoney(invoice.total / 100, invoice.currency)}`}
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
