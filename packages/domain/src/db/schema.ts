import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  unique,
  check,
} from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";
import type { StripeAccountRequirements } from "../types.js";

// ---------------------------------------------------------------------------
// Users (Better Auth core)
// ---------------------------------------------------------------------------
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  categories: many(categories),
  expenses: many(expenses),
  invoices: many(invoices),
  stripeConnections: many(stripeConnections),
  stripeConnectionOperations: many(stripeConnectionOperations),
  stripeConnectStates: many(stripeConnectStates),
  businessProfile: one(businessProfiles, {
    fields: [users.id],
    references: [businessProfiles.user_id],
  }),
}));

// ---------------------------------------------------------------------------
// Sessions (Better Auth core)
// ---------------------------------------------------------------------------
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_sessions_user_id").on(table.userId),
    index("idx_sessions_token").on(table.token),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Accounts (Better Auth core — for OAuth / credential providers)
// ---------------------------------------------------------------------------
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("idx_accounts_user_id").on(table.userId)],
);

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Verifications (Better Auth core — email verification, password reset tokens)
// ---------------------------------------------------------------------------
export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ---------------------------------------------------------------------------
// API Keys (Better Auth API Key plugin)
// ---------------------------------------------------------------------------
export const apikeys = sqliteTable(
  "apikeys",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: integer("last_request", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("idx_apikeys_key").on(table.key),
    index("idx_apikeys_reference_id").on(table.referenceId),
  ],
);

