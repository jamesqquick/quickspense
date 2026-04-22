import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const createCategorySchema = z.object({
  name: z.string().min(1, "Category name is required").max(100),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1, "Category name is required").max(100),
});

export const receiptStatusSchema = z.enum([
  "uploaded",
  "processing",
  "needs_review",
  "finalized",
  "failed",
]);

export const listReceiptsSchema = z.object({
  status: receiptStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

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

export const finalizeReceiptSchema = z.object({
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
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  categoryId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1, "Token name is required").max(100),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
