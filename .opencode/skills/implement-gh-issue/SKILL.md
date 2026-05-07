---
name: implement-gh-issue
description: Implement a GitHub issue end-to-end in the Quickspense repo using a git worktree, then open a PR and produce an issue-specific manual test plan. Use this skill whenever the user asks to "implement issue #<n>", "work on issue <n>", "build issue <url>", pastes a github.com/jamesqquick/quickspense/issues/<n> URL with intent to implement, or says things like "let's knock out issue 42" / "do this issue and open a PR". Covers fetching the issue, picking a branch prefix from labels, creating the worktree, running worktree-setup, implementing the change, running build/typecheck verification, pushing, opening a PR with Closes #<n>, and writing a tailored local test plan the user can follow to verify the change.
---

# Implement a GitHub Issue (Quickspense)

## Overview

This skill takes the user from a GitHub issue number/URL all the way to a
ready-to-review PR plus a manual test plan tailored to the issue. It chains
together the worktree workflow, implementation, verification, PR creation,
and test-plan writing so the user gets one consistent flow every time.

**Announce at start:** "I'm using the implement-gh-issue skill to work issue
#<n> in a fresh worktree."

## When to use

- The user gives you an issue number, an issue URL, or a description that
  references an existing GitHub issue and asks you to implement it.
- The user pastes a `github.com/jamesqquick/quickspense/issues/<n>` link and
  the intent is implementation (not just discussion or triage).
- The user says "implement", "work on", "knock out", "build", "fix", or
  "do" + an issue reference.

Do **not** use this skill for:

- Pure discussion / clarification of an issue (no code changes intended).
- Quick edits the user wants on the current branch — this skill always
  branches off `origin/main` in a new worktree.

## Workflow

Follow these steps in order. Don't batch — finish a step, confirm it, then
move on. Use `TodoWrite` to track the steps so the user can see progress.

### 1. Fetch the issue

Use `gh` to read the issue. You need the title, body, and labels:

```bash
gh issue view <num> --repo jamesqquick/quickspense --json number,title,body,labels,url
```

Read the body carefully. Surface acceptance criteria, file references, and
any constraints to the user **before** writing code. If the issue is vague,
ask for clarification rather than guessing — implementing the wrong thing
wastes a worktree and a PR.

### 2. Pick the branch name

Branch convention: `<prefix>/issue-<num>-<slug>`

Pick the prefix from the issue's labels:

| Label contains | Prefix |
|---|---|
| `bug`, `fix`, `regression` | `fix` |
| `enhancement`, `feature`, `feat` | `feat` |
| `chore`, `refactor`, `docs`, `ci`, `deps` | `chore` |
| (no clear signal) | `feat` (default; ask if unsure) |

`<slug>` is a short kebab-case version of the issue title — 3-6 words,
lowercase, no punctuation. Example: issue #42 "Add CSV export to expense
list" with label `enhancement` → `feat/issue-42-add-csv-export`.

> Note: existing branches in this repo use both `feat/...` and
> `feature/...` styles. Either is acceptable; default to `feat/...` for new
> work unless the user prefers otherwise.

### 3. Create the worktree and run setup

Use the **using-git-worktrees** skill (global) to create the worktree at
`.worktrees/<branch-with-slashes-replaced-by-dashes>` based on `origin/main`
and run `pnpm install`.

Then **immediately** run the **worktree-setup** skill (local to this repo)
to copy `.wrangler-shared/` and `apps/web/.dev.vars` from the main checkout
and apply local migrations. This is mandatory. Skipping it produces empty
list views, missing-secret errors (e.g. "Stripe is not configured"), and
500s on anything bound to D1 / R2 / KV.

After this, all subsequent commands run from the worktree directory.

### 4. Implement the change

- Re-read the issue body and acceptance criteria once more before editing.
- Make the smallest change that satisfies the issue. Resist scope creep.
- Follow the repo's conventions:
  - Monorepo workspaces: `apps/web` (Astro web app), `apps/worker`
    (background Workflows + MCP server), `packages/domain` (shared
    business logic, Zod schemas, types, Drizzle schema).
  - Cross-cutting types/schemas/services live in `packages/domain` and
    are imported via `@quickspense/domain`.
  - TypeScript, named exports, comments only when the code isn't
    self-explanatory.
- See `astro-best-practices` skill for server-first data flow, API route,
  and validation conventions.
- If you discover the issue is bigger or different than described, stop and
  surface that to the user before continuing.

### 5. Verify before pushing

Run the full monorepo build from the worktree root. The root `pnpm build`
script builds the workspaces in dependency order (`domain → web →
worker`), so a single command covers typecheck + build for everything:

```bash
pnpm build
```

If the change touches `packages/domain` and there are unit tests, also run:

```bash
pnpm test
```

Do not push or open a PR if the build or tests fail. Fix the failures
first.

### 6. Commit

Use Conventional Commits, scoped to the area of change. Match the prefix
you chose for the branch when reasonable:

- `feat(expenses): add CSV export to expense list`
- `fix(receipts): handle undefined token in upload flow`
- `chore(deps): bump wrangler to 4.85`
- `feat(domain): add expense filter schema`
- `feat(worker): add MCP tool for category management`

