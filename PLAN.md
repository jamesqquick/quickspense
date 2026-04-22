# Quickspense - Receipt-First Expense Tracker

## Product Goal

A receipt-first expense tracker that accepts receipt uploads, stores original files, parses contents using AI, requires review before finalizing, converts receipts into structured expense records, and exposes an MCP server so a chat agent can manage receipts and expenses.

---

## System Principles

- Receipt-first (not expense-first)
- AI is assistive, never authoritative
- Original receipt file is the source of truth
- Parsing must be retryable
- Workflows handle processing, not ingestion
- Separation of concerns across all layers
- Single domain logic shared across UI and MCP
- Minimal complexity, clear responsibilities

---

## Technology Decisions

| Decision | Choice |
|---|---|
| **Name** | Quickspense |
| **Framework** | Astro 5 + `@astrojs/cloudflare` v12.x |
| **Architecture** | Two Workers (Astro web app + Workflow/MCP worker) |
| **Shared logic** | `packages/domain` internal package |
| **Package manager** | pnpm workspaces |
| **Database** | Cloudflare D1 (raw SQL migrations) |
| **Object storage** | Cloudflare R2 (receipt images) |
| **AI** | Workers AI (`@cf/meta/llama-3.2-11b-vision-instruct` for OCR, `@cf/meta/llama-3.1-8b-instruct` for extraction) |
| **Workflow** | Cloudflare Workflows with `step.do()` retries |
| **Auth** | DIY email/password + sessions in D1, multi-user |
| **MCP auth** | Bearer token (API tokens stored in D1) |
| **MCP approach** | `createMcpHandler` (stateless) from `agents` package |
| **UI framework** | React islands |
| **Styling** | Tailwind CSS v4 via `@tailwindcss/vite` |
| **Reprocessing** | Fresh workflow instance every time (Option A) |
| **Image serving** | Inline `<img>` tag, R2 direct serve via API route |
| **File types** | Images only (JPEG, PNG, WEBP) |

---

## Architecture

### Two Workers

The Astro app and the Workflow/MCP worker are separate Workers deployed independently. Both share the same D1 database and R2 bucket via identical bindings. The Astro app triggers workflows via a Service Binding to the worker.

```
+----------------------------+     Service Binding     +----------------------------+
|  apps/web (Astro 5)        | ----------------------> |  apps/worker               |
|  - UI pages                |  (workflow trigger only) |  - ReceiptWorkflow class   |
|  - API routes              |                         |  - MCP server (/mcp)       |
|  - Auth middleware          |                         |  - AI parsing modules      |
|  Bindings: D1, R2          |                         |  Bindings: D1, R2, AI,     |
+----------------------------+                         |    Workflow                |
                                                       +----------------------------+
         Both import from packages/domain (build-time)
         Both read/write same D1 database and R2 bucket
```

**Why two Workers:**
1. Cloudflare Workflows require the class to be exported from the Worker entrypoint. Astro's adapter controls the entrypoint, making injection fragile.
2. The MCP server needs to own its fetch handler for transport negotiation.
3. Both workers share D1/R2 via identical bindings -- no service binding needed for data access.
4. The Astro app triggers workflows via a Service Binding (one call).
5. Both import from `packages/domain` at build time, so domain logic is truly shared.

---

## Project Structure

