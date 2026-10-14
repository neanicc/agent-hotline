---
name: hl-signoff
description: Verify and repair Agent Hotline's applicable readiness checks for the current revision, separating code and scenario-suite readiness from real-agent integration and live phone acceptance. Use for signoff, final verification, or checking readiness after PR fixes.
---

# Sign off an Agent Hotline revision

Read [AGENTS.md](../../../../AGENTS.md) and
[validation routes](../../../references/validation.md). Signoff establishes
evidence for the requested scope. It does not start a staff review, publish
statuses or merge.

## Verify and repair

1. Record status, branch, HEAD and any task or unrelated dirty files. Identify
   whether the scope is docs, core, daemon, agents, providers, installer, or
   whole-project acceptance. Read `scripts/ci/run.sh` and CI before naming the gate.
2. Docs and skills: `python3 scripts/check_agent_files.py` and `git diff --check`.
   Code: `scripts/ci/run.sh setup`, `build`, `test`. Daemon, agents or providers:
   also `scripts/ci/run.sh eval` once the suite exists. Acceptance:
   `scripts/ci/run.sh eval --local` on the dev Mac. A stage that printed a
   "not landed" notice did not verify anything; say so.
3. Read every failure, repair in-scope causes, run focused checks for each
   repair. Never weaken tests, timeouts, scenarios, thresholds or CI stages. A
   product decision or missing external prerequisite is a concrete blocker.
4. Rerun the applicable final gate after changes. Stop on a repeated identical
   infrastructure failure with no new local action available; report the command,
   evidence and missing prerequisite.
5. When commit and push are part of the request, use
   [hl-commit](../hl-commit/SKILL.md), verify the final SHA and upstream, and
   attribute only evidence valid for that SHA. Otherwise label results as
   worktree verification.

## Readiness report

State scope (commit or worktree), commands and results, fixes, and unresolved
issues. Local success does not mean hosted CI passed. A later relevant change
invalidates affected evidence.

For release or acceptance signoff, require the [live check](../../../../docs/live-check.md)
record. When absent, state **code and scenario suite verified; live calls not
done**. Never fabricate call observations.
