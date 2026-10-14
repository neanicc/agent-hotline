---
name: hl-commit
description: Stage focused Agent Hotline changes and create Conventional Commits; push the task branch when requested or when part of PR delivery or autopilot. Use for commit, commit and push, or committing a completed delivery task.
---

# Commit Agent Hotline changes

Follow [AGENTS.md](../../../../AGENTS.md). A commit-only request stays local; an
explicit commit-and-push, PR delivery or autopilot run includes pushing the task
branch. Do not expand this task into review, cleanup, a PR or a merge.

1. Inspect status, unstaged and staged diffs, and relevant untracked files.
   Preserve unrelated work and already-staged changes; isolate only this task.
2. Resolve the branch. New agent work uses `agent/hl-<nn>-<slug>` from `main`.
   Never commit on `main`. If HEAD is unborn, inspect remote refs before the
   first commit instead of creating an unrelated root.
3. Reuse validation for unchanged inputs; run missing focused checks from
   [validation routes](../../../references/validation.md). Do not claim a check
   ran if the stage only printed a "not landed" notice.
4. Group related changes into coherent commits. Stage explicit paths and inspect
   `git diff --cached`. The commit must not contain build output (`dist/`,
   `eval-out/`, `node_modules/`), SQLite files, `.env` files, real phone numbers,
   voice samples, recordings, transcripts, or credentials of any kind. Use fake
   numbers like `+15555550100` in tests. A feature, its tests and its docs belong
   together.
5. Message: `type(scope): imperative summary`, under 72 characters, no final
   period. Scopes follow packages and lanes, for example
   `feat(core): batch concurrent asks into one call`,
   `fix(daemon): reject replayed Twilio webhooks`,
   `feat(agents): add Codex PermissionRequest adapter`. Explain non-obvious reasons
   in the body; for multiline messages write a temporary file and use `git commit -F`.
6. Honor hooks and configured authorship. Fix an in-scope hook failure and retry;
   never bypass a hook with `--no-verify`. Do not amend a pushed commit.
7. When pushing is authorized, push the task branch with upstream set. Resolve a
   non-fast-forward from evidence (fetch, inspect, merge); never force-push.
   Verify the remote branch SHA matches the local commit after the push.

Report the commit hash, pushed or local state, checks, and remaining worktree
changes. A leftover unrelated change is not a reason to commit or discard it.
