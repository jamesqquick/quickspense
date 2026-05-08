# Quickspense

AI-powered receipt scanning and expense tracking, built entirely on Cloudflare's Developer Platform.

Create expenses manually or by uploading a receipt photo. The AI extracts the merchant, amount, date, and category in seconds; you review and finalize. No external APIs, no third-party infrastructure -- everything runs on Cloudflare.

## How It Works

Two ways to add an expense:

- **Manual** -- enter the details yourself; optionally attach a receipt image for your records.
- **From a receipt image** -- upload a photo (JPEG, PNG, or WEBP). AI parses it into a `needs_review` expense, you confirm the fields, and it becomes `active`.

A single `expenses` concept covers both flows. Status lifecycle: `processing` → `needs_review` → `active` for image uploads, or straight to `active` for manual entries. `failed` if AI parsing errors -- you can reprocess or fill it in by hand.

## Features

- **AI Receipt Processing** -- Two-stage pipeline: vision model reads the receipt, language model extracts structured data
- **Human-in-the-Loop Review** -- Edit any field, see confidence scores, reprocess if needed
- **Expense Tracking** -- Organize with custom categories, filter by date/category, dashboard with spending breakdowns
- **CSV Export** -- Export expenses with any combination of filters
- **MCP Server** -- Full Model Context Protocol server for managing expenses via AI assistants like Claude Desktop
- **API Token Management** -- Create bearer tokens for MCP client authentication

## Built on Cloudflare

Every layer of Quickspense runs on Cloudflare's Developer Platform:

| Product | Usage |
|---|---|
| **[Workers](https://developers.cloudflare.com/workers/)** | Two Workers deployed independently -- the Astro SSR web app and the background processing worker |
| **[D1](https://developers.cloudflare.com/d1/)** | Serverless SQL database storing users, sessions, expenses (with optional receipt image metadata), parsed AI results, categories, and API tokens |
| **[R2](https://developers.cloudflare.com/r2/)** | Object storage for receipt images with zero egress fees |
| **[Workers AI](https://developers.cloudflare.com/workers-ai/)** | On-device AI models for OCR (`@cf/google/gemma-3-12b-it`) and data extraction (`@cf/meta/llama-3.1-8b-instruct`) |
| **[Workflows](https://developers.cloudflare.com/workflows/)** | Durable, retryable multi-step receipt processing with automatic recovery |
| **[Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)** | Password reset and transactional emails handled at the edge |
| **[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)** | Web Worker triggers processing Workflows via service binding to the background Worker |

## Tech Stack

| Layer | Technology |
|---|---|
| Web Framework | [Astro 5](https://astro.build/) with SSR via `@astrojs/cloudflare` |
| UI Islands | [React 19](https://react.dev/) for interactive components |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| Validation | [Zod v4](https://zod.dev/) |
| MCP | [Model Context Protocol SDK](https://modelcontextprotocol.io/) + [Agents SDK](https://developers.cloudflare.com/agents/) |
| Monorepo | pnpm workspaces |
| Testing | Vitest with `@cloudflare/vitest-pool-workers` |

## Project Structure

```
quickspense/
├── apps/
│   ├── web/            # Astro SSR web app (Workers)
│   └── worker/         # Background processing worker (Workflows + MCP)
├── packages/
│   └── domain/         # Shared business logic, types, validation
├── migrations/         # D1 SQL migrations
├── package.json
└── pnpm-workspace.yaml
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

### Install

```bash
pnpm install
```

### Set Up Local Database

```bash
pnpm db:migrate:local
```

### Development

Run both the web app and worker in development mode:

```bash
# Terminal 1 - Web app
pnpm dev:web

# Terminal 2 - Worker
pnpm dev:worker
```

The web app runs at `http://localhost:4321`.

### Build

```bash
pnpm build
```

### Deploy

```bash
# Deploy both workers
pnpm deploy:web
pnpm deploy:worker

# Run migrations on production
pnpm db:migrate:remote
```

## Testing Invoicing Locally

The invoicing feature uses Stripe Checkout. To test it on `localhost:4321`:

1. **Get a Stripe Sandbox restricted key** with `Checkout Sessions: Write`
   permission. Copy it (`rk_test_...`).
2. **Set local secrets** in `apps/web/.dev.vars` (gitignored):
   ```
   STRIPE_SECRET_KEY=rk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...    # filled in step 4
   ```
3. **Authenticate the Stripe CLI** (one time):
   ```bash
   stripe login
   ```
4. **Forward webhooks** in a dedicated terminal:
   ```bash
   stripe listen --forward-to localhost:4321/api/webhooks/stripe
   ```
   Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET` in `.dev.vars`.
   Keep this terminal running.
5. **Verify local D1 has invoice tables**:
   ```bash
   pnpm --filter @quickspense/web exec wrangler d1 execute quickspense-db \
     --local --persist-to=../../.wrangler \
     --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%invoice%'"
   ```
6. **Start dev** (another terminal): `pnpm dev:web`
7. **End-to-end test**:
   - Log in → **Invoices → New Invoice**
   - Use your real email as the client email (`remote: true` binding sends real mail)
   - Add a line item, click **Save & send**
   - Click the pay link in the email → click Pay → use card `4242 4242 4242 4242`,
     any future expiry (`12/34`), any CVC (`123`), any ZIP
   - Watch the `stripe listen` terminal for `checkout.session.completed` → `200`
   - Refresh `/invoices/{id}` — status flips to **Paid**

**Email under `astro dev`:** the Cloudflare `send_email` binding is NOT
proxied by `getPlatformProxy`, so `env.EMAIL` is `undefined` in local dev.
The send endpoint detects this and returns the pay URL inline instead of
emailing — the invoice detail page surfaces the URL with a copy button.
Click it, paste in a new tab, and continue with Stripe Checkout. To
exercise the real email path locally, build and run via `wrangler dev`
against the built worker output instead of `astro dev`.

**Troubleshooting:**

- `Stripe is not configured` — restart `pnpm dev:web` after editing `.dev.vars`
- Signature verification failure — re-copy the `whsec_...` from `stripe listen`
- `permission_error` from Stripe — restricted key missing `Checkout Sessions: Write`
- Pay button rejects with "not been sent yet" — click **Send** on the draft first

## MCP Integration

Quickspense includes a full MCP server that exposes tools and resources for AI assistants. To connect Claude Desktop or any MCP client:

1. Go to **Settings** in the web app
2. Create an API token
3. Configure your MCP client with the worker URL and bearer token

The MCP server provides expense and category management tools (`list_expenses`, `get_expense`, `create_expense`, `update_expense`, `update_expense_parsed_fields`, `finalize_expense`, `reprocess_expense`, `list_categories`, `create_category`) and 3 resources (expense detail, expense OCR text, dashboard summary).

## License

MIT
