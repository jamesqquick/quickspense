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
# Apply additive migrations before serving the updated app
pnpm db:migrate:remote

# Deploy both workers
pnpm deploy:web
pnpm deploy:worker
```

## Testing Invoicing Locally

Invoice payments use OAuth-connected Stripe accounts and direct charges. Each
payment belongs to the invoice sender's account. Quickspense adds no application
fee. Sending an invoice records its account, connection, charge scope, and
live/test mode; reconnecting never changes that invoice's destination.

### Stripe Connect configuration

Use a Stripe sandbox for development. Configure OAuth for connecting existing
Stripe accounts and register this redirect URI in the sandbox's Connect settings:

```text
http://localhost:4321/api/integrations/stripe/callback
```

The production redirect is `${APP_URL}/api/integrations/stripe/callback` and must
use HTTPS. HTTP redirects are allowed only for loopback addresses in test mode.
The client ID and secret key must belong to the same platform and environment.

Set these values in the gitignored `apps/web/.dev.vars`, then restart the dev
server. Configure production secrets through Wrangler's interactive secret
commands, never through committed source or command-line key values.

| Variable | Purpose |
|---|---|
| `APP_URL` | Trusted application origin, locally `http://localhost:4321` |
| `STRIPE_SECRET_KEY` | Platform sandbox key for OAuth, account retrieval, and connected Checkout |
| `STRIPE_CONNECT_CLIENT_ID` | OAuth application client ID from Connect settings |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret for the connected-account endpoint |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the original platform endpoint |

The live Connect client ID is configured in `apps/web/wrangler.jsonc`. For local
development, override it with the sandbox client ID in `apps/web/.dev.vars`.
The `.dev.vars.example` file includes the sandbox ID and localhost application
URL; local values override the production configuration.

A restricted key with only Checkout write access is insufficient. Verify OAuth
authorization/deauthorization, account retrieval and listing, and Checkout create/read/expire
requests in the intended account context. Use Stripe's current permission
documentation when restricting the key. Do not interpret a permission error as
proof that an account disconnected.

When a lifecycle webhook cannot retrieve an account, Quickspense checks all pages
of the platform's connected-account list before recording revocation. A failed
inventory request remains retryable. This also lets the sender reconnect the
same account to resolve outstanding invoices after external revocation.

Create two webhook destinations with distinct production signing secrets:

| Endpoint | Stripe event scope | Events |
|---|---|---|
| `/api/webhooks/stripe-connect` | Connected accounts | `account.updated`, `account.application.deauthorized`, and the Checkout events below |
| `/api/webhooks/stripe` | Your account | Checkout events for previously initiated platform payments |

Subscribe both payment destinations to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
and `checkout.session.expired`. Use an event API version compatible with the
installed SDK, currently `2026-04-22.dahlia`. Keep the platform destination during
the cutover even though Quickspense no longer creates platform-owned Checkout.

### Local payment test

1. Authenticate the Stripe CLI to the intended sandbox with `stripe login`.
2. Start listeners in separate terminals. If a printed signing secret differs
   from the corresponding local variable, update it and restart the app:
   ```bash
   stripe listen --all-snapshot --events-from @accounts --forward-connect-to localhost:4321/api/webhooks/stripe-connect
   stripe listen --all-snapshot --events-from @self --forward-to localhost:4321/api/webhooks/stripe
   ```
3. Apply pending local migrations and start the app:
   ```bash
   pnpm db:migrate:local
   pnpm dev:web
   ```
4. Sign in, open **Settings**, connect an existing Stripe account, and use
   **Refresh Stripe status**. Confirm **Ready for sandbox**, then create and send
   a draft. Sandbox readiness does not require enabled capability flags; Stripe
   determines payment eligibility. Live readiness requires submitted details,
   enabled charges, and enabled payouts.
5. Open the payment URL in an anonymous browser. Pay with `4242 4242 4242 4242`,
   any future expiry, CVC, and ZIP. Verify the signed Connect event returns 200 and
   the invoice becomes paid.
6. Inspect the payment in the connected account's Stripe Dashboard or retrieve
   its PaymentIntent and latest charge using that account's `Stripe-Account`
   context. Confirm the exact invoice total and currency, no application fee,
   and that the platform does not own the charge. A paid invoice screen alone
   does not establish account ownership.

Repeat with two Quickspense users connected to different accounts. Include
multiple line items plus tax, simultaneous Pay clicks, a lost creation
response, expired Checkout, and a delayed payment method. Processing or unknown
payments must not start another charge. Verify void expires open sessions, blocks
processing payments, and remains retryable after an ambiguous expiration.

