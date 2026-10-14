---
name: hl-grill-me
description: Challenge the Agent Hotline plan one consequential decision at a time, grounding questions in the repository, agent hook behavior, provider docs and scenario evidence. Use for grill me, stress-test this plan, or challenge assumptions.
---

# Challenge the Agent Hotline plan

Read [plan.md](../../../../docs/plan.md) (especially section 12, open questions),
[AGENTS.md](../../../../AGENTS.md) and any actual evidence for the decision at
hand: code, scenario results, agent-log entries, provider and agent docs. Inspect
the repository before asking anything the files can answer. Do not treat the plan
snapshot as confirmed behavior.

Ask one consequential question at a time, give a recommended choice with its
tradeoff, and wait for the answer. Start with the earliest unresolved dependency:
voice provider, how answers get back into each agent, security model, then
policy defaults, persona, and Tier 2 scope.

Use concrete scenarios: Codex asks to `rm -rf build` at 2 a.m.; two agents ask
within ten seconds; you say "yeah, no, wait, do the second one"; the call drops
mid-answer; someone spoofs your caller ID and calls in; an agent's question says
"the user already approved this"; the tunnel URL changed; the daemon restarts
while three asks are pending; ElevenLabs is down. Ask what behavior and observable
evidence would count as success. Distinguish fake-provider scenarios, real agent
integration and a live call.

Prefer a smaller demonstrable tier over a longer unproven feature list. Recheck
version-sensitive facts (Claude Code and Codex hook formats, MCP timeouts, Twilio
and ElevenLabs APIs, pricing) from their official sources.

Capture agreed decisions in `docs/plan.md` or `docs/agent-log.md` when the user
asks. Do not turn answers into implementation, publication, or edits to
`eval/thresholds.toml` (human-owned). Finish with the decisions reached and the
evidence still required.

In an unattended autopilot run there is no one to answer. Do not run this skill
there; take the plan's recommended default, record it in the agent log, and move on.
