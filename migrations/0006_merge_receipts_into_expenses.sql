-- Migration: Merge receipts into expenses
--
-- Collapses the two-concept model (receipts + expenses) into a single
-- expenses concept. An expense can now optionally have a file attachment
-- (image) and a parse pipeline (status, error_message, workflow_id).
--
-- Status lifecycle:
--   active        - manual or finalized; counts toward totals/exports
--   processing    - image uploaded, AI parse running
--   needs_review  - parse done, user must confirm
--   failed        - parse errored
--
-- Strategy:
--   1. Build a new `expenses_new` table with the merged shape.
--   2. Capture receipt_id -> expense_id mapping for finalized receipts so
--      we can later redirect their parsed_receipts rows correctly.
--   3. Backfill from existing receipts + their already-finalized expenses.
--   4. Drop and rename: expenses_new -> expenses.
--   5. Migrate parsed_receipts -> parsed_expenses keyed off expense_id.
--   6. Drop the legacy `receipts` and `parsed_receipts` tables.

-- Unified expenses table.
-- merchant/amount/expense_date are nullable here so processing/failed rows
-- (which haven't been parsed/confirmed yet) are valid. Application code
-- enforces these are set before status reaches `active`/`needs_review`.
CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','processing','needs_review','failed')),
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

-- Step 1: Copy already-finalized expenses, attaching their source receipt's
-- file metadata so the image stays accessible from the unified record.
INSERT INTO expenses_new (
  id, user_id, status, merchant, amount, currency, expense_date,
  category_id, notes, file_key, file_name, file_size, file_type,
  error_message, workflow_id, created_at, updated_at
)
SELECT
  e.id,
  e.user_id,
  'active',
  e.merchant,
  e.amount,
  e.currency,
  e.expense_date,
  e.category_id,
  e.notes,
  r.file_key,
  r.file_name,
  r.file_size,
  r.file_type,
  NULL,
  NULL,
  e.created_at,
  e.updated_at
FROM expenses e
LEFT JOIN receipts r ON r.id = e.receipt_id;

-- Capture mapping: legacy receipt_id -> new expense_id (for finalized rows).
-- Used to redirect parsed_receipts rows whose receipt_id will no longer
-- match any expense after the table swap. Plain table, dropped at end.
CREATE TABLE receipt_to_expense_map (
  receipt_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL
);
INSERT INTO receipt_to_expense_map (receipt_id, expense_id)
SELECT e.receipt_id, e.id FROM expenses e WHERE e.receipt_id IS NOT NULL;

-- Step 2: Bring over receipts that were never finalized as their own expense
-- rows. Map legacy statuses into the new vocabulary.
--   uploaded     -> processing  (workflow may not have started yet)
--   processing   -> processing
--   needs_review -> needs_review
--   failed       -> failed
-- Latest parsed_receipt (if any) populates merchant/amount/date.
INSERT INTO expenses_new (
  id, user_id, status, merchant, amount, currency, expense_date,
  category_id, notes, file_key, file_name, file_size, file_type,
  error_message, workflow_id, created_at, updated_at
)
SELECT
  r.id,
  r.user_id,
  CASE r.status
    WHEN 'uploaded' THEN 'processing'
    WHEN 'processing' THEN 'processing'
    WHEN 'needs_review' THEN 'needs_review'
    WHEN 'failed' THEN 'failed'
    ELSE 'processing'
  END,
  pr.merchant,
  pr.total_amount,
  COALESCE(pr.currency, 'USD'),
  pr.purchase_date,
  NULL,
  NULL,
  r.file_key,
  r.file_name,
  r.file_size,
  r.file_type,
  r.error_message,
  r.workflow_id,
  r.created_at,
  r.updated_at
FROM receipts r
LEFT JOIN (
  SELECT pr1.*
  FROM parsed_receipts pr1
  INNER JOIN (
    SELECT receipt_id, MAX(created_at) AS max_created
    FROM parsed_receipts
    GROUP BY receipt_id
  ) latest ON latest.receipt_id = pr1.receipt_id AND latest.max_created = pr1.created_at
) pr ON pr.receipt_id = r.id
WHERE r.status != 'finalized';

-- Replace old expenses table with the merged one.
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expenses_user_date ON expenses(user_id, expense_date);
CREATE INDEX idx_expenses_user_status ON expenses(user_id, status);

-- New parsed table keyed off expense_id.
CREATE TABLE parsed_expenses (
  id TEXT PRIMARY KEY,
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

-- Migrate parsed_receipts. Two cases:
--   1. Receipt was finalized -> use the mapping table to redirect to the
--      original expense id.
--   2. Receipt was not finalized -> the new expense reuses the receipt id,
--      so receipt_id maps directly to expense_id.
INSERT INTO parsed_expenses (
  id, expense_id, ocr_text, merchant, total_amount, subtotal_amount,
  tax_amount, tip_amount, currency, purchase_date, suggested_category,
  confidence_score, raw_response, created_at
)
SELECT
  pr.id,
  COALESCE(m.expense_id, pr.receipt_id),
  pr.ocr_text,
  pr.merchant,
  pr.total_amount,
  pr.subtotal_amount,
  pr.tax_amount,
  pr.tip_amount,
  pr.currency,
  pr.purchase_date,
  pr.suggested_category,
  pr.confidence_score,
  pr.raw_response,
  pr.created_at
FROM parsed_receipts pr
LEFT JOIN receipt_to_expense_map m ON m.receipt_id = pr.receipt_id
WHERE COALESCE(m.expense_id, pr.receipt_id) IN (SELECT id FROM expenses);

CREATE INDEX idx_parsed_expenses_expense ON parsed_expenses(expense_id);

-- Cleanup: drop legacy tables and the temporary mapping table.
DROP TABLE parsed_receipts;
DROP TABLE receipts;
DROP TABLE receipt_to_expense_map;
