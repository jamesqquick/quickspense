---
name: cleanup-merged-worktree
description: Use after a feature PR has been merged on GitHub and the remote branch deleted, to clean up the local Quickspense checkout. Removes the merged worktree, deletes the local branch, fast-forwards the main checkout to the latest origin/main, and prunes stale remote-tracking refs. Triggers on "the PR is merged", "I merged the PR", "PR merged and remote branch deleted", "clean up the worktree", "tear down the worktree", "pull main", "remove the merged branch", or any post-merge cleanup request. Complements the using-git-worktrees skill (which creates worktrees) and the worktree-setup skill (which seeds local state).
---

# Cleanup Merged Worktree (Quickspense)

## Overview

After a feature PR merges on GitHub and the remote branch is deleted, the
local checkout still has three pieces of stale state:

1. The worktree directory under `.worktrees/<branch>/`.
2. The local branch ref pointing at the pre-merge commit.
3. A stale `origin/<branch>` remote-tracking ref (because the local repo
   does not learn about deleted remote branches until it prunes).

Plus the local `main` is one or more commits behind `origin/main` (which
now contains the merge commit).

This skill performs all four cleanups in the right order, with the right
safety checks.

**Announce at start:** "I'm using the cleanup-merged-worktree skill to
remove the merged worktree and refresh main."

## When to use

Trigger this skill when **all** of the following are true:

- A PR opened from this repo has been merged into `main` on GitHub.
- The remote branch for that PR has been deleted (or the user says it has).
- The user wants the local environment cleaned up.

Phrases the user is likely to say:

- "I merged the PR — clean up"
- "The PR is merged, can you tear down the worktree?"
- "Pull the latest main and remove the worktree"
- "Worktree cleanup"

Do **not** use this skill for:

- Worktrees with **uncommitted or unpushed work** — surface that first
  and let the user decide. See "Red flags" below.
- Worktrees whose branch is **not yet merged** — those should go through
  the `worktree-pr-flow` or `finishing-a-development-branch` skills,
  which handle the merge decision itself.
- Worktrees the user wants to keep running because they're testing a
  different feature there.

## Workflow

Run all commands from the **main checkout** (`/Users/.../quickspense`),
**not** from inside the worktree being removed. If the current shell is
inside the worktree, `cd` out first — `git worktree remove` will refuse
to delete the directory you're standing in.

### 1. Identify the merged worktree

If the user named the branch, use it directly. Otherwise list current
worktrees and ask:

```bash
git worktree list
```

Pick the row whose path is under `.worktrees/`. Confirm with the user
which one to remove if more than one is present.

### 2. Verify it is safe to delete

Check three things before destroying anything:

```bash
# 2a. No uncommitted changes (working tree clean).
git -C .worktrees/<branch> status --porcelain
# Expect empty output. If anything prints, STOP and surface it to the user.

# 2b. No unpushed commits.
git -C .worktrees/<branch> log @{u}..HEAD --oneline 2>/dev/null
# Expect empty output. If anything prints, STOP — those commits would be lost.

# 2c. The branch was actually merged on the remote.
gh pr list --state merged --head <branch> --json number,mergedAt,url
# Expect at least one merged PR. If empty, the PR is still open or closed —
# do NOT proceed without explicit confirmation from the user.
```

If any of these fail, stop and explain what you found. Never delete a
worktree with uncommitted, unpushed, or unmerged work without an
explicit "yes, delete it anyway" from the user.

### 3. Remove the worktree

```bash
git worktree remove .worktrees/<branch>
```

If this fails because the working directory is dirty, do **not** add
`--force` automatically — that defeats the safety check in step 2.
Surface the error to the user and let them decide.

### 4. Delete the local branch

```bash
git branch -d <branch>
```

`-d` (lowercase) refuses to delete unmerged branches. Git may warn:

> warning: deleting branch '<branch>' that has been merged to
> 'refs/remotes/origin/<branch>', but not yet merged to HEAD

This is **expected and safe** when the local `main` has not yet been
pulled — git is confirming the branch was merged on the remote even
though the local `main` doesn't yet contain that commit. Step 5 fixes
the local `main`.

