# Agent Hotline implementation plan

Snapshot written 2026-10-13. Tickets, thresholds and recommendations below are
planning inputs, not evidence. Current behavior is whatever the code, tests and
scenario results on `main` show.

## 1. Product direction

You start Claude Code or Codex on a task and walk away. When the agent needs you,
your phone rings:

> "Yo, it's Claude in stream-privacy-guard. The Windows build broke on the ONNX
> download. Want me to pin the older version, or skip Windows for now?"

You answer out loud, the agent continues with your answer. It can also ask you
to approve a risky command, tell you it finished, or text you when a call would
be rude (quiet hours) or you don't pick up. You can call the number yourself:
"what's everyone doing?", and give any agent a new instruction.

The voice is yours to pick from ElevenLabs' library, including a clone of your
own voice. Tier 1 targets Claude Code and Codex CLI on one Mac with one owner.

Security is part of the product, not a later pass: the phone line can steer
agents that run commands on your machine.

## 2. Prior art and wedge

| Project | What it does | Gap Agent Hotline targets |
| --- | --- | --- |
| ZeframLou/call-me (~2.6k stars) | Claude Code plugin; MCP tools to start and continue an outbound call; Telnyx/Twilio, OpenAI speech; prompt Stop hook nudges Claude to call | Claude Code only, outbound only, no texts, no voice approvals, no cloned voice, no multi-agent routing |
| better-call-claude | Claude Code; calls both ways, SMS/WhatsApp (untested) | No Codex, no permission relay, tiny |
| agentcall (Go) | Twilio Media Streams, Deepgram, ElevenLabs; Claude Code, Gemini CLI | No Codex, no SMS |
| Happy, Omnara, cc-connect | Phone apps or chat bridges for Claude Code and Codex with approvals | Apps and chat, not phone calls |
| Claude Code Remote Control / Channels | Official remote control, push, chat channels with permission relay | No voice calls; Claude Code only |

Wedge: one hotline for **both** Claude Code and Codex, voice permission
approvals through each agent's documented `PermissionRequest` hook, an "away
mode" that keeps either agent working from your spoken next instruction through
its `Stop` hook, one call for several agents, inbound status calls, text fallback,
and your own voice.

## 3. Architecture

```
 Claude Code / Codex session (on your Mac)
   ├─ MCP server: `hotline mcp` (stdio) ── ask_human / notify_human / check_inbox ─┐
   └─ hooks: `hotline hook <claude|codex> <permission|stop>` ──────────────────────┤
                                                    local agent API: 127.0.0.1 + token
                                                                                   ▼
                                       hotline daemon (Fastify + SQLite, one process)
                           core: ask queue, call policy, answer parsing  ── audit log, redaction
                                         │                              │
                         VoiceProvider: ElevenLabs Agents      SmsProvider: Twilio SMS
                         outbound-call API; server tools        send; inbound webhook
                         call back into /hooks/el/*             /hooks/twilio/sms
                                         │                              │
                                         └────────►  your phone  ◄──────┘
         tunnel (ngrok static domain or Cloudflare named tunnel) exposes only /hooks/*
```

- `packages/core` holds the logic that decides who to call, when, and what an
  answer means. Pure, injected clock, fully unit-tested.
- `packages/daemon` is the only long-running process. Agents talk to it on
  localhost with a token; phone providers talk to it through the tunnel. To
  judge an unclear spoken approval it may run the owner's own `claude` or
  `codex` CLI once, isolated (section 8, HL-09d).
- `packages/providers` hides vendors behind interfaces. Fakes implement the same
  interfaces for tests and the scenario suite.
- `packages/agents` holds the MCP server and the hook adapters, which are thin
  clients of the daemon.
- `apps/cli` is the single `hotline` command users install.

## 4. Flows

**A. Question (MCP `ask_human`).** The agent calls the tool with a short question,
optional options and a context summary. The daemon queues an ask; policy decides
call now, text (quiet hours), or batch with other pending asks. The voice provider
places the call with dynamic variables (agent nickname, project, question,
options). The voice agent converses, then calls the `submit_answer` server tool
with the structured answer and the owner's verbatim words. The daemon checks the
call belongs to that ask and the owner, stores it, and the MCP tool returns. The
tool sends a progress notification about every 60 s while waiting so neither
agent's idle timeout fires. Default wait 30 min, then "no answer".