```
quickspense/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json              # Shared TS config
├── packages/
│   └── domain/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── types.ts            # Receipt, Expense, Category, User types
│           ├── schema.ts           # Zod validation schemas
│           ├── errors.ts           # Domain error classes
│           └── services/
│               ├── auth.ts         # Password hashing, session/token management
│               ├── receipt.ts      # Receipt CRUD, status transitions
│               ├── parse.ts        # Parsed receipt storage/retrieval
│               ├── expense.ts      # Expense CRUD, finalization logic
│               └── category.ts     # Category CRUD
├── apps/
│   ├── web/
│   │   ├── package.json
│   │   ├── astro.config.mjs
│   │   ├── wrangler.jsonc
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── env.d.ts
│   │       ├── middleware.ts       # Auth check, attach user to locals
│   │       ├── styles/
│   │       │   └── global.css      # Tailwind imports
│   │       ├── layouts/
│   │       │   └── Layout.astro    # Shell with nav, auth state
│   │       ├── components/
│   │       │   ├── UploadForm.tsx
│   │       │   ├── ReceiptReview.tsx
│   │       │   ├── ReceiptList.tsx
│   │       │   ├── ExpenseList.tsx
│   │       │   ├── CategoryManager.tsx
│   │       │   └── DashboardSummary.tsx
│   │       └── pages/
│   │           ├── index.astro              # Dashboard
│   │           ├── login.astro
│   │           ├── register.astro
│   │           ├── receipts/
│   │           │   ├── index.astro          # List
│   │           │   ├── upload.astro         # Upload
│   │           │   └── [id].astro           # Review
│   │           ├── expenses/
│   │           │   └── index.astro
│   │           ├── categories/
│   │           │   └── index.astro
│   │           └── api/
│   │               ├── auth/
│   │               │   ├── login.ts
│   │               │   ├── register.ts
│   │               │   └── logout.ts
│   │               ├── receipts/
│   │               │   ├── index.ts         # GET list, POST upload
│   │               │   └── [id]/
│   │               │       ├── index.ts     # GET detail, PATCH update fields
│   │               │       ├── image.ts     # GET serve image from R2
│   │               │       ├── reprocess.ts # POST trigger reprocess
│   │               │       └── finalize.ts  # POST finalize -> create expense
│   │               ├── expenses/
│   │               │   ├── index.ts         # GET list, POST create manual
│   │               │   └── [id].ts          # PATCH update
│   │               └── categories/
│   │                   ├── index.ts         # GET list, POST create
│   │                   └── [id].ts          # PATCH update, DELETE
│   └── worker/
│       ├── package.json
│       ├── wrangler.jsonc
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                     # Fetch handler: routes /mcp, /workflow
│           ├── workflow.ts                  # ReceiptProcessingWorkflow class
│           ├── mcp/
│           │   └── server.ts               # MCP tools + resources definition
│           └── ai/
│               ├── ocr.ts                  # Vision model call
│               └── extract.ts              # Structured extraction + normalization
├── migrations/
│   └── 0001_initial.sql                    # All tables
└── .gitignore
```

---

## Database Schema

```sql
-- migrations/0001_initial.sql

-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions (web app cookie auth)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API tokens (MCP bearer auth)
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Categories
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

-- Receipts
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK(status IN ('uploaded','processing','needs_review','finalized','failed')),
  error_message TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parsed receipts (one per parse attempt, latest wins)
CREATE TABLE parsed_receipts (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
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

-- Expenses
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id TEXT REFERENCES receipts(id),
  merchant TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  expense_date TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_receipts_user_status ON receipts(user_id, status);
CREATE INDEX idx_receipts_updated ON receipts(updated_at);
CREATE INDEX idx_parsed_receipts_receipt ON parsed_receipts(receipt_id);
CREATE INDEX idx_expenses_user_date ON expenses(user_id, expense_date);
CREATE INDEX idx_expenses_receipt ON expenses(receipt_id);
CREATE INDEX idx_categories_user ON categories(user_id);
```

### Notes on schema
- All monetary values stored as integers (cents) to avoid floating point issues
- Dates stored as ISO 8601 text strings (D1/SQLite convention)
- IDs are UUIDs generated via `crypto.randomUUID()`
- `parsed_receipts` allows multiple rows per receipt (one per parse attempt); latest by `created_at` wins
- `api_tokens.token_hash` stores SHA-256 hash of the raw token; raw token is shown to user once at creation

---

## Receipt Lifecycle

### States
- `uploaded` -- file stored in R2, record created in D1
- `processing` -- workflow is running
- `needs_review` -- AI parsing complete, awaiting human review
- `finalized` -- user confirmed, expense record created
- `failed` -- terminal failure during processing

### Transitions
```
uploaded -> processing      (workflow start)
processing -> needs_review  (successful parse)
processing -> failed        (terminal failure)
needs_review -> processing  (reprocess triggered -- new workflow instance)
needs_review -> finalized   (user/agent confirms)
failed -> processing        (reprocess triggered -- new workflow instance)
```

### Rules
- No automatic transitions to `finalized` -- always requires human/agent confirmation
- Reprocessing creates a fresh workflow instance (old parsed data replaced)
- Original receipt file in R2 is never deleted regardless of status

---

## Domain Services (packages/domain)

Pure functions that accept D1 database binding and return results. No framework coupling.