Per project rules in `AGENTS.md`: never `git add` files inside `tmp/`, and
never commit `apps/web/.dev.vars` (or any `.dev.vars`).

### 7. Push and open the PR

Confirm with the user before pushing if this is the first time in the
session — root `AGENTS.md` says don't push without asking. Once confirmed:

```bash
git push -u origin <branch>
```

Open the PR with `gh pr create`. The body must reference the issue with
`Closes #<num>` so GitHub auto-closes it on merge.

PR template:

```markdown
## Summary
<1-3 bullets on what changed and why>

## Changes
- <file or area>: <what>
- <file or area>: <what>

## Testing
See test plan below / in the comment that follows.

Closes #<num>
```

Use a HEREDOC to pass the body so newlines survive the shell:

```bash
gh pr create --title "<conventional commit-style title>" --body "$(cat <<'EOF'
## Summary
...

Closes #<num>
EOF
)"
```

Return the PR URL to the user.

### 8. Write the local test plan

This is the part users care most about. Output it directly in chat as the
final message, using this exact structure:

```markdown
## How to test locally

### Setup
1. `cd .worktrees/<branch>`
2. In one terminal: `pnpm dev:web` (web app on http://localhost:4321)
3. In another terminal (only if the change touches the worker, MCP, or
   Workflows): `pnpm dev:worker`
4. If the change involves Stripe: also run `stripe listen --forward-to
   localhost:4321/api/webhooks/stripe` in a third terminal and ensure
   `STRIPE_WEBHOOK_SECRET` in `apps/web/.dev.vars` matches the printed
   `whsec_...` (see README "Testing Invoicing Locally").

### Test scenarios
1. **<Scenario name>** — <what to do, step by step>
   - Expected: <what should happen>
2. **<Edge case>** — <what to do>
   - Expected: <what should happen>
3. **<Failure path, if relevant>** — <what to do>
   - Expected: <what should happen>

### What to verify in the data layer (if applicable)
- <D1 table>: <expected state>
- Run:
  ```
  pnpm --filter @quickspense/web exec wrangler d1 execute quickspense-db \
    --local --persist-to=../../.wrangler-shared \
    --command "SELECT ... FROM ..."
  ```

### Cleanup
- Nothing destructive was done; the worktree is safe to leave running.
- To tear down after merge: see the `cleanup-merged-worktree` skill.
```

The test scenarios must be **issue-specific** — derived from the
acceptance criteria in the issue body. Generic "open the app, click
around" is not acceptable. Include at least one happy path, one edge
case, and one failure path when the issue's surface area allows.

If the change is purely backend / has no UI, replace the dev-server steps
with the equivalent way to exercise the code (e.g. an API call via
`curl`, an MCP tool invocation, or running a script).

## Quick reference

| Step | Command / Action |
|---|---|
| Read issue | `gh issue view <n> --repo jamesqquick/quickspense --json number,title,body,labels,url` |
| Create worktree | `using-git-worktrees` skill |
| Restore local state | `worktree-setup` skill |
| Verify | `pnpm build` (and `pnpm test` if domain changed) |
| Push | `git push -u origin <branch>` (after confirming) |
| Open PR | `gh pr create` with `Closes #<n>` in body |

## Red flags

**Stop and ask the user if:**
- The issue body is ambiguous or contradicts itself.
- The change touches `.dev.vars`, secrets, auth config, or migrations that
  could affect production data.
- The build fails in a way unrelated to your change (suggests a broken
  main, not a coding issue you should fix in this PR).
- You're about to force-push or amend a pushed commit — never do this
  without explicit permission (see root `AGENTS.md` git safety rules).

**Never:**
- Skip the `worktree-setup` step. The dev server starts but every binding
  fails at runtime.
- Push or open a PR without running `pnpm build` successfully first.
- Commit files in `tmp/` or `apps/*/.dev.vars`.
- Open the PR without `Closes #<num>` in the body.

## Integration

**Pairs with:**
- **using-git-worktrees** (global) — creates the isolated worktree.
- **worktree-setup** (this repo) — restores `.wrangler-shared/` and
  `apps/web/.dev.vars`.
- **cleanup-merged-worktree** (this repo) — for cleanup after the PR is
  merged.
- **astro-best-practices** (this repo) — coding conventions for
  `apps/web` Astro pages and API routes.
- **git-commit** (global) — for Conventional Commits formatting.

## Example flow

```
User: Implement issue 42 https://github.com/jamesqquick/quickspense/issues/42

You: I'm using the implement-gh-issue skill to work issue #42 in a fresh worktree.

[gh issue view 42 → "Add CSV export to expense list", label: enhancement]
[Surface acceptance criteria back to the user]
[Create .worktrees/feat-issue-42-add-csv-export from origin/main]
[Run pnpm install]
[Run worktree-setup: copy .wrangler-shared + apps/web/.dev.vars, run migrations]
[Implement: extend /api/expenses/export.ts; update expense list page to link it]
[pnpm build → passes]
[Commit: feat(expenses): add CSV export to expense list]
[Confirm push with user → push → gh pr create with Closes #42]
[Output the local test plan tailored to CSV export]
```