// ---------------------------------------------------------------------------
// Business Profiles (1:1 with users)
// ---------------------------------------------------------------------------
export const businessProfiles = sqliteTable("business_profiles", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  business_name: text("business_name").notNull(),
  business_email: text("business_email"),
  business_phone: text("business_phone"),
  business_address: text("business_address"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const businessProfilesRelations = relations(
  businessProfiles,
  ({ one }) => ({
    user: one(users, {
      fields: [businessProfiles.user_id],
      references: [users.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    is_global: integer("is_global", { mode: "boolean" }).notNull().default(false),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_categories_user").on(table.user_id),
    uniqueIndex("idx_categories_global_name").on(table.name).where(sql`is_global = 1`),
  ],
);

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  user: one(users, { fields: [categories.user_id], references: [users.id] }),
  expenses: many(expenses),
}));

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export const expenses = sqliteTable(
  "expenses",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    merchant: text("merchant"),
    amount: integer("amount"),
    currency: text("currency").notNull().default("USD"),
    expense_date: text("expense_date"),
    category_id: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    file_key: text("file_key"),
    file_name: text("file_name"),
    file_size: integer("file_size"),
    file_type: text("file_type"),
    error_message: text("error_message"),
    workflow_id: text("workflow_id"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_expenses_user_date").on(table.user_id, table.expense_date),
    index("idx_expenses_user_status").on(table.user_id, table.status),
  ],
);

export const expensesRelations = relations(expenses, ({ one, many }) => ({
  user: one(users, { fields: [expenses.user_id], references: [users.id] }),
  category: one(categories, {
    fields: [expenses.category_id],
    references: [categories.id],
  }),
  parsedExpenses: many(parsedExpenses),
}));

// ---------------------------------------------------------------------------
// Parsed Expenses
// ---------------------------------------------------------------------------
export const parsedExpenses = sqliteTable(
  "parsed_expenses",
  {
    id: text("id").primaryKey(),
    expense_id: text("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    ocr_text: text("ocr_text"),
    merchant: text("merchant"),
    total_amount: integer("total_amount"),
    subtotal_amount: integer("subtotal_amount"),
    tax_amount: integer("tax_amount"),
    tip_amount: integer("tip_amount"),
    currency: text("currency").default("USD"),
    purchase_date: text("purchase_date"),
    suggested_category: text("suggested_category"),
    confidence_score: real("confidence_score"),
    raw_response: text("raw_response"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_parsed_expenses_expense").on(table.expense_id)],
);

export const parsedExpensesRelations = relations(parsedExpenses, ({ one }) => ({
  expense: one(expenses, {
    fields: [parsedExpenses.expense_id],
    references: [expenses.id],
  }),
}));

// ---------------------------------------------------------------------------
// Stripe Connect
// ---------------------------------------------------------------------------
export const stripeConnections = sqliteTable(
  "stripe_connections",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stripe_account_id: text("stripe_account_id").notNull(),
    livemode: integer("livemode", { mode: "boolean" }).notNull(),
    charges_enabled: integer("charges_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    payouts_enabled: integer("payouts_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    details_submitted: integer("details_submitted", { mode: "boolean" })
      .notNull()
      .default(false),
    requirements: text("requirements", { mode: "json" }).$type<StripeAccountRequirements>(),
    disconnected_at: text("disconnected_at"),
    disconnect_operation_id: text("disconnect_operation_id"),
    disconnect_started_at: text("disconnect_started_at"),
    authorization_revision: text("authorization_revision").notNull(),
    stripe_status_at: text("stripe_status_at").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_stripe_connections_account").on(table.stripe_account_id),
    uniqueIndex("idx_stripe_connections_active_user")
      .on(table.user_id)
      .where(sql`${table.disconnected_at} IS NULL`),
    index("idx_stripe_connections_user").on(table.user_id),
  ],
);

export const stripeConnectionsRelations = relations(
  stripeConnections,
  ({ one, many }) => ({
    user: one(users, {
      fields: [stripeConnections.user_id],
      references: [users.id],
    }),
    invoices: many(invoices),
  }),
);

export const stripeConnectionOperations = sqliteTable(
  "stripe_connection_operations",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    connection_id: text("connection_id").references(() => stripeConnections.id),
    expires_at: text("expires_at"),
    phase: text("phase").notNull(),
    stripe_account_id: text("stripe_account_id"),
    attempt_id: text("attempt_id"),
    attempt_expires_at: text("attempt_expires_at"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_stripe_connection_operations_connection").on(
      table.connection_id,
    ),
    check(
      "stripe_connection_operations_kind_check",
      sql`${table.kind} IN ('connect', 'disconnect')`,
    ),
    check(
      "stripe_connection_operations_shape_check",
      sql`(${table.kind} = 'connect' AND ${table.connection_id} IS NULL AND ${table.expires_at} IS NOT NULL) OR (${table.kind} = 'disconnect' AND ${table.connection_id} IS NOT NULL AND ${table.expires_at} IS NULL)`,
    ),
    check(
      "stripe_connection_operations_phase_check",
      sql`(${table.kind} = 'connect' AND ((${table.phase} = 'authorizing' AND ${table.stripe_account_id} IS NULL) OR (${table.phase} = 'authorized' AND ${table.stripe_account_id} IS NOT NULL)) AND ${table.attempt_id} IS NULL AND ${table.attempt_expires_at} IS NULL) OR (${table.kind} = 'disconnect' AND ${table.phase} = 'disconnecting' AND ${table.stripe_account_id} IS NULL AND ((${table.attempt_id} IS NULL AND ${table.attempt_expires_at} IS NULL) OR (${table.attempt_id} IS NOT NULL AND ${table.attempt_expires_at} IS NOT NULL)))`,
    ),
  ],
);

export const stripeConnectionOperationsRelations = relations(
  stripeConnectionOperations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [stripeConnectionOperations.user_id],
      references: [users.id],
    }),
    connection: one(stripeConnections, {
      fields: [stripeConnectionOperations.connection_id],
      references: [stripeConnections.id],
    }),
    states: many(stripeConnectStates),
  }),
);

export const stripeConnectStates = sqliteTable(
  "stripe_connect_states",
  {
    state_hash: text("state_hash").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    livemode: integer("livemode", { mode: "boolean" }).notNull(),
    operation_id: text("operation_id").references(
      () => stripeConnectionOperations.id,
      { onDelete: "set null" },
    ),
    expires_at: text("expires_at").notNull(),
    consumed_at: text("consumed_at"),
    completed_at: text("completed_at"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_stripe_connect_states_user_expires").on(
      table.user_id,
      table.expires_at,
    ),
  ],
);

export const stripeConnectStatesRelations = relations(
  stripeConnectStates,
  ({ one }) => ({
    user: one(users, {
      fields: [stripeConnectStates.user_id],
      references: [users.id],
    }),
    operation: one(stripeConnectionOperations, {
      fields: [stripeConnectStates.operation_id],
      references: [stripeConnectionOperations.id],
    }),
  }),
);

export const stripeWebhookEvents = sqliteTable(
  "stripe_webhook_events",
  {
    event_key: text("event_key").primaryKey(),
    stripe_account_id: text("stripe_account_id").notNull(),
    event_id: text("event_id").notNull(),
    event_type: text("event_type").notNull(),
    processed_at: text("processed_at").notNull().default(sql`(datetime('now'))`),
    charge_scope: text("charge_scope"),
    livemode: integer("livemode", { mode: "boolean" }),
    invoice_id: text("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    checkout_attempt_id: text("checkout_attempt_id").references(
      () => invoiceCheckoutAttempts.id,
      { onDelete: "restrict" },
    ),
    stripe_session_id: text("stripe_session_id"),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    result: text("result"),
    receipt_id: text("receipt_id"),
    amount_total: integer("amount_total"),
    currency: text("currency"),
    payment_status: text("payment_status"),
  },
  (table) => [
    index("idx_stripe_webhook_events_account").on(table.stripe_account_id),
  ],
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invoice_number: text("invoice_number").notNull(),
    pay_token: text("pay_token").notNull().unique(),
    status: text("status").notNull().default("draft"),
    client_name: text("client_name").notNull(),
    client_email: text("client_email").notNull(),
    client_address: text("client_address"),
    subtotal: integer("subtotal").notNull().default(0),
    tax_amount: integer("tax_amount").notNull().default(0),
    total: integer("total").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    notes: text("notes"),
    due_date: text("due_date").notNull(),
    issued_at: text("issued_at"),
    paid_at: text("paid_at"),
    stripe_session_id: text("stripe_session_id"),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    stripe_connection_id: text("stripe_connection_id").references(
      () => stripeConnections.id,
    ),
    stripe_account_id: text("stripe_account_id"),
    stripe_livemode: integer("stripe_livemode", { mode: "boolean" }),
    stripe_charge_scope: text("stripe_charge_scope"),
    stripe_checkout_attempt: integer("stripe_checkout_attempt").notNull().default(0),
    stripe_void_pending: integer("stripe_void_pending", { mode: "boolean" }).notNull().default(false),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_invoices_user_status").on(table.user_id, table.status),
    index("idx_invoices_user_created").on(table.user_id, table.created_at),
    uniqueIndex("idx_invoices_user_number").on(table.user_id, table.invoice_number),
    index("idx_invoices_pay_token").on(table.pay_token),
    index("idx_invoices_stripe_connection").on(table.stripe_connection_id),
    check(
      "invoices_stripe_charge_scope_check",
      sql`${table.stripe_charge_scope} IS NULL OR ${table.stripe_charge_scope} IN ('platform', 'connected')`,
    ),
  ],
);

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  user: one(users, { fields: [invoices.user_id], references: [users.id] }),
  stripeConnection: one(stripeConnections, {
    fields: [invoices.stripe_connection_id],
    references: [stripeConnections.id],
  }),
  lineItems: many(invoiceLineItems),
  checkoutAttempts: many(invoiceCheckoutAttempts),
}));

