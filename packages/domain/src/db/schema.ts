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
// Users
// ---------------------------------------------------------------------------
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  apiTokens: many(apiTokens),
  categories: many(categories),
  receipts: many(receipts),
  expenses: many(expenses),
  passwordResetTokens: many(passwordResetTokens),
}));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_sessions_expires").on(table.expires_at)],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.user_id], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// API Tokens
// ---------------------------------------------------------------------------
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_api_tokens_hash").on(table.token_hash)],
);

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.user_id], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_categories_user").on(table.user_id),
    unique().on(table.user_id, table.name),
  ],
);

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  user: one(users, { fields: [categories.user_id], references: [users.id] }),
  expenses: many(expenses),
}));

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------
export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    file_key: text("file_key").notNull(),
    file_name: text("file_name").notNull(),
    file_size: integer("file_size").notNull(),
    file_type: text("file_type").notNull(),
    status: text("status").notNull().default("uploaded"),
    error_message: text("error_message"),
    workflow_id: text("workflow_id"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_receipts_user_status").on(table.user_id, table.status),
    index("idx_receipts_updated").on(table.updated_at),
  ],
);

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  user: one(users, { fields: [receipts.user_id], references: [users.id] }),
  parsedReceipts: many(parsedReceipts),
  expenses: many(expenses),
}));

// ---------------------------------------------------------------------------
// Parsed Receipts
// ---------------------------------------------------------------------------
export const parsedReceipts = sqliteTable(
  "parsed_receipts",
  {
    id: text("id").primaryKey(),
    receipt_id: text("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
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
  (table) => [
    index("idx_parsed_receipts_receipt").on(table.receipt_id),
  ],
);

export const parsedReceiptsRelations = relations(
  parsedReceipts,
  ({ one }) => ({
    receipt: one(receipts, {
      fields: [parsedReceipts.receipt_id],
      references: [receipts.id],
    }),
  }),
);

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
    receipt_id: text("receipt_id").references(() => receipts.id),
    merchant: text("merchant").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    expense_date: text("expense_date").notNull(),
    category_id: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_expenses_user_date").on(table.user_id, table.expense_date),
    index("idx_expenses_receipt").on(table.receipt_id),
  ],
);

export const expensesRelations = relations(expenses, ({ one }) => ({
  user: one(users, { fields: [expenses.user_id], references: [users.id] }),
  receipt: one(receipts, {
    fields: [expenses.receipt_id],
    references: [receipts.id],
  }),
  category: one(categories, {
    fields: [expenses.category_id],
    references: [categories.id],
  }),
}));

// ---------------------------------------------------------------------------
// Password Reset Tokens
// ---------------------------------------------------------------------------
export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_password_reset_tokens_hash").on(table.token_hash),
    index("idx_password_reset_tokens_user").on(table.user_id),
  ],
);

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.user_id],
      references: [users.id],
    }),
  }),
);
