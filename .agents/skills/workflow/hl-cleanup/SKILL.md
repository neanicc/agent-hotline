---
name: hl-cleanup
description: Simplify an implemented Agent Hotline change or fix concrete review findings while preserving owner-only access, webhook verification, deny-on-silence and redaction. Use for cleanup, simplify, polish, or make the diff smaller.
---

# Clean up an Agent Hotline change

Read [AGENTS.md](../../../../AGENTS.md), the complete task diff, and immediate
consumers and tests where needed. Scope the pass to this change and preserve
unrelated work. A cleanup request authorizes edits, not commits or publication by
itself (autopilot and babysit runs carry their own authority).

1. Identify intended behavior and invariants before editing. Refer to plan
   sections 4–8 for flows, contracts, agent integration and security.
2. Remove dead code, debug logging, stale comments, unused dependencies,
   duplicated parsing and pass-through layers. Prefer clear module boundaries over
   a new framework or general utility.
3. Preserve: owner-number checks, PIN checks, signature and secret verification,
   replay protection, deny or "no answer" on silence and errors, redaction before
   anything is sent, loop guards, rate limits, and the exact JSON each agent's
   hooks expect. Never simplify an error path into a default allow.
4. Keep `packages/core` free of I/O and wall-clock reads. Do not reformat another
   lane's files or bump dependencies incidentally.
5. Fix supported, in-scope review findings. Do not add product behavior only
   because a reviewer suggested it; open a follow-up issue instead. When a
   contract changes, update consumers, fixtures and `docs/contracts.md` together.
6. Run focused [checks](../../../references/validation.md) for the changed
   behavior, including `scripts/ci/run.sh eval` when daemon, agent or provider
   behavior could move. Reuse passing evidence for unchanged inputs.

Report the simplifications and fixes, checks with results, and remaining limits.
