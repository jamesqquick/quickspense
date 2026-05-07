-- Migration: Business Profiles
-- Adds a 1:1 business profile per user so invoices can render the user's
-- actual business identity instead of a global default.

CREATE TABLE business_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_email TEXT,
  business_phone TEXT,
  business_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
