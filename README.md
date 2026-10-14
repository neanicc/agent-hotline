# Agent Hotline

Your coding agents call you on the phone when they need you.

Start Claude Code or Codex on a task and walk away. When the agent has a question,
needs a command approved, finishes, or gets stuck, your phone rings:

> "Hey, it's Claude in agent-hotline. Tests pass, but the Twilio client needs a
> retry policy. Want exponential backoff, or fail fast and text you?"

You answer out loud and the agent keeps going with your answer. If you don't pick
up, or it's quiet hours, you get a text instead and can reply to that. You can
also call the number yourself, give your PIN, hear what every agent is doing, and
give one of them a new instruction.

Pick any ElevenLabs voice for the caller, including a clone of your own
([docs/voice.md](docs/voice.md)).

> Status: pre-alpha, Tier 1 in progress. Outbound calls, texts, permission
> approvals, away mode, the installer and packaging are built and tested against
> fake providers. The inbound status line (HL-10), the scenario suite (HL-12) and
> the security pass (HL-13) are still open, and no live call has been recorded
> yet ([docs/live-check.md](docs/live-check.md)). Progress:
> [plan section 9](docs/plan.md#9-tickets).

## What you need

- A Mac that stays awake while you are away, with Node 22 (see
  [.node-version](.node-version)) and Corepack.
- Claude Code and/or Codex CLI.
- For real calls and texts, accounts **you** set up and pay for: Twilio (upgraded
  from trial, with a Canadian number), ElevenLabs (Starter plan or above, for
  Agents and voice cloning), and a tunnel with a fixed URL (an ngrok free static
  domain, or a Cloudflare named tunnel). Hotline never creates these accounts.

You can try everything except the phone itself with the fake providers: nothing
rings, nothing is sent, and no account is needed. That is also all CI and the
test suite ever use. Nothing in this repository, its tests or its CI places a real
call or text, or holds a real credential.

## Setup

Hotline is not published to npm. Build the `hotline` command from a checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run package          # bundles the CLI into dist/hotline (gitignored)
ln -s "$PWD/dist/hotline/bin/hotline" ~/.local/bin/hotline   # any folder on your PATH
hotline --version
```

`dist/hotline` runs with plain Node and needs no `node_modules`; you can also
copy the folder elsewhere and link its `bin/hotline`. If `hotline` is not on the
`PATH` your agents start with, give `hotline install` the launcher's absolute path
with `--command`.

Then, in order ([docs/install.md](docs/install.md) has every flag and check).
`init` asks for your number, PIN and credentials; the tunnel URL, the Twilio
number and its ElevenLabs phone-number id (**Phone Numbers** in ElevenLabs) have
no prompt, so pass them as flags:

```sh
hotline init --public-url https://<your-tunnel-domain> \
  --sms-from <your Twilio number> --agent-phone-number-id <ElevenLabs id>
hotline voice apply             # create the ElevenLabs agent and its tools
hotline install claude          # and/or: hotline install codex (backup + diff)
hotline daemon                  # in its own terminal; start your tunnel too
hotline doctor                  # until there are no FAIL lines
hotline test-call               # rings your phone once
hotline away on                 # let the hooks phone you
```

To try it without accounts, run `hotline init --voice-provider fake --sms-provider fake`
and skip `voice apply`; `test-call` then rings nothing. A walkthrough for a screen
recording is in [docs/demo.md](docs/demo.md).

## How it works

1. A small daemon runs on your Mac. Agents reach it on 127.0.0.1 through an MCP
   server (`ask_human`, `notify_human`, `check_inbox`; [docs/mcp.md](docs/mcp.md))
   and through their own `PermissionRequest` and `Stop` hooks
   ([docs/hooks.md](docs/hooks.md)).
2. When an agent needs you, the daemon decides whether to call, text, or wait and
   bundle several agents' asks into one call ([docs/daemon.md](docs/daemon.md)).
3. ElevenLabs Agents places the call through your Twilio number and holds the
   conversation. When you decide, the voice agent sends your answer and your exact
   words back to the daemon through the tunnel.
4. The daemon hands the answer to the waiting agent: a tool result, an allow or
   deny for a permission prompt, or the next instruction in away mode.

Records and config: [docs/contracts.md](docs/contracts.md). Design and tickets:
[docs/plan.md](docs/plan.md).

## Security model

A phone line that can steer coding agents is a remote control for your machine,
so the rules are strict:

- **Owner only.** Hotline calls and texts only your number. Calls and texts from
  any other number get a generic rejection and learn nothing. Calling in needs
  your PIN before any status is read; caller ID can be spoofed, the PIN cannot.
- **Every webhook is verified.** Twilio requests are signature-checked,
  ElevenLabs tool calls carry a shared secret, and post-call webhooks are
  HMAC-checked. Anything else gets 403. Only `/hooks/*` is reachable through the
  tunnel; the agent API listens on 127.0.0.1 with a per-install token.
- **Decisions come from your words.** An answer counts only when it comes from
  you on the call or by text, with the transcript excerpt stored, and the daemon
  checks it against your own words. Before approving anything, the voice agent
  reads the request back in one short sentence and approves only on your yes to
  that (a rule of its prompt; [voice.md](docs/voice.md#the-persona)). Text
  written by agents (questions, command previews) is treated as data and can
  never approve itself.
- **Silence is not consent.** No pickup, a dropped call, an unclear answer or a
  timeout returns "no answer": permission requests are denied and questions come
  back unanswered. Nothing is approved by default.
- **PIN for high risk.** Deleting files, `git push`, network installs, writes
  outside the project and anything touching credentials need your PIN on the call
  or a confirming text ([risk classes](docs/hooks.md#risk-classes-plan-question-6)).
- **Redaction.** Only short summaries go to Twilio and ElevenLabs, with API keys,
  tokens, private keys, `.env` values and passwords redacted first. Logs show
  phone numbers as their last four digits.
- **Local first.** Config, the PIN (stored only as a scrypt hash), transcripts and
  the audit log stay on your Mac. Credentials live in the macOS Keychain or a
  `0600` file, never in the config or the repository.
- **Bounded noise.** Rate limits, quiet hours and away-mode loop guards are
  always on, and asks that arrive close together share one call.

Known limits, accepted for Tier 1:

- **Same-user processes are trusted.** Any process running as you, coding
  agents included, can read Hotline's Keychain items, `0600` files and local
  database. With the Twilio or ElevenLabs secrets and a pending request's
  confirmation code, such a process could forge a signed webhook that looks like
  your reply and approve a request without your voice or PIN, or place calls and
  texts on your account. The rules above protect against other people and other
  accounts, not against code running as you. Use narrowly scoped keys
  ([contracts.md](docs/contracts.md#secrets-secretsts)).
- **One install token for every agent.** All local sessions share the agent API
  token, so one session can read or cancel another's asks. No agent-API route can
  answer an ask.
- **The risk classifier only decides proof strength.** It picks PIN-or-text versus
  a spoken yes; it never decides whether approval is needed. It reads command text
  and is not a sandbox; every request still needs your approval
  ([hooks.md](docs/hooks.md#risk-classes-plan-question-6)).

## Limits

Not claimed in Tier 1 ([plan section 10](docs/plan.md#10-capability-limits)):
recognizing your voice (caller ID plus PIN only); interrupting an agent in the
middle of a turn (instructions arrive at its next ask or Stop hook); working while
the Mac is asleep or offline; guaranteed text delivery; reading code aloud; agents
other than Claude Code and Codex; more than one human.

## Costs

Planning estimate ([plan section 8](docs/plan.md#8-security-privacy-and-cost)):
roughly **USD 10–15 a month** for about 60 minutes of calls and 200 texts; the
itemised rates below land at about $12–14. They are assumptions taken from the
public Twilio (Canada) and ElevenLabs pricing pages on 2026-10-14 (in dollars as
listed), not quotes; check current pricing before you sign up.

| Item | Assumed rate | 60 min + 200 texts |
| --- | --- | --- |
| Twilio Canadian local number | $1.15 / month | $1.15 |
| Twilio call leg to a Canadian number | $0.014 / min | $0.84 |
| Twilio texts (Canada), plus carrier fees | $0.0083 + about $0.007 / segment | about $3 |
| ElevenLabs Starter (Agents, voice cloning) | $6 / month, 75 call minutes included, then $0.08 / min | $6 |
| LLM for the voice agent (billed by ElevenLabs) | depends on the model | about $1–3 |
| **Total** | | **about $12–14** |

Calls you place to the hotline add Twilio's inbound rate. Rate limits (4 calls an
hour and 20 a day by default) cap the worst case. `hotline doctor` does not show a
cost estimate yet (HL-11b).

## Development

```sh
pnpm run build        # tsc project build into each package's dist/
pnpm run typecheck    # build plus a typecheck of every test file
pnpm run test         # Vitest, all packages, fakes only
pnpm run lint         # Biome (`pnpm run format` fixes)
pnpm run package      # dist/hotline; scripts/ci/run.sh package also runs it from a temp folder
pnpm run hotline --version   # the unbundled CLI from apps/cli/dist
```

CI calls the same steps through [scripts/ci/run.sh](scripts/ci/run.sh) (`setup`,
`build`, `test`, `package`, `eval`); see [docs/ci.md](docs/ci.md) and, for the
scenario suite, [docs/eval.md](docs/eval.md).

| Path | Holds |
| --- | --- |
| `packages/core` | Contracts, config, ask queue, call policy, answer parsing (pure) |
| `packages/daemon` | Local agent API, webhook routes, call orchestration, store, audit log |
| `packages/providers` | Voice and SMS provider interfaces, real clients and fakes |
| `packages/agents` | MCP server and hook adapters for Claude Code and Codex |
| `apps/cli` | The `hotline` command |

## How this repository is built

Most code here is written by Claude Code agents working through GitHub issues and
pull requests. Each PR gets CI on Linux and macOS, a scenario suite that runs
every flow against a fake phone, a Claude staff review against
[AGENTS.md](AGENTS.md), and a Greptile review. A merge gate decides what lands; a
human owns the thresholds, CI workflows and every real phone call. See
[docs/autopilot.md](docs/autopilot.md) for the workflow and
[docs/agent-log.md](docs/agent-log.md) for the decision history.

## License

MIT. See [LICENSE](LICENSE).
