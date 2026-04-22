# Quickspense

AI-powered receipt scanning and expense tracking, built entirely on Cloudflare's Developer Platform.

Upload a receipt photo, and AI extracts the merchant, amount, date, and category in seconds. Review the results, make edits, and finalize to create expense records. No external APIs, no third-party infrastructure -- everything runs on Cloudflare.

## How It Works

1. **Upload** a receipt image (JPEG, PNG, or WEBP)
2. **AI extracts** merchant, amounts, date, and category using a two-stage pipeline
3. **Review & finalize** the parsed data to create an expense record

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
| **[D1](https://developers.cloudflare.com/d1/)** | Serverless SQL database storing users, sessions, receipts, expenses, categories, and API tokens |
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

## MCP Integration

Quickspense includes a full MCP server that exposes tools and resources for AI assistants. To connect Claude Desktop or any MCP client:

1. Go to **Settings** in the web app
2. Create an API token
3. Configure your MCP client with the worker URL and bearer token

The MCP server provides 10 tools (create expenses, upload receipts, manage categories, etc.) and 4 resources (expense lists, receipt data, category lists, dashboard summary).

## License

MIT
