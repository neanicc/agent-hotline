---
name: hl-manual-flows
description: Produce a focused manual QA or demo checklist for Agent Hotline with a real phone, real Twilio and ElevenLabs accounts and real Claude Code and Codex sessions, covering what fakes cannot prove. Use for manual test plan, live call QA, demo rehearsal, or recording the Twitter demo.
---

# Agent Hotline manual flows

Generate a runnable checklist for the current change or the requested release
tier. This is read-only checklist generation unless executing it or recording
results is also requested. Agents never place real calls or texts themselves;
the human runs these. Use [AGENTS.md](../../../../AGENTS.md), the diff,
[plan section 11](../../../../docs/plan.md#11-verification-strategy-and-acceptance-checklist)
and the [live check](../../../../docs/live-check.md).

First inspect the actual tests, scenario suite and
[validation routes](../../../references/validation.md) so each item covers an
observation fakes cannot make. Keep only relevant flows for a small change; use
the complete set when the user asks for release or demo readiness.

## Local execution notes

- Prerequisites: upgraded Twilio account with a Canadian number, ElevenLabs
  Starter (for a cloned voice), a tunnel with a stable URL, `hotline doctor` green.
- Use your own phone as the owner number and a second phone (or a friend's) for
  the rejection tests.
- Watch costs in the Twilio and ElevenLabs dashboards while testing.

## Scenario groups

- **Wiring:** `hotline doctor` green; `hotline test-call` rings and plays the
  test line; texts arrive.
- **Claude Code question:** a session uses `ask_human`; answer by voice; the
  session continues with the answer. Repeat answering by text.
- **Codex approvals:** away mode on; approve one command, deny another; check
  what Codex did. High-risk command without PIN is denied; with PIN it runs.
- **Away loop:** agent finishes a turn; phone rings; give the next instruction;
  it continues. Say "that's it"; it stops. Loop cap holds.
- **No pickup and quiet hours:** decline the call → text arrives → reply works.
  Inside quiet hours an ask texts instead of calling.
- **Several agents:** Claude Code and Codex ask together → one call covers both,
  each gets its own answer.
- **Inbound:** call the number, give the PIN, hear status, give an instruction,
  see it delivered. Wrong PIN ends the call. Another phone is rejected and hears
  nothing useful.
- **Voice:** switch voices; try your cloned voice; interrupt the voice mid-sentence
  (barge-in works); latency feels conversational.
- **Privacy:** check what Twilio and ElevenLabs logs show for a session that
  touched a file with a fake API key: the key must not appear.
- **Demo recording:** screen-record the terminal and phone side by side: agent
  stuck → phone rings → spoken answer → agent continues.

Write each item as `- [ ] Setup — action → observable expected result`, ordered so
early steps prepare later ones. List required accounts and hardware up front.

No phone test is not a pass. When results are requested, append actual
observations to `docs/live-check.md` with date, commit, agent versions, provider
plans, scenarios, what happened, and remaining issues; otherwise return the
checklist only.
