---
name: hl-catchup
description: Bring an Agent Hotline task branch up to date with main or its PR base, resolving merge conflicts while preserving contracts, security checks and both sides' tests. Use for catch up, sync branch, or resolve conflicts.
---

# Catch up an Agent Hotline branch

Follow [AGENTS.md](../../../../AGENTS.md). Inspect status, the current branch, its
base, and any merge or rebase already in progress. Use the PR's base or the
user's explicit ref; otherwise `main`. Fetch it.

- Preserve unrelated dirty or staged files. Prefer an isolated worktree when
  needed; do not blindly stash, reset or overwrite work.
- If the base is already an ancestor of HEAD, there is nothing to do.
- Merge by default for pushed branches. Rebase only when requested; rewriting a
  published branch needs explicit authorization. Never force-push or discard a
  whole side without reading it.
- For each conflict, read both intents and nearby consumers and tests. Resolve
  routine conflicts directly. Ask only for a real product or contract choice.
- Watch especially for: zod contracts in `packages/core`, hook output formats,
  route registration and verification middleware, redaction call sites, policy
  defaults (quiet hours, rate limits, timeouts), and SQLite migrations. Keep both
  sides' tests.
- `pnpm-lock.yaml` conflicts: resolve `package.json` intent first, then regenerate
  with the pinned pnpm (`pnpm install`); never hand-merge the lockfile.
- `docs/agent-log.md` conflicts: keep both entries, in merge order.
- Inspect the complete resulting diff, including automatic merges. Run the
  relevant [checks](../../../references/validation.md), stage the resolved files
  explicitly and finish the merge. Honor hooks.

Push only when requested or part of babysit, PR delivery or autopilot. Report the
base, resulting commit, validation and whether it was pushed. If blocked
mid-operation, state the exact state and the decision needed; never leave an
unfinished merge silently or abort someone else's operation.
