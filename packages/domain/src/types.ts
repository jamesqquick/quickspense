export type ExpenseStatus =
  | "active"
  | "processing"
  | "needs_review"
  | "failed";

export type User = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
};

export type BusinessProfile = {
  user_id: string;
  business_name: string;
  business_email: string | null;
  business_phone: string | null;
  business_address: string | null;
  created_at: string;
  updated_at: string;
};

export type Session = {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
};

export type ApiToken = {
  id: string;
  user_id: string;
  token_hash: string;
  name: string;
  created_at: string;
};

export type Category = {
  id: string;
  user_id: string | null;
  name: string;
  is_global: boolean;
  created_at: string;
};

export type Expense = {
  id: string;
  user_id: string;
  status: ExpenseStatus;
  merchant: string | null;
  amount: number | null;
  currency: string;
  expense_date: string | null;
  category_id: string | null;
  notes: string | null;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  error_message: string | null;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ParsedExpense = {
  id: string;
  expense_id: string;
  ocr_text: string | null;
  merchant: string | null;
  total_amount: number | null;
  subtotal_amount: number | null;
  tax_amount: number | null;
  tip_amount: number | null;
  currency: string | null;
  purchase_date: string | null;
  suggested_category: string | null;
  confidence_score: number | null;
  raw_response: string | null;
  created_at: string;
};

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export type Invoice = {
  id: string;
  user_id: string;
  invoice_number: string;
  pay_token: string;
  status: InvoiceStatus;
  client_name: string;
  client_email: string;
  client_address: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  currency: string;
  notes: string | null;
  due_date: string;
  issued_at: string | null;
  paid_at: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type InvoiceLineItem = {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  position: number;
  created_at: string;
};

export type InvoiceWithLineItems = Invoice & {
  line_items: InvoiceLineItem[];
};

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type ExpenseSummary = {
  total: number;
  count: number;
  byCategory: Array<{
    category_id: string | null;
    category_name: string | null;
    total: number;
    count: number;
  }>;
};
