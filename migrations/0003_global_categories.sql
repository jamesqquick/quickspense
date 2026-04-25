-- Migration: Global categories
-- Categories become global (shared across all users) with an is_global flag.
-- Users can still create custom categories (user_id set, is_global = 0).
-- SQLite doesn't support ALTER COLUMN to drop NOT NULL, so we recreate the table.

-- Step 1: Create the new categories table with nullable user_id and is_global column
CREATE TABLE categories_new (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Step 2: Migrate existing per-user categories (they become user-owned, is_global = 0)
INSERT INTO categories_new (id, user_id, name, is_global, created_at)
SELECT id, user_id, name, 0, created_at FROM categories;

-- Step 3: Drop old table and rename
DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;

-- Step 4: Recreate indexes
CREATE INDEX idx_categories_user ON categories(user_id);
CREATE UNIQUE INDEX idx_categories_global_name ON categories(name) WHERE is_global = 1;

-- Step 5: Update expenses foreign key (SQLite keeps the reference by column name,
-- but since we recreated the table we need to verify the FK still works.
-- The expenses table references categories(id) which still exists with the same PKs.)

-- Step 6: Insert the 20 global default categories
INSERT INTO categories (id, user_id, name, is_global, created_at) VALUES
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Food & Dining', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Groceries', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Transportation', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Shopping', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Entertainment', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Healthcare', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Utilities', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Housing', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Insurance', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Education', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Personal Care', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Travel', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Subscriptions', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Gifts & Donations', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Automotive', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Home & Garden', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Pets', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Office & Business', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Taxes & Fees', 1, datetime('now')),
  (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), NULL, 'Other', 1, datetime('now'));

-- Step 7: Clean up old per-user categories that match global ones.
-- Expenses referencing these old per-user categories need to be re-pointed to the global ones.
-- For each user-owned category that has the same name as a global one,
-- update expenses to point to the global category, then delete the user-owned duplicate.
UPDATE expenses
SET category_id = (
  SELECT g.id FROM categories g
  WHERE g.is_global = 1
    AND g.name = (SELECT c.name FROM categories c WHERE c.id = expenses.category_id AND c.is_global = 0)
)
WHERE category_id IN (
  SELECT uc.id FROM categories uc
  INNER JOIN categories gc ON gc.name = uc.name AND gc.is_global = 1
  WHERE uc.is_global = 0
);

DELETE FROM categories
WHERE is_global = 0
  AND name IN (SELECT name FROM categories WHERE is_global = 1);
