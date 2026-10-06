import type { InvoiceCurrency } from "./invoice-currency.js";

export type ExpenseStatus =
  | "active"
  | "processing"
  | "needs_review"
  | "failed";

export type BusinessProfile = {
  user_id: string;
  business_name: string;
  business_email: string | null;
  business_phone: string | null;
  business_address: string | null;
  created_at: string;
  updated_at: string;
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

export type ExpenseWithParsedData = {
  expense: Expense;
  parsed: ParsedExpense | null;
};

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export type StripeChargeScope = "platform" | "connected";

export type StripeConnectionOperationKind = "connect" | "disconnect";

export type StripeConnectionOperationPhase =
  | "authorizing"
  | "authorized"
  | "disconnecting";

export type StripeConnectionOperation = {
  id: string;
  user_id: string;
  kind: StripeConnectionOperationKind;
  connection_id: string | null;
  expires_at: string | null;
  phase: StripeConnectionOperationPhase;
  stripe_account_id: string | null;
  attempt_id: string | null;
  attempt_expires_at: string | null;
  created_at: string;
};

export type StripeAccountRequirements = {
  disabled_reason: string | null;
  currently_due: string[];
  past_due: string[];
  pending_verification: string[];
  errors: Array<{ code: string; requirement: string }>;
};

export type StripeAccountStatus = {
  stripe_account_id: string;
  livemode: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: StripeAccountRequirements | null;
};

export type StripeConnection = StripeAccountStatus & {
  requirements: StripeAccountRequirements | null;
  id: string;
  user_id: string;
  disconnected_at: string | null;
  disconnect_operation_id: string | null;
  disconnect_started_at: string | null;
  authorization_revision: string;
  stripe_status_at: string;
  created_at: string;
  updated_at: string;
};

export type StripeObservationResult =
  | { outcome: "applied" }
  | {
      outcome: "ignored";
      reason:
        | "authorization_revision_mismatch"
        | "inactive"
        | "mode_mismatch"
        | "not_found"
        | "stale";
    };

export type StripeConnectionStatus = StripeConnection & {
  active: boolean;
  disconnect_pending: boolean;
  mode_matches: boolean;
  ready: boolean;
};

export type StripeConnectState = {
  state_hash: string;
  user_id: string;
  livemode: boolean;
  operation_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  completed_at: string | null;
  created_at: string;
};

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
  currency: InvoiceCurrency;
  notes: string | null;
  due_date: string;
  issued_at: string | null;
  paid_at: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_connection_id: string | null;
  stripe_account_id: string | null;
  stripe_livemode: boolean | null;
  stripe_charge_scope: StripeChargeScope | null;
  stripe_checkout_attempt: number;
  stripe_void_pending: boolean;
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

export type InvoiceCheckoutAttemptState =
  | "creating" | "open" | "processing" | "paid" | "failed" | "expired" | "unknown";

export type InvoiceCheckoutAttempt = {
  id: string;
  invoice_id: string;
  generation: number;
  stripe_connection_id: string;
  stripe_account_id: string;
  livemode: boolean;
  charge_scope: "connected";
  amount_total: number;
  currency: string;
  idempotency_key: string;
  request_json: string;
  state: InvoiceCheckoutAttemptState;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  creation_claim_id: string | null;
  creation_lease_expires_at: string | null;
  first_creation_started_at: string | null;
  retry_until: string | null;
  created_at: string;
  updated_at: string;
};

export type InvoiceWithLineItems = Invoice & {
  line_items: InvoiceLineItem[];
};

export type PayInvoiceInput = { payToken: string };

export type PayInvoiceResult =
  | { status: "checkout"; url: string }
  | { status: "paid" }
  | { status: "processing" };

export type PublicInvoice = Pick<Invoice,
  "invoice_number" | "status" | "client_name" | "subtotal" | "tax_amount" | "total" | "currency"
  | "notes" | "due_date" | "issued_at" | "paid_at"
> & {
  payment_processing: boolean;
  issuer_name: string;
  issuer_email: string | null;
  issuer_phone: string | null;
  issuer_address: string | null;
  line_items: Array<Pick<InvoiceLineItem, "id" | "description" | "quantity" | "unit_price" | "line_total" | "position">>;
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
