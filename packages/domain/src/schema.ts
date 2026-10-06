import { z } from "zod";
import { invoiceCurrencySchema } from "./invoice-currency.js";

export const createCategorySchema = z.object({
  name: z.string().min(1, "Category name is required").max(100),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1, "Category name is required").max(100),
});

export const expenseStatusSchema = z.enum([
  "active",
  "processing",
  "needs_review",
  "failed",
]);

export const updateParsedFieldsSchema = z.object({
  merchant: z.string().optional(),
  total_amount: z.number().int().optional(),
  subtotal_amount: z.number().int().nullable().optional(),
  tax_amount: z.number().int().nullable().optional(),
  tip_amount: z.number().int().nullable().optional(),
  currency: z.string().max(3).optional(),
  purchase_date: z.string().optional(),
  suggested_category: z.string().nullable().optional(),
});

// Used when finalizing a receipt-uploaded expense from `needs_review` -> `active`.
// User confirms the parsed fields here, possibly edited.
export const finalizeExpenseSchema = z.object({
  merchant: z.string().min(1, "Merchant is required"),
  amount: z.number().int().positive("Amount must be greater than 0"),
  currency: z.string().min(1, "Currency is required").max(3),
  expense_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  category_id: z.string().optional(),
  notes: z.string().optional(),
});

export const createManualExpenseSchema = z.object({
  merchant: z.string().min(1, "Merchant is required"),
  amount: z.number().int().positive("Amount must be greater than 0"),
  currency: z.string().min(1).max(3).default("USD"),
  expense_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  category_id: z.string().optional(),
  notes: z.string().optional(),
});

export const updateExpenseSchema = z.object({
  merchant: z.string().min(1).optional(),
  amount: z.number().int().positive().optional(),
  currency: z.string().min(1).max(3).optional(),
  expense_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  category_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const listExpensesSchema = z.object({
  status: expenseStatusSchema.optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  categoryId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export const invoiceStatusSchema = z.enum(["draft", "sent", "paid", "void"]);

export const payInvoiceSchema = z.object({
  payToken: z.string().regex(/^qsi_[0-9a-f]{64}$/, "Invalid invoice payment link"),
}).strict();

export const stripeChargeScopeSchema = z.enum(["platform", "connected"]);

export const stripeAccountRequirementsSchema = z.object({
  disabled_reason: z.string().nullable(),
  currently_due: z.array(z.string()),
  past_due: z.array(z.string()),
  pending_verification: z.array(z.string()),
  errors: z.array(z.object({ code: z.string(), requirement: z.string() })),
});

export const stripeAccountStatusSchema = z.object({
  stripe_account_id: z.string().min(1),
  livemode: z.boolean(),
  charges_enabled: z.boolean(),
  payouts_enabled: z.boolean(),
  details_submitted: z.boolean(),
  requirements: stripeAccountRequirementsSchema.nullable().optional(),
});

export const invoiceLineItemInputSchema = z.object({
  description: z.string().min(1, "Description is required").max(500),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0"),
  unit_price: z.number().int().nonnegative("Unit price must be 0 or greater"),
});

export const createInvoiceSchema = z.object({
  client_name: z.string().min(1, "Client name is required").max(200),
  client_email: z.string().email("Valid client email is required"),
  client_address: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  currency: invoiceCurrencySchema.default("USD"),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD"),
  tax_amount: z.number().int().nonnegative().default(0),
  line_items: z
    .array(invoiceLineItemInputSchema)
    .min(1, "At least one line item is required"),
});

export const updateInvoiceSchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  client_email: z.string().email().optional(),
  client_address: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  currency: invoiceCurrencySchema.optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tax_amount: z.number().int().nonnegative().optional(),
  line_items: z.array(invoiceLineItemInputSchema).min(1).optional(),
});

export const listInvoicesSchema = z.object({
  status: invoiceStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// Business Profile
// ---------------------------------------------------------------------------
// `business_name` is the only required field. Other fields are optional and
// nullable; clients send `null` to clear an existing value or omit a field
// to leave it unchanged on update.
export const upsertBusinessProfileSchema = z.object({
  business_name: z
    .string()
    .min(1, "Business name is required")
    .max(200, "Business name is too long"),
  business_email: z
    .string()
    .email("Invalid business email")
    .max(320)
    .nullable()
    .optional(),
  business_phone: z.string().max(50).nullable().optional(),
  business_address: z.string().max(1000).nullable().optional(),
});