**B. Permission (`PermissionRequest` hook, away mode only).** The hook sends tool
name, a redacted one-line preview and a risk class. Same call flow. The hook
prints the agent's documented allow or deny output. High-risk actions need the
owner PIN spoken or a confirming text. Anything other than a clear yes is a deny.

**C. Away loop (`Stop` hook, away mode only).** When the agent finishes a turn,
the hook sends a summary of its last message and asks "what next?". A spoken
instruction becomes `{"decision": "block", "reason": "<instruction>"}`, which both
Claude Code and Codex treat as the next user prompt. "That's it" lets the agent
stop. `stop_hook_active` and a cap on consecutive continuations prevent loops.

**D. Inbound line.** The owner calls the number; the voice agent asks for the PIN
(`verify_pin` tool), then reads `get_status` (each session: agent, project, state,
last message, pending asks). A new instruction for a session goes through
`send_instruction` and is delivered at that session's next ask or Stop hook.
Other callers hear a generic message and nothing else.

**E. Text messages.** Used for quiet hours, no pickup, notifications and
confirmations. Replies: an option number, yes/no, free text, `call me`, `status`,
`stop`. Only the owner's number is accepted.

## 5. Contracts

Defined in HL-02 and documented in `docs/contracts.md` once written.

- `Session`: id, agent (`claude-code` | `codex`), cwd, project nickname, state,
  last message summary, registered and last-seen times.
- `Ask`: id, session, kind (`question` | `permission` | `stop` | `notify`), text,
  options, risk (`low` | `high`), created and expiry times, status.
- `Answer`: ask id, decision or free text, channel (`voice` | `sms`), the owner's
  verbatim excerpt, call or message id, time.
- `CallRecord`: provider ids, asks covered, outcome (`answered` | `no-answer` |
  `failed` | `rejected`), duration, cost estimate.
- `Config`: owner number, PIN hash, quiet hours, rate limits, voice id, provider,
  tunnel URL, nicknames. Secrets live in the Keychain or a `0600` file, never in
  the config file.
- Hook payload fixtures for Claude Code and Codex `PermissionRequest` and `Stop`,
  copied from official docs with links, drive the adapter tests.

## 6. Voice and messaging

- **Default voice provider: ElevenLabs Agents** with its native Twilio
  integration. Outbound calls via `POST /v1/convai/twilio/outbound-call` with
  `agent_id`, `agent_phone_number_id`, `to_number` and dynamic variables. Server
  tools call the daemon's `/hooks/el/*` routes with a shared secret header.
  Interruptions on. Supports library voices and your own cloned voice (Starter
  plan). The agent definition (prompt, first message, voice, tools) lives in code
  and is applied by `hotline init`.
- **Persona:** short, casual sentences; says which agent and project is calling;
  reads options as numbers; repeats the decision back before ending; never
  invents an answer; takes any clear phrasing, reads every approval back in one
  short sentence and approves only on the owner's yes to it, and takes a no at
  once; asks once more if unclear ("is that a yes or a no?"), then says it
  will text instead and leaves the ask to the text fallback. Never goes quiet.
- **SMS: Twilio** with a Canadian number (no US 10DLC registration needed for
  Canadian recipients). Signature-validated inbound webhook.
- **Fallback (Tier 2):** Twilio ConversationRelay with the conversation loop on
  the Mac, for stock voices without ElevenLabs Agents.
- **Tunnel:** ngrok free static domain (recommended) or a Cloudflare named tunnel
  on a subdomain the owner controls. Quick tunnels change URL and break inbound calls.

## 7. Agent integration

| | Claude Code | Codex CLI |
| --- | --- | --- |
| MCP tools | `.mcp.json` / `claude mcp add`; raise per-server `timeout`; progress notifications avoid the idle timeout | `[mcp_servers.hotline]` in `config.toml`; raise `tool_timeout_sec` (default 60) |
| Permission approvals | `PermissionRequest` hook returns `decision.behavior` allow or deny | `PermissionRequest` hook, allow or deny with message |
| Away loop | `Stop` hook returns `decision: block` + `reason` | `Stop` hook, same shape, starts a continuation |
| Mid-turn instructions | Tier 2: channels (research preview) | Tier 2: app-server `turn/steer` |

`hotline install claude` and `hotline install codex` write these entries with a backup and a printed
diff, user-level or `--project`. Tests run it against temporary home directories.

## 8. Security, privacy and cost

