import type { InvoiceCurrency } from "@quickspense/domain";

export function formatInvoiceMoney(
  amount: number,
  currency: InvoiceCurrency,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}
