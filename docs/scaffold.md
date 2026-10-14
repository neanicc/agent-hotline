# Repository foundation

The scaffold follows the structure of the Trail/teachAR repository: one agent
guide (`AGENTS.md`, imported by `CLAUDE.md`), canonical skills in
`.agents/skills/workflow/` with relative discovery links for Claude Code and
Cursor, a validation reference, a PR template, an append-only agent log, and a
plan with dependency-ordered tickets. The autopilot pieces and their hardening
come from the Stream Privacy Guard setup.

Additions for unattended work:

| Piece | Purpose |
| --- | --- |
| `hl-autopilot`, `hl-ticket` skills | Conductor loop and the one-ticket playbook |
| `.claude/agents/` | Implementer and babysitter (isolated worktrees), read-only reviewer, researcher |
| `.claude/settings.json` | A short allow list for commands agents cannot change; deny rules for pushes to `main`, force pushes, admin merges, approval labels, repo settings, secrets and human-owned files; the merge hook |
| `scripts/agent/pr_status.py`, `review_threads.py` | Deterministic merge-gate signals and review-thread handling |
| `scripts/bootstrap/github_setup.py` | Labels, ruleset, status issue and ticket issues, idempotent |
| `.github/workflows/claude-review.yml`, `.greptile/config.json` | Two independent reviewers on every PR |
| `eval/thresholds.toml` | Human-owned acceptance targets: every scenario must pass |

## Where each safety rule is enforced

| Rule | Enforced by |
| --- | --- |
| Nothing lands on `main` without a PR and a green `check` from GitHub Actions | GitHub ruleset (server side, no bypass actors) |
| Review threads resolved before merge | GitHub ruleset |
| Agents cannot change CI | Merge gate refuses PRs touching `.github/` + Edit deny rules. Optional hard version: remove the `gh` token's `workflow` scope after bootstrap so GitHub rejects such pushes |
| Human-owned paths need a human | CI `Protected paths` job (renames and nested agent files included) + Edit deny rules + merge gate |
| Merge only with a bot-posted staff review of at least 85, no P0/P1, for the exact head | `.claude/hooks/guard_merge.py` runs `pr_status.py` before any `gh pr merge` and fails closed; subagents can never merge |
| No force push, `--admin` merge, approval label, or credential changes | `.claude/settings.json` deny rules + auto-mode classifier + AGENTS.md |
| Thresholds unchanged by agents | Deny rules + protected-paths CI job |
| No real calls or texts during development | AGENTS.md, no credentials on the machine or in CI, fake providers by design, Greptile rule against real network in tests |

Remaining gap: every agent uses your GitHub account, and permission rules match
command text, so code an agent writes and runs could still call the GitHub API
directly (for example, to merge a PR whose `check` passed but whose review did
not). The ruleset still requires green CI and resolved threads. For a hard
boundary, run the autopilot with a separate GitHub account or a fine-grained
token that has no admin rights. Review merged PRs periodically. Likewise, do not
put Twilio or ElevenLabs credentials on the machine while the autopilot runs.

## Verification of the scaffold

`python3 scripts/check_agent_files.py`, actionlint over `.github/workflows`, and
`bash scripts/ci/run.sh build` (notice only) pass on the initial commit. These
show structure only; no product behavior exists yet.
