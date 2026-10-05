import { businessProfiles, invoicePayments, invoices, type Database, type PublicInvoice } from "@quickspense/domain";

export async function getPublicInvoice(db: Database, token: string, fallbackIssuerName: string): Promise<PublicInvoice | null> {
  const invoice = await invoices.getInvoiceByPayToken(db, token);
  if (!invoice) return null;
  const profile = await businessProfiles.getBusinessProfile(db, invoice.user_id);
  const attempt = await invoicePayments.getLatestCheckoutAttempt(db, invoice.id);
  return {
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    client_name: invoice.client_name,
    subtotal: invoice.subtotal,
    tax_amount: invoice.tax_amount,
    total: invoice.total,
    currency: invoice.currency,
    notes: invoice.notes,
    due_date: invoice.due_date,
    issued_at: invoice.issued_at,
    paid_at: invoice.paid_at,
    payment_processing: invoice.status === "sent" && (attempt?.state === "processing" || attempt?.state === "paid"),
    line_items: invoice.line_items.map((item) => ({
      id: item.id, description: item.description, quantity: item.quantity,
      unit_price: item.unit_price, line_total: item.line_total, position: item.position,
    })),
    issuer_name: profile?.business_name ?? fallbackIssuerName,
    issuer_email: profile?.business_email ?? null,
    issuer_phone: profile?.business_phone ?? null,
    issuer_address: profile?.business_address ?? null,
  };
}
