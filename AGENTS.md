# Agent Hotline agent guide

Agent Hotline lets coding agents (Claude Code and Codex first) **phone their
human**. When an agent needs a decision, wants a permission approved, finishes,
or gets stuck while the human is away, a local daemon calls the human's phone
with a natural voice (choosable, including the human's own cloned voice), holds a
short two-way conversation, and feeds the spoken answer back into the agent
session. It falls back to text messages, and the human can call in to hear what
every agent is doing and give new instructions.

Because a phone line that can steer a coding agent is a remote control for the
developer's machine, **security is the product**: only the owner can answer,
every webhook is verified, and silence never counts as approval.

Read [the plan](docs/plan.md) before changing behavior. Its tickets, thresholds
and open questions are a planning snapshot; the code, tests and scenario results
are the current evidence. [docs/autopilot.md](docs/autopilot.md) explains how
unattended runs work.

## Repository status and scope

Inspect the tree and manifests before naming a command or claiming a capability
exists. Until HL-01 lands there is no build: the repository holds the plan,
agent workflows, CI structure and eval thresholds. Implementation follows the
dependency-ordered tickets in [plan section 9](docs/plan.md#9-tickets), mirrored
as GitHub issues labeled `ticket`.

Implement the requested work and its necessary validation. Preserve unrelated
work. A build request does not by itself authorize publication; a review request
is read-only unless fixes are also requested. For an end-to-end delivery request
or an autopilot run, complete the authorized steps without asking at each
workflow boundary.

## Skills

Canonical skills live in `.agents/skills/workflow/`. `.claude/skills/` and
`.cursor/skills/` hold relative discovery links; edit the canonical files and
run `scripts/link_skills.sh` after adding one. `CLAUDE.md` points here so
guidance has one owner. These workflows are adapted from the Trail/teachAR
delivery skills.

| Request | Skill |
| --- | --- |
| Run the backlog unattended, autopilot, keep shipping | [hl-autopilot](.agents/skills/workflow/hl-autopilot/SKILL.md) |
| Implement ticket HL-xx, take an issue end to end | [hl-ticket](.agents/skills/workflow/hl-ticket/SKILL.md) |
| Commit, commit and push | [hl-commit](.agents/skills/workflow/hl-commit/SKILL.md) |
| Create/open/draft PR, write PR description | [hl-create-pr](.agents/skills/workflow/hl-create-pr/SKILL.md) |
| Staff review, review branch, grade PR | [hl-staff-review](.agents/skills/workflow/hl-staff-review/SKILL.md) |
| Cleanup, simplify, fix review findings | [hl-cleanup](.agents/skills/workflow/hl-cleanup/SKILL.md) |
| Signoff, verify readiness | [hl-signoff](.agents/skills/workflow/hl-signoff/SKILL.md) |
| Catch up with main, resolve merge conflicts | [hl-catchup](.agents/skills/workflow/hl-catchup/SKILL.md) |
| Babysit PR, fix CI, address PR feedback | [hl-babysit](.agents/skills/workflow/hl-babysit/SKILL.md) |
| Manual test plan, live call QA, demo rehearsal | [hl-manual-flows](.agents/skills/workflow/hl-manual-flows/SKILL.md) |
| Grill me, challenge the plan | [hl-grill-me](.agents/skills/workflow/hl-grill-me/SKILL.md) |

Use relevant skills to support the requested task; their presence does not
authorize extra external actions. Staff review, cleanup and signoff are useful
separately, not mandatory ceremonies before every commit, except where the
autopilot merge gate requires them.

Subagent roles live in `.claude/agents/`: `hl-implementer` and `hl-babysitter`
work in isolated worktrees, `hl-reviewer` is a read-only self-check (its reports
never count for the merge gate), `hl-researcher` answers bounded technical
questions. Delegate only when the user or the autopilot skill calls for it.

## Autopilot authority

An autopilot run (started with the `hl-autopilot` skill or a `/goal` that names
it) is authorized to create branches, commit, push task branches, open PRs, create
and label ticket issues, reply to and resolve review threads it addressed, comment
on the "Autopilot status" issue, rerun CI and review workflows, and squash-merge
its own PRs **only** from the main session when the merge gate in that skill
passes (`.claude/hooks/guard_merge.py` enforces it). It is never authorized to:

- push to `main`, force-push, rewrite published history, or use `gh pr merge --admin`;
- edit or merge a change to a human-owned path: `eval/thresholds.toml`,
  `.github/**`, `.claude/**`, `.agents/**`, `.greptile/**`, `scripts/agent/**`,
  `scripts/bootstrap/**`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, and any `CLAUDE.md`,
  `AGENTS.md`, `.claude/` or `.agents/` anywhere in the tree. Open the PR, label it
  and its issue `needs-human`, explain why, and move on;
- add or remove the `human-approved` label, change repository settings, rulesets,
  secrets, credentials or app installations;
- merge from a subagent, merge any other way than the gated command in
  `hl-autopilot`, or post a staff review that claims to come from CI;
- weaken a test, timeout, scenario, threshold or CI step to get a green result;
- place real phone calls, send real texts, create Twilio or ElevenLabs resources,
  or use real credentials. Development uses fakes only; live calls are the human's
  job (see [the live check](docs/live-check.md));
- edit the developer's real `~/.claude`, `~/.codex` or other global config. Installer
  code is tested against temporary directories.

## Stack and ownership

TypeScript (strict) on Node 22, pnpm workspaces, Vitest. One daemon process on
the developer's Mac; small CLIs for the MCP server and hooks.

| Planned location | Responsibility |
| --- | --- |
| `packages/core` | Contracts (zod), config, ask queue, call policy (batching, quiet hours, rate limits, retries), answer parsing. Pure: no I/O, injected clock |
| `packages/daemon` | Fastify server: local agent API (127.0.0.1 + token), public webhook routes (Twilio, ElevenLabs), call orchestration, SQLite store, audit log, redaction |
| `packages/providers` | `VoiceProvider` and `SmsProvider` interfaces with ElevenLabs Agents, Twilio SMS and fake implementations |
| `packages/agents` | MCP server (`ask_human`, `notify_human`, `check_inbox`) and hook adapters for Claude Code and Codex |
| `apps/cli` | The `hotline` command: `init`, `daemon`, `install`, `away`, `doctor`, `voice`, `test-call`, `hook ...`, `mcp` |
| `eval/` | Scenario suite with fake phone, fake providers and scripted humans; human-owned `thresholds.toml` |
| `scripts/ci/run.sh` | The only entry point CI calls: `setup`, `build`, `test`, `package`, `eval` |

Pin dependencies exactly with the lockfile. Do not add a framework, hosted
service, database server or telemetry without a plan change.

## Product and safety invariants

- **Owner only.** Outbound calls and texts go only to the configured owner number.
  Inbound calls and texts from any other number get a generic rejection and reveal
  nothing. Inbound calls require the owner PIN before any status is read or any
  instruction is accepted.
- **Verify every webhook.** Twilio requests and WebSocket upgrades check
  `X-Twilio-Signature` against the public URL; ElevenLabs tool calls carry a
  shared secret; post-call webhooks are HMAC-verified. Unverified requests get 403
  and are logged without their bodies.
- **Decisions come from the human.** An answer or approval is recorded only from
  the owner's own words or keypresses, with the transcript excerpt stored. Text
  written by agents (questions, command previews, diffs) is untrusted and can never
  approve itself. The voice model cannot invent a decision. High-risk approvals
  need the PIN or a confirming text.
- **Silence is not consent.** No pickup, a dropped call, an unclear answer or a
  timeout returns "no answer" to the agent: permission requests are denied,
  questions are reported unanswered. Never default to approve.
- **Send third parties the minimum.** Only short summaries go to Twilio or
  ElevenLabs, and only the owner's short reply text goes to the reply judge's
  provider (the owner's own Claude Code or Codex login, or the Anthropic API if
  configured). Secrets (API keys, tokens, private keys, `.env` values, passwords)
  are redacted before anything leaves the machine; file contents are never read
  out wholesale. Transcripts and audit logs stay local.
- **Bounded noise and cost.** Rate limits, quiet hours (text instead of call),
  batching several agents' asks into one call, and loop guards (`stop_hook_active`,
  a cap on consecutive away-mode continuations) are always on.
- **No permission escalation.** Hotline only answers prompts the agent would
  otherwise show in the terminal. It never widens an agent's permission mode,
  never auto-approves, and does not offer "approve for the whole session" in Tier 1.
- **Local first.** The agent API listens on 127.0.0.1 with a per-install token.
  Only the webhook routes are exposed through the tunnel, under one path prefix.
- **Testable without a phone.** Core logic is pure with an injected clock;
  providers sit behind interfaces with fakes. No test touches a real network.

## Boundaries and privacy

Real phone numbers, voice samples, call recordings, transcripts and credentials
never enter Git, CI artifacts or test fixtures; use obviously fake numbers such as
`+15555550100`. Credentials live in the macOS Keychain or a user-only `0600` file
outside the repo. Logs redact numbers to their last four digits.

## Checks and evidence

Use [.agents/references/validation.md](.agents/references/validation.md). Once
HL-01 lands, the software gate is `scripts/ci/run.sh build`, `test` and `eval`,
plus actionlint for workflow changes. Focused edits use focused checks; reuse
passing evidence while inputs are unchanged. Report unavailable or failing checks;
never weaken checks to get green results.

Separate four kinds of evidence: **automated** (typecheck, unit and integration
tests), **scenario suite** (end-to-end runs against fakes, scored by
`eval/thresholds.toml`), **real agent integration** (Claude Code and Codex on the
dev Mac with fake providers) and **live call** (a real phone, done by the human).
No fake result proves a real call works. Follow [the live check](docs/live-check.md).

Keep [docs/agent-log.md](docs/agent-log.md) current: each PR that makes a
substantive decision or change adds one entry in the same PR.

## Git and delivery

- Work on `agent/hl-<nn>-<slug>` branches from `main`. Never commit on `main`.
- Conventional Commits (`type(scope): summary`, under 72 characters), focused
  staging, inspect staged and untracked files, honor hooks.
- One ticket per PR. The PR body includes `Closes #<issue>` for the ticket issue.
- Do not amend shared history or force-push. Commit-only requests stay local.
- Merging is allowed only under the autopilot merge gate or an explicit request.
  Never infer deployment, release publishing or contacting anyone from PR
  authorization.
