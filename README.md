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

> Status: pre-alpha. The workspace builds and tests, but the `hotline` command
> only prints its version and help so far. Setup for real calls arrives with
> later tickets ([plan section 9](docs/plan.md#9-tickets)).

## Quickstart (development)

You need Node 22 (the version in [.node-version](.node-version)) and Corepack,
which provides the pinned pnpm from `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build        # tsc project build into each package's dist/
pnpm run typecheck    # build plus a typecheck of every test file
pnpm run test         # Vitest, all packages
pnpm run lint         # Biome lint and format check (`pnpm run format` fixes)
pnpm run hotline --version   # runs the built CLI: "hotline 0.0.0"
pnpm run hotline daemon --help   # the daemon; see docs/daemon.md
pnpm run hotline mcp --help      # the MCP server agents start; see docs/mcp.md
pnpm run hotline hook --help     # the permission and Stop hooks; see docs/hooks.md
pnpm run hotline doctor          # check the setup; see docs/install.md
```

Setting Hotline up on your Mac (`hotline init`, `voice apply`, `install`,
`doctor`, `test-call`) is in [docs/install.md](docs/install.md).

`pnpm --filter @hotline/core test` runs one package's tests. CI calls the same
steps through [scripts/ci/run.sh](scripts/ci/run.sh) (`setup`, `build`, `test`,
`package`, `eval`); see [docs/ci.md](docs/ci.md). Nothing in the test suite
touches a real network, phone, Twilio or ElevenLabs.

| Path | Holds |
| --- | --- |
| `packages/core` | Contracts, config, ask queue, call policy, answer parsing (pure) |
| `packages/daemon` | Local agent API, webhook routes, call orchestration, store, audit log |
| `packages/providers` | Voice and SMS provider interfaces, real clients and fakes |
| `packages/agents` | MCP server and hook adapters for Claude Code and Codex |
| `apps/cli` | The `hotline` command |

## How it works

1. A small daemon runs on your Mac. Agents reach it on localhost through an MCP
   server (`ask_human`, `notify_human`, `check_inbox`) and through their own
   permission and stop hooks.
2. When an agent needs you, the daemon decides whether to call, text, or wait and
   bundle several agents' questions into one call.
3. ElevenLabs Agents places the call through a Twilio number and holds the
   conversation. When you decide, the voice agent sends your answer and your exact
   words back to the daemon.
4. The daemon hands the answer to the waiting agent: a tool result, an allow or
   deny for a permission prompt, or the next instruction in "away mode".

Details: [docs/plan.md](docs/plan.md). What the scenario suite checks:
[docs/eval.md](docs/eval.md) and [eval/thresholds.toml](eval/thresholds.toml).

## Security model

A phone line that can steer coding agents is a remote control for your machine,
so the rules are strict:

- Only your number can answer or call in, and calling in needs your PIN.
- Every request from Twilio and ElevenLabs is signature-checked.
- Silence, a dropped call or an unclear answer is a **no**. Nothing is
  approved by default, and text written by an agent can never approve itself.
- Risky approvals (deleting files, `git push`, installs) need your PIN or a
  confirming text.
- Only short summaries leave your Mac, with secrets redacted. Transcripts and
  logs stay local.

## Costs

Roughly USD 10–15 a month for light use: a Twilio number plus per-minute and
per-text charges, and the ElevenLabs Starter plan (needed for a cloned voice).

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
