# Pull request checks

[Check](../.github/workflows/check.yml) runs on every pull request (including
label changes), pushes to `main`, merge queues and manual dispatch. New commits
cancel older runs for the same PR. The repository ruleset requires the
aggregate `check` job.

| Job | What it verifies |
| --- | --- |
| Agent files and docs | `scripts/check_agent_files.py`: skill frontmatter, discovery links, agent definitions, Markdown links and anchors, config files parse |
| Workflow validation | actionlint 1.7.12 (checksum-verified) over all workflows |
| Protected paths | A PR that changes (or renames) a human-owned path fails until a human adds the `human-approved` label: `eval/thresholds.toml`, `.github/**`, `.claude/**`, `.agents/**`, `.greptile/**`, `scripts/agent/**`, `scripts/bootstrap/**`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, and nested `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agents/` |
| Build and test | `scripts/ci/run.sh setup`, `build`, `test`, `package` on Ubuntu 24.04 and macOS 15 with Node from `.node-version`; uploads `package-<os>` from `dist/` |
| Scenario suite | `scripts/ci/run.sh eval`: every flow end to end against fake providers and scripted humans, scored against `eval/thresholds.toml`; uploads `eval-report` |
| `check` | All of the above succeeded; failures, cancellations and skips cannot pass |

Workflows are human-owned. Agents change what CI does by editing
`scripts/ci/run.sh` (lane:build), which every stage calls. Since HL-01, `setup`
runs `pnpm install --frozen-lockfile` with the pnpm pinned in `package.json`;
`build` runs Biome (`pnpm run lint`), `tsc -b`, the test typecheck and a smoke
run of the built CLI; `test` runs Vitest across every package. `package` (HL-15)
runs `pnpm run package`, which bundles the CLI with esbuild into `dist/hotline`
(uploaded as `package-<os>`), then `scripts/ci/check-package.mjs`: it copies the
bundle to a temporary folder outside the workspace, so a dependency left out of
the bundle cannot be found in `node_modules`, and runs it through a symlinked
launcher: `--version` (must match `apps/cli/package.json`), `--help`, and with
fake providers in a temporary home, `init`, `install claude` and `install codex`,
`away status`, the daemon, `doctor` against it, an MCP `initialize` and
`tools/list`, a Stop hook outside away mode, a permission hook in away mode
that must deny when nobody answers, and a clean SIGTERM shutdown. The scenario
stage (HL-12) builds the tree, then runs every scenario in
[eval.md](eval.md) and scores it against `eval/thresholds.toml`; it
fails unless the runner prints `THRESHOLDS: PASS`.

CI has no Twilio or ElevenLabs credentials and makes no real calls or texts.
Action references are pinned to commit SHAs.

## Reviews on every PR

- [Claude staff review](../.github/workflows/claude-review.yml) runs the
  `hl-staff-review` skill on each non-draft PR push and posts one comment
  starting with a machine-readable `HL-REVIEW:` line. It needs the
  `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`claude setup-token`) and the
  Claude GitHub App. It uses the token owner's Claude subscription. The reviewer
  runs from the base commit and reads the PR only as a git ref, so a PR cannot
  change the reviewer's own instructions.
- Greptile reviews each PR when it opens, configured by
  [.greptile/config.json](../.greptile/config.json). To re-review on every push,
  change `autoReview` to `["open", "push"]` (uses more of the Greptile quota).
- Branch rules require the `check` job from GitHub Actions and resolved review
  threads before merge; there are no bypass actors.
- Only reviews posted by the workflow's bot count for the autopilot gate. Every
  local agent uses the owner's GitHub credentials, so the owner's account is not
  trusted as a reviewer.

`scripts/agent/pr_status.py <pr>` summarizes all of these for one PR and computes
the mechanical part of the autopilot merge gate.

## Reproduce locally

```sh
python3 scripts/check_agent_files.py
bash scripts/ci/run.sh setup && bash scripts/ci/run.sh build && bash scripts/ci/run.sh test
bash scripts/ci/run.sh eval            # CI mode
bash scripts/ci/run.sh eval --local    # acceptance gate
actionlint                             # needs actionlint installed
```

Green CI shows behavior against fakes only. A real call needs the
[live check](live-check.md).
