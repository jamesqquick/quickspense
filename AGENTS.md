# Quickspense — Agent Guide

Quickspense is a pnpm monorepo built on Cloudflare's Developer Platform.

## Repo layout

```
apps/
  web/            Astro 5 SSR web app (Worker)
  worker/         Background Worker — Workflows + MCP server
packages/
  domain/         Shared business logic, Drizzle schema, Zod schemas, types
                  (imported as `@quickspense/domain`)
migrations/       D1 SQL migrations (shared by both Workers)
```

Local Cloudflare state for both Workers lives in a single shared directory
at the repo root: `.wrangler-shared/`. It is gitignored and must be copied
between worktrees on the same machine when starting fresh work.

## Skills

Repo-specific skills live under `.opencode/skills/`. Use them when the
task matches:

- **`worktree-setup`** — Run immediately after creating a new git
  worktree. Copies `.wrangler-shared/` and `apps/web/.dev.vars` from the
  main checkout, then runs migrations.
- **`implement-gh-issue`** — End-to-end workflow: GitHub issue → fresh
  worktree → implement → `pnpm build` → push → PR with `Closes #<n>` →
  tailored manual test plan.
- **`astro-best-practices`** — Conventions for `apps/web` (Astro pages,
  Astro Actions for mutations, API routes for webhooks/streaming, React
  components), `packages/domain` (Zod schemas, types, Drizzle, services),
  and `apps/worker` (Workflows + MCP).
- **`cleanup-merged-worktree`** — After a PR is merged on GitHub, removes
  the worktree, deletes the local branch, fast-forwards `main`, and prunes
  stale remote refs.

Stripe-specific skills (`stripe-best-practices`, `stripe-projects`,
`upgrade-stripe`) also live under `.opencode/skills/`.

## Project rules

- **TypeScript** with named exports. Avoid default exports for components,
  helpers, and types.
- **Comments** only when the code isn't self-explanatory.
- **Cross-cutting types, Zod schemas, and Drizzle schema** live in
  `packages/domain` and are imported as `@quickspense/domain`. Don't
  duplicate them in `apps/`.
- **Database** — instantiate per-request with
  `createDb(locals.runtime.env.DB)` (web) or `createDb(env.DB)` (worker).
  Never import a singleton.
- **IDs** — use `crypto.randomUUID()`.

## Git rules

- Never commit `.dev.vars` (any of them: root, `apps/web/`, `apps/worker/`).
  They are gitignored, but be alert if you ever stage broadly.
- Never commit anything inside `tmp/`. If you need a `tmp/` directory, add
  it to `.gitignore` first and never `git add` files inside it.
- Don't push to remote without asking first.
- Don't force-push, amend pushed commits, or skip git hooks without
  explicit permission.

## Common commands

| What | Command |
|---|---|
| Install deps | `pnpm install` |
| Apply local DB migrations | `pnpm db:migrate:local` |
| Apply remote DB migrations | `pnpm db:migrate:remote` |
| Generate a new migration | `pnpm db:generate` |
| Web dev server | `pnpm dev:web` (http://localhost:4321) |
| Worker dev server | `pnpm dev:worker` |
| Full build (typecheck + build all workspaces) | `pnpm build` |
| Build only domain | `pnpm build:domain` |
| Run domain tests | `pnpm test` |
| Deploy web Worker | `pnpm deploy:web` |
| Deploy background Worker | `pnpm deploy:worker` |

`pnpm build` runs the workspaces in dependency order
(`domain → web → worker`), so a single command covers typecheck + build for
the whole repo. Always run it before pushing.

## Stripe / invoicing local dev

See the README's "Testing Invoicing Locally" section. Short version:

1. Set `STRIPE_SECRET_KEY` (restricted key with `Checkout Sessions: Write`)
   and `STRIPE_WEBHOOK_SECRET` in `apps/web/.dev.vars`.
2. Run `stripe listen --forward-to localhost:4321/api/webhooks/stripe` in
   a dedicated terminal; copy the printed `whsec_...` into
   `STRIPE_WEBHOOK_SECRET`.
3. `pnpm dev:web` and exercise the flow.
