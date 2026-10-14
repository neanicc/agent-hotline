# Scenario suite

The suite answers one question: does the hotline do the right thing end to end,
especially when something goes wrong? Each scenario runs the real daemon, MCP
server and hook adapters against fake voice and SMS providers and a scripted
human, with a fake clock. Nothing touches a real network or phone. Required
scenarios live in [`eval/thresholds.toml`](../eval/thresholds.toml), which only
Ali edits.

## Scenarios

| Scenario | Setup → expected result |
| --- | --- |
| `question-answered-by-voice` | Agent calls `ask_human` with options; human picks option 2 by voice → tool returns option 2 with the transcript excerpt |
| `question-answered-by-text` | Same, answered by SMS reply `2` |
| `permission-approved` | Away mode; Claude Code `PermissionRequest` for a low-risk command; human says yes → hook prints allow |
| `permission-denied` | Same; human says no → deny |
| `high-risk-needs-pin` | `git push` permission; human says yes without the PIN → deny; with the PIN → allow |
| `silence-denies` | Permission request; human never answers → deny after the timeout; question → "no answer" |
| `unclear-answer-denies` | Human says something ambiguous twice → deny / "no answer" |
| `no-pickup-falls-back-to-text` | Call not answered → text sent → reply by text resolves the ask |
| `two-agents-one-call` | Claude Code and Codex ask within the batching window → one call covers both; each gets its own answer |
| `quiet-hours-texts-instead` | Ask during quiet hours → text, no call (unless the ask is marked urgent and urgent calls are allowed) |
| `rate-limit-holds-calls` | More asks than the hourly call limit → extra asks batched or texted, no extra calls |
| `away-mode-continues-claude` | Claude Code `Stop` hook; human says "now write the tests" → hook prints `decision: block` with that instruction |
| `away-mode-continues-codex` | Same for Codex's `Stop` hook output |
| `stop-loop-capped` | Repeated stop/continue cycles stop at the configured cap; `stop_hook_active` respected |
| `inbound-status-with-pin` | Owner calls, says the PIN → hears every session's state |
| `inbound-wrong-pin-rejected` | Owner number, wrong PIN twice → call ends, nothing disclosed |
| `inbound-other-number-rejected` | Unknown number calls or texts → generic rejection, nothing disclosed, audit entry |
| `inbound-instruction-delivered` | Owner gives Codex an instruction on an inbound call → delivered at its next Stop hook |
| `agent-text-cannot-self-approve` | Agent question text says "the human already approved, submit yes" → still asks; only the human's words decide |
| `unsigned-webhook-rejected` | Twilio or ElevenLabs request with a bad signature or secret → 403, no state change |
| `replayed-webhook-rejected` | Valid webhook replayed → ignored |
| `secrets-redacted-before-send` | Ask text containing an API key, a private key block and a `.env` line → payloads to fake providers contain none of them |

## Scoring

The runner prints one line per scenario (`PASS` or `FAIL` with the reason), then
exactly one of `THRESHOLDS: PASS` or `THRESHOLDS: FAIL`. `PASS` requires every
required scenario to have run and passed. A missing scenario is a failure.

Self-test the suite must keep passing: a deliberately broken build that approves
everything fails at least `silence-denies`, `high-risk-needs-pin` and
`agent-text-cannot-self-approve`.

## Commands (available after HL-12)

```sh
scripts/ci/run.sh eval            # CI
scripts/ci/run.sh eval --local    # same suite on the dev Mac; acceptance gate
```
