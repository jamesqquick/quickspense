-- Migration: Invoices
-- Adds invoices and invoice_line_items tables for the invoicing feature.

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoice_line_items_invoice ON invoice_line_items(invoice_id, position);
