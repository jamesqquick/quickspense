---
name: worktree-setup
description: Use immediately after creating a new git worktree in the Quickspense repo. Copies the local Cloudflare state from `.wrangler/` and the `apps/web/.dev.vars` secrets file from the main checkout into the worktree so the local D1 has data and the app has its environment secrets, then runs pending migrations. Triggers on "worktree setup", "wrangler state", "local db missing", "missing dev.vars in worktree", or any post-worktree-creation step in Quickspense. Complements the global using-git-worktrees skill, which handles generic worktree creation and dependency install.
---

# Worktree Setup (Quickspense)

## Overview

When a new git worktree is created for the Quickspense repo, it starts with no
local Cloudflare state and no environment secrets, because both `.wrangler/`
and `apps/web/.dev.vars` are gitignored and therefore do not propagate across
worktrees.

This skill restores those files by making a **full copy** (`cp -R`, never a
symlink) from the main checkout into the new worktree, then applies any
database migrations the new branch may have added on top.

Each worktree ends up with its own self-contained `.wrangler/` directory —
nothing is shared at runtime between worktrees. That isolation is the whole
point: parallel work on multiple branches must not corrupt each other's
local D1 schema, KV entries, or R2 objects.

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

- `.wrangler/` — local Miniflare state used by both Workers. The worker's
  `wrangler dev` script passes `--persist-to=../../.wrangler` and the web
  app's `astro.config.mjs` points `platformProxy.persist.path` at
  `../../.wrangler/v3`, so both processes read and write the same root-level
  `.wrangler/` regardless of which app you start. Holds the local D1 SQLite
  DB, KV, R2, and Workflows state. Without it, the worktree has no local
  data and migrations apply against an empty DB.
- `apps/web/.dev.vars` — local development secrets for the web Worker
  (Stripe keys, webhook secrets, auth secrets, etc.). Without it, `astro dev`
  / `wrangler dev` will fail or behave unpredictably (e.g. "Stripe is not
  configured", `Bearer undefined` errors).

Both are correctly gitignored, so they never travel via git. They must be
copied between worktrees manually on the same machine.

`apps/web/.wrangler/` and `apps/worker/.wrangler/` may be created by tooling
as per-app cache directories. They are **not** the persistent state
directories and do **not** need to be copied — they regenerate on demand. The
only state worth copying is the **root** `.wrangler/`.

### Why a full copy, not a symlink

Symlinking the root `.wrangler/` from one worktree to another would make
multiple worktrees share the same Miniflare state. That defeats the purpose
of worktrees: a migration run on `feat/x` would mutate the local D1 schema
seen by `feat/y`, and writes from one branch would surface in the other.
Always use `cp -R`.

## Steps

Run all commands from inside the **new worktree** (not the main checkout):

```bash
# 1. Locate the main checkout. `git worktree list --porcelain` always lists
#    the main worktree first.
main=$(git worktree list --porcelain | head -1 | awk '{print $2}')

# 2. Full copy the local Cloudflare state if the worktree doesn't have any.
#    cp -R, never ln -s — each worktree must own its state.
[ ! -d .wrangler ] && [ -d "$main/.wrangler" ] \
  && cp -R "$main/.wrangler" .wrangler

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
  --local --persist-to=../../.wrangler
```

After these steps, the worktree should behave like a fresh clone of your main
local environment, plus whatever schema changes the branch introduces.

## Quick Reference

| Situation | Action |
|---|---|
| `.wrangler` already exists in worktree | Skip the copy; assume it was intentional |
| `apps/web/.dev.vars` already exists in worktree | Skip the copy; assume it was intentional |
| Main checkout has no `.wrangler` | Warn the user. Run migrations against the fresh DB. They will have an empty local DB. |
| Main checkout has no `apps/web/.dev.vars` | Warn the user — they'll need to create one manually before running the app. |
| Source has legacy `.wrangler-shared/` instead of `.wrangler/` | Copy it as `.wrangler` (`cp -R "$main/.wrangler-shared" .wrangler`) so the new layout works. The user can delete the legacy dir from main once everything is verified. |
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
[Copy .wrangler/ - <size>, full copy via cp -R]
[Copy apps/web/.dev.vars]
[Run pnpm db:migrate:local - migrations applied]

Worktree at .worktrees/feature-x is ready with its own local state.
```

## Red Flags

**Never:**
- Symlink `.wrangler/` between worktrees. Always `cp -R`. Symlinks share
  state and break the isolation that worktrees exist to provide.
- Run this skill in the main checkout (use `git rev-parse --git-common-dir`
  vs `--git-dir` to detect; if equal, you are in main).
- Overwrite an existing `.dev.vars` or `.wrangler/` without asking. The
  user may have intentionally diverged the worktree's local state.
- Copy `.dev.vars` to a worktree that lives on a different machine.
- Copy `apps/web/.wrangler/` or `apps/worker/.wrangler/` — those are
  regenerable per-app cache artifacts, not the persistent state directory.

**Always:**
- Verify you are inside a worktree before copying.
- Use `cp -R`, never `ln -s` or `cp -l`.
- Skip steps whose source files are missing rather than failing the whole flow.
- Run `pnpm db:migrate:local` after copying so the worktree's branch-specific
  migrations are applied.