export const invoiceCheckoutAttempts = sqliteTable(
  "invoice_checkout_attempts",
  {
    id: text("id").primaryKey(),
    invoice_id: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    stripe_connection_id: text("stripe_connection_id").notNull().references(() => stripeConnections.id, { onDelete: "restrict" }),
    stripe_account_id: text("stripe_account_id").notNull(),
    livemode: integer("livemode", { mode: "boolean" }).notNull(),
    charge_scope: text("charge_scope").notNull(),
    amount_total: integer("amount_total").notNull(),
    currency: text("currency").notNull(),
    idempotency_key: text("idempotency_key").notNull().unique(),
    request_json: text("request_json").notNull(),
    state: text("state").notNull(),
    stripe_session_id: text("stripe_session_id"),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    creation_claim_id: text("creation_claim_id"),
    creation_lease_expires_at: text("creation_lease_expires_at"),
    first_creation_started_at: text("first_creation_started_at"),
    retry_until: text("retry_until"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_invoice_checkout_attempts_generation").on(table.invoice_id, table.generation),
    uniqueIndex("idx_invoice_checkout_attempts_active").on(table.invoice_id)
      .where(sql`${table.state} IN ('creating', 'open', 'processing', 'unknown')`),
    uniqueIndex("idx_invoice_checkout_attempts_session")
      .on(table.stripe_account_id, table.livemode, table.stripe_session_id)
      .where(sql`${table.stripe_session_id} IS NOT NULL`),
    check("invoice_checkout_attempts_generation_check", sql`${table.generation} > 0`),
    check("invoice_checkout_attempts_scope_check", sql`${table.charge_scope} = 'connected'`),
    check("invoice_checkout_attempts_amount_check", sql`${table.amount_total} > 0`),
    check("invoice_checkout_attempts_mode_check", sql`${table.livemode} IN (0, 1)`),
    check("invoice_checkout_attempts_request_check", sql`json_valid(${table.request_json}) AND json_type(${table.request_json}) = 'object'`),
    check("invoice_checkout_attempts_state_check", sql`${table.state} IN ('creating', 'open', 'processing', 'paid', 'failed', 'expired', 'unknown')`),
    check("invoice_checkout_attempts_lease_check", sql`(${table.creation_claim_id} IS NULL AND ${table.creation_lease_expires_at} IS NULL) OR (${table.creation_claim_id} IS NOT NULL AND ${table.creation_lease_expires_at} IS NOT NULL)`),
    check("invoice_checkout_attempts_retry_check", sql`(${table.first_creation_started_at} IS NULL AND ${table.retry_until} IS NULL) OR (${table.first_creation_started_at} IS NOT NULL AND ${table.retry_until} IS NOT NULL)`),
  ],
);

export const invoiceCheckoutAttemptsRelations = relations(invoiceCheckoutAttempts, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceCheckoutAttempts.invoice_id], references: [invoices.id] }),
  stripeConnection: one(stripeConnections, { fields: [invoiceCheckoutAttempts.stripe_connection_id], references: [stripeConnections.id] }),
}));

export const invoiceLegacySessionEvidence = sqliteTable("invoice_legacy_session_evidence", {
  invoice_id: text("invoice_id").primaryKey().references(() => invoices.id, { onDelete: "restrict" }),
  stripe_session_id: text("stripe_session_id").notNull(),
  livemode: integer("livemode", { mode: "boolean" }).notNull(),
  amount_total: integer("amount_total").notNull(),
  currency: text("currency").notNull(),
  pay_token: text("pay_token").notNull(),
  confirmed_expired: integer("confirmed_expired", { mode: "boolean" }).notNull(),
  observed_at: text("observed_at").notNull(),
});

// ---------------------------------------------------------------------------
// Invoice Line Items
// ---------------------------------------------------------------------------
export const invoiceLineItems = sqliteTable(
  "invoice_line_items",
  {
    id: text("id").primaryKey(),
    invoice_id: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: real("quantity").notNull().default(1),
    unit_price: integer("unit_price").notNull().default(0),
    line_total: integer("line_total").notNull().default(0),
    position: integer("position").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_invoice_line_items_invoice").on(table.invoice_id, table.position),
  ],
);

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLineItems.invoice_id],
    references: [invoices.id],
  }),
}));
