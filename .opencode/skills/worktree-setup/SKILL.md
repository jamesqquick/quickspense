---
name: worktree-setup
description: Use immediately after creating a new git worktree in the Quickspense repo. Copies local Cloudflare state from `.wrangler-shared/` and the `apps/web/.dev.vars` secrets file from the main checkout into the worktree so the local D1 has data and the app has its environment secrets, then runs pending migrations. Triggers on "worktree setup", "wrangler state", "local db missing", "missing dev.vars in worktree", or any post-worktree-creation step in Quickspense. Complements the global using-git-worktrees skill, which handles generic worktree creation and dependency install.
---

# Worktree Setup (Quickspense)

## Overview

When a new git worktree is created for the Quickspense repo, it starts with no
local Cloudflare state and no environment secrets, because both
`.wrangler-shared/` and `apps/web/.dev.vars` are gitignored and therefore do
not propagate across worktrees.

This skill restores those files by copying them from the main checkout, then
applies any database migrations the new branch may have added on top.

**Announce at start:** "I'm using the worktree-setup skill to copy local state
from the main checkout."

## When to use

Run this **immediately after** the global `using-git-worktrees` skill finishes
its generic setup (worktree creation, `pnpm install`, baseline checks) and
**before** trying to start the dev server, run migrations on a fresh DB, or
verify anything that depends on local data.

Do not run this in the main checkout. It is a no-op there.

## Why

Quickspense is a pnpm monorepo with two Workers (`apps/web`, `apps/worker`)
that share a single local Cloudflare state directory at the repo root:

- `.wrangler-shared/` — shared Miniflare emulation state used by both workers
  via `wrangler dev --persist-to=../../.wrangler-shared`. Holds the local D1
  SQLite database, KV, R2, and Workflows state. Without it, the worktree has
  no local data and migrations apply against an empty DB.
- `apps/web/.dev.vars` — local development secrets for the web Worker
  (Stripe keys, webhook secrets, auth secrets, etc.). Without it, `astro dev`
  / `wrangler dev` will fail or behave unpredictably (e.g. "Stripe is not
  configured", `Bearer undefined` errors).

Both are correctly gitignored, so they never travel via git. They must be
copied between worktrees manually on the same machine.

`apps/web/.wrangler/` and `apps/worker/.wrangler/` are per-app build/cache
directories that wrangler regenerates on demand — do **not** copy these. Only
`.wrangler-shared/` at the repo root holds persistent local data.

## Steps

Run all commands from inside the **new worktree** (not the main checkout):

```bash
# 1. Locate the main checkout. `git worktree list --porcelain` always lists
#    the main worktree first.
main=$(git worktree list --porcelain | head -1 | awk '{print $2}')

# 2. Copy the shared local Cloudflare state if the worktree doesn't have any.
[ ! -d .wrangler-shared ] && [ -d "$main/.wrangler-shared" ] \
  && cp -R "$main/.wrangler-shared" .wrangler-shared

# 3. Copy local development secrets for the web app if missing.
[ ! -f apps/web/.dev.vars ] && [ -f "$main/apps/web/.dev.vars" ] \
  && cp "$main/apps/web/.dev.vars" apps/web/.dev.vars

# 4. (If the worker has its own .dev.vars in your main checkout, copy it too.)
[ ! -f apps/worker/.dev.vars ] && [ -f "$main/apps/worker/.dev.vars" ] \
  && cp "$main/apps/worker/.dev.vars" apps/worker/.dev.vars

# 5. Apply any migrations this branch adds on top of the copied DB.
pnpm db:migrate:local
```

`pnpm db:migrate:local` is defined in the root `package.json` and runs:

```
pnpm --filter @quickspense/web exec wrangler d1 migrations apply quickspense-db \
  --local --persist-to=../../.wrangler-shared
```

After these steps, the worktree should behave like a fresh clone of your main
local environment, plus whatever schema changes the branch introduces.

## Quick Reference

| Situation | Action |
|---|---|
| `.wrangler-shared` already exists in worktree | Skip the copy; assume it was intentional |
| `apps/web/.dev.vars` already exists in worktree | Skip the copy; assume it was intentional |
| Main checkout has no `.wrangler-shared` | Warn the user. Run migrations against the fresh DB. They will have an empty local DB. |
| Main checkout has no `apps/web/.dev.vars` | Warn the user — they'll need to create one manually before running the app. |
| Running from the main checkout itself | No-op. Skill is only for worktrees. |
| Branch has migrations newer than main's local DB | `pnpm db:migrate:local` (step 5) handles it |
| Branch is missing migrations that main's local DB already applied | The copied DB is a superset; nothing to do |

## Security

- `apps/web/.dev.vars` contains secrets (Stripe restricted keys, webhook
  secrets, etc.). Copying it locally between worktrees on the **same
  machine** is fine — those secrets are already on disk.
- Never commit `.dev.vars`. It is in `.gitignore` for a reason.
- Never copy `.dev.vars` across machines without re-reviewing contents and
  rotating anything that should not leave the original host.

## Integration

**Pairs with:**
- **using-git-worktrees** (global) — that skill creates the worktree and runs
  generic setup like `pnpm install`. This skill runs immediately after, layering
  Quickspense-specific local state on top.

**Does not replace:**
- The global worktree skill. PR creation, branch naming, and `.gitignore`
  verification still come from there.

## Example Workflow

```
[using-git-worktrees creates .worktrees/feature-x and runs pnpm install]

You: I'm using the worktree-setup skill to copy local state from the main checkout.

[Detect main checkout via `git worktree list --porcelain`]
[Copy .wrangler-shared/ - <size>]
[Copy apps/web/.dev.vars]
[Run pnpm db:migrate:local - migrations applied]

Worktree at .worktrees/feature-x is ready with copied local state.
```

## Red Flags

**Never:**
- Run this skill in the main checkout (use `git rev-parse --git-common-dir`
  vs `--git-dir` to detect; if equal, you are in main).
- Overwrite an existing `.dev.vars` or `.wrangler-shared` without asking. The
  user may have intentionally diverged the worktree's local state.
- Copy `.dev.vars` to a worktree that lives on a different machine.
- Copy `apps/web/.wrangler/` or `apps/worker/.wrangler/` — those are
  regenerable build artifacts, not persistent state.

**Always:**
- Verify you are inside a worktree before copying.
- Skip steps whose source files are missing rather than failing the whole flow.
- Run `pnpm db:migrate:local` after copying so the worktree's branch-specific
  migrations are applied.
