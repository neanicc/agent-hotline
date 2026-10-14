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

Pick any ElevenLabs voice for the caller, including a clone of your own.

> Status: pre-alpha. The repository currently holds the plan, agent workflows,
> CI structure and scenario targets. Install instructions arrive with HL-01.

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
