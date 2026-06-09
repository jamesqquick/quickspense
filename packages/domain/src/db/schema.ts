import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";

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
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_invoices_user_status").on(table.user_id, table.status),
    index("idx_invoices_user_created").on(table.user_id, table.created_at),
    uniqueIndex("idx_invoices_user_number").on(table.user_id, table.invoice_number),
    index("idx_invoices_pay_token").on(table.pay_token),
  ],
);

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  user: one(users, { fields: [invoices.user_id], references: [users.id] }),
  lineItems: many(invoiceLineItems),
}));

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