- Owner-only numbers; PIN for inbound; PIN or text confirmation for high-risk
  approvals. Caller ID can be spoofed, which is why the PIN exists.
- Every public route verifies its signature or secret; replayed webhooks are
  rejected by id and timestamp.
- Redact secrets and long code before anything leaves the machine; numbers in logs
  show the last four digits only.
- **Reply judge (plan change, HL-09d, owner direction).** Approvals are
  interpreted naturally, not by phrase matching, with the least friction and the
  lowest cost, on the owner's existing plan rather than a new API key. When the
  owner answers an approval read-back with something the quick yes/no check
  cannot decide ("yeah, let's ship that one"), the owner's short reply, and only
  that (redacted, never the request or anything an agent wrote), goes to the
  owner's own agent provider for one narrow question: did they clearly agree?
  The daemon uses the first available of the Claude Code CLI on the owner's
  login (`claude -p`, a small model), the Codex CLI on the owner's login
  (`codex exec`), and an optional Anthropic API key. Each CLI run is isolated
  (empty temporary directory, no hooks, no MCP servers, no tools, nothing
  saved, and only the CLI's own login variables from the environment). A yes
  with a condition ("yes if the tests pass") or taken back is never an
  approval; errors and timeouts are "unclear". Nothing is sent until the owner
  chooses the judge: `hotline init` asks once (Enter is yes) or takes
  `--judge`, and an unset `judge.backend` sends nothing. With no backend, no
  choice, or `judge.backend: "off"`, such replies are texted instead. High-risk
  approvals still need the PIN or a confirming text.
- Rate limits (calls per hour and per day), quiet hours, batching, and a monthly
  cost estimate shown by `hotline doctor`.
- Expected cost for about 60 minutes of calls and 200 texts a month: roughly
  USD 10–15 (Twilio number, minutes and texts, ElevenLabs Starter, LLM).

## 9. Tickets

Each ticket becomes a GitHub issue titled `HL-xx: <title>` with labels `ticket`,
`tier-1` and its lane. One PR per ticket, `Closes #<issue>`. The autopilot may
split a ticket that grows beyond one reviewable PR into `HL-xxa/b` issues with the
same lane and dependencies. Lanes are in [team-plan.md](team-plan.md).

| ID | Title | Lane | Depends on | Done when |
| --- | --- | --- | --- | --- |
| HL-01 | Workspace foundation | build | — | pnpm workspace with `packages/core`, `packages/daemon`, `packages/providers`, `packages/agents`, `apps/cli`; strict TypeScript; Node from `.node-version`; exact pins and lockfile; Biome; Vitest; `build`, `test` and `typecheck` scripts; `scripts/ci/run.sh` stages pass on Ubuntu and macOS CI; README quickstart |
| HL-02 | Contracts and config | core | 01 | zod schemas from plan section 5; config loader and a secret store interface (Keychain via `security`, `0600` file fallback); Claude Code and Codex hook payload fixtures with source links; `docs/contracts.md` |
| HL-03 | Ask queue and call policy | core | 02 | Queue with priority, batching of concurrent asks into one call, dedupe, quiet hours to text, rate limits, no-pickup retry then text, expiry; pure with an injected clock; property tests that silence never yields approval |
| HL-04 | Daemon skeleton | daemon | 02 | Fastify on 127.0.0.1 with a per-install token for the agent API; separate public `/hooks/*` router; SQLite store for sessions, asks, answers, calls and audit; logs with redaction; `hotline daemon`; graceful shutdown |
| HL-05 | MCP server | agents | 04 | stdio MCP server with `ask_human`, `notify_human` and `check_inbox`; session registration; progress notifications while waiting; config snippets for Claude Code and Codex; tests through the MCP SDK client |
| HL-06 | Hook adapters | agents | 04 | `hotline hook <agent> <event>` (agents `claude`, `codex`; events `permission`, `stop`) read stdin and print each agent's documented output; away-mode state; `stop_hook_active` and continuation-cap loop guards; deny on silence; golden tests against the HL-02 fixtures |
| HL-07 | SMS provider | comms | 04 | Twilio send and inbound webhook with signature validation; owner-only; reply parsing (option numbers, yes/no, free text, `call me`, `status`, `stop`); fake provider; tests with fake numbers |
| HL-08 | ElevenLabs voice provider | comms | 04 | `VoiceProvider` interface; ElevenLabs Agents outbound-call client; agent definition as code; server-tool routes `submit_answer`, `verify_pin`, `get_status` and `send_instruction` with shared-secret auth; post-call webhook HMAC check; fake voice provider with scripted humans |
| HL-09 | Call orchestration | daemon | 03, 05, 07, 08 | Ask to call to answer to delivery; several asks in one call; no pickup to text to retry; permission approvals with risk classes and PIN or text confirmation for high risk; transcript excerpt stored with every decision |
| HL-10 | Inbound line | daemon | 09 | Owner calls in, gives the PIN, hears every session's status, and can queue an instruction delivered at that session's next ask or Stop hook; inbound `status` text; all other callers rejected |
| HL-11 | Installer and doctor | build | 05, 06 | `hotline init`, `hotline install <agent> [--project]` with backup and diff (tested on temp dirs only), `hotline away on` and `off`, `hotline doctor`, `hotline test-call`, `hotline voice list` and `set` |
| HL-12 | Scenario suite | eval | 09, 10 | Runner, fakes and scripted humans for every scenario in [eval.md](eval.md); prints `THRESHOLDS: PASS/FAIL` against `eval/thresholds.toml`; self-test proving an always-approve build fails |
| HL-13 | Security pass | daemon | 09, 10 | `docs/security.md` threat model; redaction tests for keys, tokens and `.env` lines; webhook replay protection; rate limits; audit that only `/hooks/*` is public; fuzz tests for reply parsing |
| HL-14 | Voice persona and choice | comms | 08 | Persona prompt per section 6; agent nicknames; voice selection docs, including cloning your own voice |
| HL-15 | Packaging and docs | build | 11 | `pnpm run package` builds the `hotline` CLI into `dist/` (not published); README with setup, costs, limits and security model; demo script for a screen recording |
| HL-16 | Live-call protocol | eval | 11, 12 | [live-check.md](live-check.md) finalized with exact steps; the live run itself is `needs-human` |

Parallel start: after HL-01, HL-02 runs alone; then HL-03 and HL-04 together;
then HL-05, HL-06, HL-07 and HL-08 together.

## 10. Capability limits

Not claimed in Tier 1: recognizing your voice biometrically (caller ID plus PIN
only); interrupting an agent in the middle of a turn; working while the Mac is
asleep or offline; guaranteed SMS delivery; reading code aloud; agents other than
Claude Code and Codex; more than one human.

## 11. Verification strategy and acceptance checklist

Tier 1 is accepted when:

- [ ] All `tier-1` issues are closed by merged PRs or labeled `needs-human` with
      the exact remaining human step.
- [ ] `check` is green on the latest `main` commit (Ubuntu and macOS).
- [ ] `scripts/ci/run.sh eval --local` prints `THRESHOLDS: PASS` on the dev Mac.
- [ ] A real Claude Code session asks a question by phone and gets the spoken
      answer (human, [live-check.md](live-check.md)).
- [ ] A real Codex session gets a permission approved and another denied by voice
      (human).
- [ ] An inbound call with the PIN reads status; a call from another number is
      rejected (human).

## 12. Open questions

Autopilot resolves these with the recommended default, records the decision and
evidence in `docs/agent-log.md`, and revisits only on new evidence.

1. Voice provider: ElevenLabs Agents (recommended, cloned voice) vs Twilio
   ConversationRelay with a local loop (Tier 2 fallback).
2. Stop hook waiting: synchronous wait with a long hook timeout for both agents
   (recommended for Tier 1) vs Claude Code `async` + `asyncRewake` (evaluate later).
3. Mid-turn instructions: deliver at the next ask or Stop hook (Tier 1) vs Claude
   Code channels and Codex app-server steering (Tier 2).
4. Tunnel: ngrok static domain (recommended) vs Cloudflare named tunnel.
5. Secret storage: macOS Keychain through `security` (recommended) vs `0600` file.
6. High-risk permission classes: deleting files, `git push`, network installs,
   writes outside the project, anything touching credentials (recommended set).
7. Session nicknames: agent + repo folder name, overridable in config.
8. License: **decided, MIT** (the `LICENSE` file).

## 13. Tier 2 (after Tier 1 acceptance only)

Claude Code channel integration (mid-turn instructions and its native permission
relay), Codex app-server steering, ConversationRelay provider, Telegram or
iMessage, speaker verification, LiveKit provider, Cursor and OpenCode adapters,
and a hosted relay so the Mac does not need a tunnel.
