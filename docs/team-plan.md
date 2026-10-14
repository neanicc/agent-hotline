# Lanes and file ownership

Parallel agents (or people) work in lanes so two PRs rarely edit the same files.
This assigns boundaries; it does not authorize delegation by itself. Each ticket
issue carries one lane label.

| Lane label | Owns | Coordinates with |
| --- | --- | --- |
| `lane:build` | Root `package.json`, `pnpm-workspace.yaml`, lockfile, `tsconfig*`, Biome config, `scripts/ci/run.sh`, `apps/cli` (installer, doctor), packaging | Everyone: shared config changes go in their own small PR |
| `lane:core` | `packages/core` (contracts, config, queue, policy, parsing) | Everyone (contracts) |
| `lane:agents` | `packages/agents` (MCP server, hook adapters), hook fixtures | core, daemon |
| `lane:comms` | `packages/providers` (ElevenLabs, Twilio, fakes), persona prompt | daemon |
| `lane:daemon` | `packages/daemon` (server, routes, orchestration, store, security) | core, comms, agents |
| `lane:eval` | `eval/` except `thresholds.toml`, scenario runner and scripted humans, `docs/live-check.md` | everyone |

Rules for parallel work:

- At most one open PR per lane at a time unless the files are disjoint.
- Contract changes in `packages/core` go in a dedicated PR that updates every
  consumer, fixture and `docs/contracts.md` together.
- Lockfile conflicts: regenerate with the pinned pnpm after resolving
  `package.json` intent; never hand-merge the lockfile.
- `docs/agent-log.md` is append-only. Add your entry at the end of the file;
  resolve conflicts by keeping both entries in merge order.
- Human-owned: `eval/thresholds.toml`, `.github/**`, `.claude/**`, `.agents/**`,
  `.greptile/**`, `scripts/agent/**`, `scripts/bootstrap/**`, `AGENTS.md`,
  `CLAUDE.md`, `LICENSE`.