### auth.ts
```
hashPassword(password: string) -> Promise<string>
verifyPassword(password: string, hash: string) -> Promise<boolean>
createUser(db: D1Database, email: string, password: string) -> Promise<User>
getUserByEmail(db: D1Database, email: string) -> Promise<User | null>
createSession(db: D1Database, userId: string) -> Promise<{ sessionId: string; expiresAt: string }>
validateSession(db: D1Database, sessionId: string) -> Promise<{ user: User } | null>
deleteSession(db: D1Database, sessionId: string) -> Promise<void>
createApiToken(db: D1Database, userId: string, name: string) -> Promise<{ token: string; tokenId: string }>
validateApiToken(db: D1Database, rawToken: string) -> Promise<{ user: User } | null>
```

### receipt.ts
```
createReceipt(db, { userId, fileKey, fileName, fileSize, fileType }) -> Promise<Receipt>
getReceipt(db, receiptId, userId?) -> Promise<Receipt | null>
listReceipts(db, userId, { status?, limit?, offset? }) -> Promise<Receipt[]>
updateReceiptStatus(db, receiptId, status, errorMessage?) -> Promise<void>
updateReceiptWorkflowId(db, receiptId, workflowId) -> Promise<void>
countReceiptsByStatus(db, userId) -> Promise<Record<string, number>>
```

### parse.ts
```
createParsedReceipt(db, { receiptId, ocrText, merchant, totalAmount, ... }) -> Promise<ParsedReceipt>
getLatestParsedReceipt(db, receiptId) -> Promise<ParsedReceipt | null>
updateParsedReceiptFields(db, parsedReceiptId, fields) -> Promise<ParsedReceipt>
```

### expense.ts
```
createExpenseFromReceipt(db, { receiptId, userId, merchant, amount, currency, date, categoryId? }) -> Promise<Expense>
createManualExpense(db, { userId, merchant, amount, currency, date, categoryId?, notes? }) -> Promise<Expense>
listExpenses(db, userId, { startDate?, endDate?, categoryId?, limit?, offset? }) -> Promise<Expense[]>
getExpense(db, expenseId, userId) -> Promise<Expense | null>
updateExpense(db, expenseId, userId, fields) -> Promise<Expense>
getExpenseSummary(db, userId, { startDate?, endDate? }) -> Promise<{ total: number; count: number; byCategory: ... }>
```

### category.ts
```
createCategory(db, userId, name) -> Promise<Category>
listCategories(db, userId) -> Promise<Category[]>
updateCategory(db, categoryId, userId, name) -> Promise<Category>
deleteCategory(db, categoryId, userId) -> Promise<void>
```

---

## Workflow Design

### ReceiptProcessingWorkflow

Each receipt triggers one workflow instance. Reprocessing creates a new instance.

```
run(event: { receiptId: string, userId: string })
  |
  +-- step.do("mark-processing")
  |     Update receipt status -> 'processing'
  |
  +-- step.do("load-file")
  |     Fetch file from R2 using receipt.file_key
  |     Convert to base64 for AI input
  |
  +-- step.do("ocr", { retries: 3, backoff: exponential, timeout: 2min })
  |     Call @cf/meta/llama-3.2-11b-vision-instruct with image
  |     Extract raw text
  |
  +-- step.do("extract", { retries: 3, backoff: exponential, timeout: 2min })
  |     Call @cf/meta/llama-3.1-8b-instruct with OCR text + JSON extraction prompt
  |     Parse structured fields
  |
  +-- step.do("normalize")
  |     Convert amounts to cents (integers)
  |     Normalize date to YYYY-MM-DD
  |     Clean merchant name (trim, title case)
  |     Default currency to USD if missing
  |
  +-- step.do("persist-results")
  |     INSERT into parsed_receipts
  |
  +-- step.do("mark-needs-review")
        Update receipt status -> 'needs_review'

On error (catch block):
  +-- step.do("mark-failed")
        Update receipt status -> 'failed' with error message
```

---

## AI Parsing Details

### Stage 1: OCR (Vision Model)
- Model: `@cf/meta/llama-3.2-11b-vision-instruct`
- Input: base64 image
- Prompt: "Extract all text from this receipt image. Include every line of text exactly as it appears."
- Output: raw text string

### Stage 2: Structured Extraction (Text Model)
- Model: `@cf/meta/llama-3.1-8b-instruct`
- Input: OCR text
- Prompt: JSON extraction prompt requesting: merchant, total, subtotal, tax, tip, currency, date, category guess, confidence (0-1)
- Output: JSON object

