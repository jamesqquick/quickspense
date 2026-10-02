import { z } from "zod";

export const invoiceCurrencySchema = z.enum(["USD", "EUR"]);

export type InvoiceCurrency = z.infer<typeof invoiceCurrencySchema>;
