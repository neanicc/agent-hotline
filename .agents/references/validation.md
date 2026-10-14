# Agent Hotline validation routes

Use [the plan](../../docs/plan.md#11-verification-strategy-and-acceptance-checklist),
[the scenario suite](../../docs/eval.md) and [AGENTS.md](../../AGENTS.md).

## Select checks from the current repository

Inspect `package.json`, `scripts/ci/run.sh` and `eval/` before naming a command.
Before HL-01 most stages print a notice and do nothing.

| Changed surface | Applicable checks |
| --- | --- |
| Docs/skills/agents | `python3 scripts/check_agent_files.py`, `git diff --check`; inspect new files |
| `packages/core` | Focused Vitest (`pnpm --filter @hotline/core test`), typecheck, then `scripts/ci/run.sh test` |
| Daemon routes, orchestration, security | Above plus `scripts/ci/run.sh eval`; any webhook change needs signature tests for good and bad requests |
| MCP server or hook adapters | Above plus golden tests against the Claude Code and Codex fixtures; output must match each agent's documented JSON exactly |
| Providers | Contract tests against the fake; request-shape tests for the real client with a mocked HTTP layer; never a real call |
| Installer | Tests against temporary home directories only; never the real `~/.claude` or `~/.codex` |
| Dependencies, lockfile, workspace config | Clean `scripts/ci/run.sh setup` with `--frozen-lockfile`, then build and test |
| GitHub workflow (human-owned) | actionlint and the stages the workflow invokes |
| Whole project, PR signoff, autopilot acceptance | `setup`, `build`, `test`, `eval --local` on the dev Mac |

Reuse passing results when inputs are unchanged. Record the tested commit or
label an uncommitted worktree. Failed, skipped or empty suites are not passes.
Never weaken assertions, timeouts, scenarios or thresholds to get green results.

## Evidence kinds

- **Automated:** typecheck, unit and integration tests, workflow and doc checks.
- **Scenario suite:** end-to-end runs against fake providers and scripted humans,
  scored against `eval/thresholds.toml`.
- **Real agent integration:** Claude Code and Codex on the dev Mac talking to the
  daemon with fake providers. Shows the hook and MCP wiring works with the real CLIs.
- **Live call:** a real phone, real Twilio and ElevenLabs, done by the human per
  [the live check](../../docs/live-check.md).

No fake result proves a real call works. Agents never place real calls or texts.
