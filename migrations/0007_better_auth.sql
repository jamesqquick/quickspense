-- Migration: Replace custom auth tables with Better Auth schema
-- This drops ALL existing auth data (users, sessions, api_tokens, password_reset_tokens).
-- All user data (expenses, categories, invoices, etc.) is also dropped due to cascading FKs.

-- ---------------------------------------------------------------------------
-- Drop old auth tables
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS sessions;

-- Drop tables that FK into users (cascade won't help on DROP TABLE)
DROP TABLE IF EXISTS invoice_line_items;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS parsed_expenses;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS business_profiles;
DROP TABLE IF EXISTS users;

-- ---------------------------------------------------------------------------
-- Better Auth core tables
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  id_token TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_accounts_user_id ON accounts(user_id);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Better Auth API Key plugin table
-- ---------------------------------------------------------------------------

CREATE TABLE apikeys (
  id TEXT PRIMARY KEY NOT NULL,
  config_id TEXT NOT NULL DEFAULT 'default',
  name TEXT,
  start TEXT,
  prefix TEXT,
  key TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  refill_interval INTEGER,
  refill_amount INTEGER,
  last_refill_at TEXT,
  enabled INTEGER DEFAULT 1,
  rate_limit_enabled INTEGER,
  rate_limit_time_window INTEGER,
  rate_limit_max INTEGER,
  request_count INTEGER,
  remaining INTEGER,
  last_request TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  permissions TEXT,
  metadata TEXT
);
CREATE INDEX idx_apikeys_key ON apikeys(key);
CREATE INDEX idx_apikeys_reference_id ON apikeys(reference_id);

-- ---------------------------------------------------------------------------
-- Recreate non-auth tables that had FK to users
-- ---------------------------------------------------------------------------

CREATE TABLE business_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_email TEXT,
  business_phone TEXT,
  business_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_categories_user ON categories(user_id);
CREATE UNIQUE INDEX idx_categories_global_name ON categories(name) WHERE is_global = 1;

CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  merchant TEXT,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  expense_date TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  notes TEXT,
  file_key TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_type TEXT,
  error_message TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_user_date ON expenses(user_id, expense_date);
CREATE INDEX idx_expenses_user_status ON expenses(user_id, status);

CREATE TABLE parsed_expenses (
  id TEXT PRIMARY KEY NOT NULL,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  ocr_text TEXT,
  merchant TEXT,
  total_amount INTEGER,
  subtotal_amount INTEGER,
  tax_amount INTEGER,
  tip_amount INTEGER,
  currency TEXT DEFAULT 'USD',
  purchase_date TEXT,
  suggested_category TEXT,
  confidence_score REAL,
  raw_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_parsed_expenses_expense ON parsed_expenses(expense_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  pay_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_address TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  due_date TEXT NOT NULL,
  issued_at TEXT,
  paid_at TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_user_status ON invoices(user_id, status);
CREATE INDEX idx_invoices_user_created ON invoices(user_id, created_at);
CREATE UNIQUE INDEX idx_invoices_user_number ON invoices(user_id, invoice_number);
CREATE INDEX idx_invoices_pay_token ON invoices(pay_token);

CREATE TABLE invoice_line_items (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoice_line_items_invoice ON invoice_line_items(invoice_id, position);