### Normalization Rules
- Monetary values: parse as float, multiply by 100, round to integer (cents)
- Date: parse various formats, normalize to YYYY-MM-DD
- Merchant: trim whitespace, title case
- Currency: default to "USD" if missing or unrecognized
- Confidence: clamp to 0.0-1.0

---

## Upload Flow

1. Client sends multipart form data to `POST /api/receipts`
2. Server validates: file type (JPEG/PNG/WEBP), file size (max 10MB)
3. Generate receipt ID (`crypto.randomUUID()`)
4. Store file in R2 at key `receipts/{receiptId}/{originalFilename}`
5. Insert receipt row in D1 with status `uploaded`
6. Trigger workflow via Service Binding to worker
7. Update receipt with workflow instance ID
8. Return receipt record to client

**Rules:**
- Upload must complete (R2 + D1) before workflow is triggered
- Receipt record exists even if workflow trigger fails
- File persists in R2 regardless of any subsequent failure

---

## Review & Finalization Flow

### Review Page
- Display receipt image (served from R2 via API route)
- Display parsed fields (merchant, amounts, date, currency, category)
- Show confidence score with visual indicator
- Show raw OCR text in collapsible section
- Editable fields for all parsed values
- Category dropdown (from user's categories)
- Actions: Save Edits, Reprocess, Finalize, Mark Failed

### Finalization Requirements
- merchant (required, non-empty)
- amount (required, > 0)
- currency (required)
- expense_date (required, valid date)
- category_id (optional)

### Finalization Steps
1. Validate required fields
2. Create expense record in D1
3. Update receipt status to `finalized`
4. Return expense record

---

## Web App Routes

| Route | Type | Description |
|---|---|---|
| `/` | Dashboard | Summary stats, recent expenses, receipts needing review |
| `/login` | Auth | Email/password login form |
| `/register` | Auth | Registration form |
| `/receipts` | List | All receipts with status filter |
| `/receipts/upload` | Upload | Drag-and-drop file upload |
| `/receipts/[id]` | Review | Receipt image + parsed data + edit/finalize |
| `/expenses` | List | All expenses with date/category filters |
| `/categories` | Manage | CRUD categories |

## API Routes

| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Create user account |
| POST | `/api/auth/login` | Login, set session cookie |
| POST | `/api/auth/logout` | Delete session |
| GET | `/api/receipts` | List receipts (query: status, limit, offset) |
| POST | `/api/receipts` | Upload receipt (multipart) |
| GET | `/api/receipts/[id]` | Get receipt detail + latest parsed data |
| PATCH | `/api/receipts/[id]` | Update parsed fields |
| GET | `/api/receipts/[id]/image` | Serve receipt image from R2 |
| POST | `/api/receipts/[id]/reprocess` | Trigger fresh workflow |
| POST | `/api/receipts/[id]/finalize` | Finalize + create expense |
| GET | `/api/expenses` | List expenses (query: startDate, endDate, categoryId) |
| POST | `/api/expenses` | Create manual expense |
| PATCH | `/api/expenses/[id]` | Update expense |
| GET | `/api/categories` | List categories |
| POST | `/api/categories` | Create category |
| PATCH | `/api/categories/[id]` | Update category |
| DELETE | `/api/categories/[id]` | Delete category |

---

## MCP Server

### Transport
Streamable HTTP via `createMcpHandler` from `agents` package (stateless, no Durable Objects).

### Auth
Bearer token in Authorization header. Token validated against `api_tokens` table in D1 (SHA-256 hash comparison). Users create tokens via the web UI.

### Tools

| Tool | Description | Parameters |
|---|---|---|
| `list_receipts` | List user's receipts | `status?`, `limit?`, `offset?` |
| `get_receipt` | Get receipt detail + parsed data | `receiptId` |
| `reprocess_receipt` | Trigger fresh workflow | `receiptId` |
| `update_receipt_fields` | Edit parsed fields | `receiptId`, field updates |
| `finalize_receipt` | Create expense from receipt | `receiptId`, confirmed fields |
| `list_expenses` | List expenses with filters | `startDate?`, `endDate?`, `categoryId?` |
| `create_expense` | Create manual expense | `merchant`, `amount`, `currency`, `date` |
| `update_expense` | Update expense fields | `expenseId`, field updates |
| `list_categories` | List categories | (none) |
| `create_category` | Create category | `name` |

### Resources

| Resource | URI | Description |
|---|---|---|
| Receipt detail | `receipt://{id}` | Receipt record + parsed data |
| Receipt text | `receipt://{id}/text` | Raw OCR text |
| Expense detail | `expense://{id}` | Expense record |
| Dashboard summary | `summary://dashboard` | Spending summary stats |

---

## Wrangler Configurations

### apps/web/wrangler.jsonc
```jsonc
{
  "name": "quickspense-web",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2025-04-21",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist"
  },
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "quickspense-db",
      "database_id": "<DB_ID>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "quickspense-receipts"
    }
  ],
  "services": [
    {
      "binding": "WORKER",
      "service": "quickspense-worker"
    }
  ]
}
```

### apps/worker/wrangler.jsonc
```jsonc
{
  "name": "quickspense-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "quickspense-db",
      "database_id": "<DB_ID>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "quickspense-receipts"
    }
  ],
  "ai": {
    "binding": "AI"
  },
  "workflows": [
    {
      "name": "receipt-processing",
      "binding": "RECEIPT_WORKFLOW",
      "class_name": "ReceiptProcessingWorkflow"
    }
  ]
}
```

---

## Build Phases

### Phase 1: Project Scaffolding
- Initialize pnpm workspace
- Scaffold Astro 5 app with Cloudflare adapter, React, Tailwind
- Create Worker app
- Create domain package
- Base TypeScript configs
- Wrangler configs with all bindings
- Create D1 database and R2 bucket via wrangler CLI
- D1 migration file
- .gitignore, git init

### Phase 2: Domain Types & Schemas
- TypeScript types for all entities (User, Session, Receipt, ParsedReceipt, Expense, Category)
- Zod validation schemas
- Domain error classes
- Export public API from index.ts

### Phase 3: Auth Service
- Password hashing (PBKDF2 via crypto.subtle)
- User CRUD
- Session create/validate/delete
- API token create/validate

### Phase 4: Auth UI + Middleware
- Astro middleware: parse session cookie, attach user to locals
- Login page + API route
- Register page + API route
- Logout API route
- Protected route redirects
- Layout with nav showing auth state

### Phase 5: Receipt Upload
- Receipt service (create, get, list, update status)
- Upload API route: validate, store R2, insert D1, trigger workflow
- Upload page with React island (drag-and-drop, file preview, progress)
- Receipts list page with status filter tabs

### Phase 6: Workflow + AI Parsing
- OCR module (Workers AI vision model call)
- Structured extraction module (Workers AI text model + JSON prompt)
- Normalization logic
- Parse service (create, get latest, update fields)
- ReceiptProcessingWorkflow class with all steps
- Worker fetch handler routing for workflow trigger endpoint

### Phase 7: Review UI
- Receipt review page (React island)
- Serve receipt image from R2 via API route
- Display parsed fields with edit capability
- Confidence score indicator
- Collapsible OCR text view
- Save edits action
- Reprocess action (triggers new workflow via service binding)

### Phase 8: Finalization
- Finalize API route: validate fields, create expense, update receipt status
- Finalize button on review page
- Mark failed action

### Phase 9: Expenses & Categories
- Category service + API routes + management page (React island)
- Expense service + API routes
- Expense list page with date/category filters
- Manual expense creation form

### Phase 10: Dashboard
- Expense summary service (totals, counts, by-category)
- Dashboard page with summary cards
- Recent expenses list
- Receipts needing review count/list

### Phase 11: MCP Server
- MCP server with all tools (using domain services)
- MCP resources
- Bearer token auth middleware
- API token management UI (create/revoke tokens)
- Test with MCP Inspector

### Phase 12: Polish & Deploy
- Error handling across all routes
- Loading states in React islands
- Empty states for lists
- Deploy both workers
- Apply D1 migrations to remote
- End-to-end test

---

## Non-Functional Requirements

- Upload must succeed before processing begins
- Workflow must be idempotent per receipt
- Parsing must be retryable
- System must tolerate partial failures
- Original receipt must never be lost due to processing errors
- System supports multi-user (auth on all routes)

## Out of Scope

- Bank integrations
- Budgeting features
- Multi-user organizations
- Realtime updates (polling for status instead)
- Advanced analytics
- Perfect OCR accuracy
- PDF support (images only for MVP)