If git refuses with a hard error (not a warning), that means the branch
has commits that are not on any merged ref. Stop and surface to the
user.

### 5. Fast-forward main

```bash
git checkout main         # if not already on main
git pull --ff-only origin main
```

Use `--ff-only` so a divergent local `main` (e.g. someone committed
locally to `main` directly) surfaces as an error instead of producing a
merge commit. If it fails, stop and tell the user.

### 6. Prune stale remote-tracking refs

```bash
git remote prune origin
```

This removes the local `refs/remotes/origin/<branch>` entry now that the
remote branch has been deleted. Skipping this isn't dangerous, but it
keeps `git branch -a` and `git worktree list` output tidy.

### 7. Report what was done

End with a short summary:

```
Worktree at .worktrees/<branch> removed.
Local branch <branch> deleted.
main fast-forwarded: <old-sha> -> <new-sha> (PR #<num>).
Pruned stale origin/<branch>.
```

## Quick Reference

| Step | Command |
|---|---|
| List worktrees | `git worktree list` |
| Verify clean | `git -C .worktrees/<branch> status --porcelain` |
| Verify pushed | `git -C .worktrees/<branch> log @{u}..HEAD --oneline` |
| Verify merged | `gh pr list --state merged --head <branch>` |
| Remove worktree | `git worktree remove .worktrees/<branch>` |
| Delete branch | `git branch -d <branch>` |
| Pull main | `git pull --ff-only origin main` |
| Prune | `git remote prune origin` |

## Red Flags

**Stop and ask the user if:**

- `git status --porcelain` in the worktree returns any output. There are
  uncommitted changes that will be lost.
- `git log @{u}..HEAD` returns any commits. There are unpushed commits
  that will be lost.
- `gh pr list --state merged --head <branch>` returns nothing. The PR
  may not actually be merged.
- `git pull --ff-only` fails because `main` has diverged. Something
  unexpected has happened on `main` locally.
- `git branch -d` errors out (not a warning, an error). The branch has
  commits that are not on any merged ref.

**Never:**

- Use `git worktree remove --force` automatically. It bypasses the
  uncommitted-changes safety check.
- Use `git branch -D` (capital `D`) automatically. It bypasses the
  unmerged-commits safety check.
- Run any of these from **inside** the worktree being removed.
- Delete `main` or the main checkout.
- Run this on a worktree whose branch has not been merged.

**Always:**

- Run from the main checkout, not from inside the doomed worktree.
- Verify clean working tree, pushed commits, and merged PR before
  destruction.
- Use `--ff-only` when pulling `main` so divergence is loud, not silent.
- Prune at the end so subsequent `git worktree list` is accurate.

## Example

```
User: I merged PR #42 and deleted the remote branch. Clean up.

You: I'm using the cleanup-merged-worktree skill to remove the merged
worktree and refresh main.

[git worktree list -> .worktrees/feature-issue-37-csv-export]
[git -C ... status --porcelain -> empty]
[git -C ... log @{u}..HEAD -> empty]
[gh pr list --state merged --head feature-issue-37-csv-export -> #42]
[git worktree remove .worktrees/feature-issue-37-csv-export]
[git branch -d feature-issue-37-csv-export -> deleted]
[git pull --ff-only origin main -> 4e6fb22..8d575db]
[git remote prune origin -> pruned origin/feature-issue-37-csv-export]

Worktree removed.
Local branch deleted.
main: 4e6fb22 -> 8d575db (PR #42 merge).
Stale remote ref pruned.
```

## Integration

**Pairs with:**

- **using-git-worktrees** (global) — creates the worktree this skill
  removes.
- **worktree-setup** (this repo) — seeds local state into a freshly
  created worktree; this skill is its mirror image at end-of-life.
- **implement-gh-issue** (this repo) — the typical flow that produces a
  worktree this skill later cleans up.

**Does not replace:**

- **finishing-a-development-branch** / **worktree-pr-flow** (global) —
  those decide *whether* to merge and *how* to integrate. This skill
  starts where they finish: the PR is already merged on GitHub.