Under `astro dev`, the email binding is unavailable. Sending returns the payment
URL inline on the invoice detail page. Local D1 state lives in this checkout's
root `.wrangler/`; use `--local --persist-to=../../.wrangler` for web-directory
Wrangler commands. Do not run sandbox tests against production bindings.

### Payment and authorization recovery

An attempt stores the exact Checkout request, account, and idempotency key.
Retries reuse them within a fixed 23-hour window. Stripe can discard keys after
24 hours, so an unresolved attempt remains blocked after that window. Never
delete the attempt, extend its deadline, or start a new generation to bypass it.
Use Stripe records to recover the original session and reconcile its status.
Payments on void invoices and different-session duplicate successes are recorded
as exceptions in `stripe_webhook_events` for operator reconciliation.

If OAuth succeeded but local persistence failed, use **Retry Stripe connection**
in Settings. If the token exchange response was lost and the account is unknown,
the operation stays blocked. A user's assertion that they revoked access is not
evidence. An operator must establish the account identity and authorization
outcome from Stripe request logs or Stripe support, match the pending operation
to the authenticated user and mode, and use the server-side recovery services.
Do not deauthorize an account claimed by another Quickspense user or clear an
unknown operation without verified evidence. There is no browser override.

### Historical platform invoices and release

The owner manually reissues historical unpaid invoices after connecting their
Stripe account. There is no automated reissuance or migration notification.
Before reissuing, inventory all earlier platform Checkout sessions, including
sessions overwritten in the old single-session invoice field:

1. Use the original platform's Stripe Dashboard, request logs, or paginated
   server-side Checkout inventory. Record actual session IDs, account context,
   live/test mode, invoice metadata, amount, currency, payment status, and
   PaymentIntent IDs. Keep pay tokens and request evidence out of shared logs.
2. Establish the session's original invoice binding, then compare its total and
   currency with the immutable invoice. Do not fabricate session IDs, guess mode
   from the current key, or treat pay-token metadata alone as sufficient proof.
3. Reconcile paid sessions before reissuing. Wait for processing sessions. Expire
   open unpaid sessions and retrieve them again to confirm expiration before
   voiding or reissuing. Handle duplicate payments through Stripe reconciliation.
4. The app automatically classifies only the exact session already stored on a
   historical invoice, after retrieving it from Stripe in the platform context.
   Its mode can be set once using `invoice_legacy_session_evidence`. Old signed
   payment events can then reconcile without changing an already-paid timestamp.
5. Missing or overwritten session bindings require operator/support review. The
   app has no historical discovery/import tool and will not rewrite established
   bindings. Preserve the records and resolve those cases before manual reissue.
   Resend affected events from Stripe after verified recovery. A retryable 503
   means reconciliation has not committed, not that the event can be discarded.

Apply migrations `0008` through `0015` before serving the updated web app and
deploy compatible domain/web/worker builds together. Both webhook endpoints must
remain reachable. Verify the migration history first: `0000_baseline.sql` is a
Drizzle snapshot overlapping the operational `0001` and `0002` migrations. The
tests exercise the operational `0001` through `0015` chain and populated upgrades;
do not blindly apply both baseline and initial migrations to a fresh database.

To roll back payment initiation, disable new checkout creation while retaining
the ledger, additive schema, and webhook reconciliation. Never restore the old
platform-owned Checkout path as a rollback strategy.

Run automated verification separately from the build:

```bash
pnpm test
pnpm check
pnpm build
```

`pnpm check` runs the web's Astro checks and the worker's TypeScript check. The
build includes the domain typecheck and bundling; it is not a substitute for the
full application checks. No lint command is configured.

Stripe references: [OAuth](https://docs.stripe.com/connect/oauth-standard-accounts),
[direct charges](https://docs.stripe.com/connect/direct-charges),
[Connect webhooks](https://docs.stripe.com/connect/webhooks), and
[idempotency](https://docs.stripe.com/api/idempotent_requests).

## MCP Integration

Quickspense includes a full MCP server that exposes tools and resources for AI assistants. To connect Claude Desktop or any MCP client:

1. Go to **Settings** in the web app
2. Create an API token
3. Configure your MCP client with the worker URL and bearer token

The MCP server provides expense and category management tools (`list_expenses`, `get_expense`, `create_expense`, `update_expense`, `update_expense_parsed_fields`, `finalize_expense`, `reprocess_expense`, `list_categories`, `create_category`) and 3 resources (expense detail, expense OCR text, dashboard summary).

## License

MIT
