# Hook payload fixtures

Stdin payloads Claude Code and Codex send to `PermissionRequest` and `Stop`
command hooks, and the stdout JSON Hotline prints back. HL-06's adapter golden
tests use them; `../../hook-fixtures.test.ts` checks every file against the
`@hotline/core` hook schemas and, for Codex, against Codex's own published JSON
schemas.

All data is fake: the session ids are all-zero UUIDs, paths are under
`/Users/example`, and there are no phone numbers, tokens or real transcripts.

## Sources

Checked 2026-10-13. Neither agent's docs page carries a version or date, so
compare these fixtures with the installed CLI before trusting them for a release
(`claude --version`, `codex --version`).

### Claude Code

Page: <https://code.claude.com/docs/en/hooks>

| Fixture | Source section | Notes |
| --- | --- | --- |
| `claude-code/permission-request.input.json` | "PermissionRequest input" | The documented example with fake ids and paths. Keeps `permission_suggestions`, which Hotline must never apply |
| `claude-code/permission-request.allow.output.json` | "PermissionRequest decision control" | The documented allow shape without `updatedInput`, which Hotline never sends |
| `claude-code/permission-request.deny.output.json` | "PermissionRequest decision control" | `behavior: "deny"` with `message`; the page documents the fields but shows no deny example |
| `claude-code/stop.input.json` | "Stop input" | The documented example with `stop_hook_active: false` and empty `background_tasks` and `session_crons` |
| `claude-code/stop.continued.input.json` | "Stop input" | The documented example (`stop_hook_active: true`, one background task, one cron) with fake ids and paths |
| `claude-code/stop.block.output.json` | "Stop decision control" | `{"decision": "block", "reason": ...}`; the reason becomes Claude's next instruction |

Documented behavior the adapters depend on:

- `PermissionRequest` exit code 2 is not honored; the permission flow continues as
  if the hook had not run. Deny through the decision object.
- `Stop`: printing nothing and exiting 0 lets Claude stop. Claude Code caps
  consecutive Stop-hook continuations at 8 unless `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
  overrides it; Hotline's own cap (`policy.maxConsecutiveContinuations`) defaults lower.
- Command hooks time out after 600 seconds unless the hook's `timeout` says otherwise.

### Codex

Page: <https://developers.openai.com/codex/hooks>

Schemas: [openai/codex `codex-rs/hooks/schema/generated`](https://github.com/openai/codex/tree/e444aa99d76beeb8b5b0610b793c0cdefe58da58/codex-rs/hooks/schema/generated)
at commit `e444aa99d76beeb8b5b0610b793c0cdefe58da58` (2026-09-10). The four
schemas Hotline uses are copied unchanged into `codex/schema/` (Apache-2.0,
copyright OpenAI). The docs page shows no full example payloads, so the Codex
input fixtures are built from these schemas, not captured from a real run.

| Fixture | Schema | Notes |
| --- | --- | --- |
| `codex/permission-request.input.json` | `permission-request.command.input` | `Bash` with `tool_input.command` and `description`, as the docs describe |
| `codex/permission-request.apply-patch.input.json` | `permission-request.command.input` | `apply_patch`, null `transcript_path` and null `description` |
| `codex/permission-request.allow.output.json` | `permission-request.command.output` | `decision.behavior: "allow"` |
| `codex/permission-request.deny.output.json` | `permission-request.command.output` | `behavior: "deny"` with `message`. Never `interrupt`, `updatedInput` or `updatedPermissions`: Codex fails closed on them |
| `codex/stop.input.json` | `stop.command.input` | `stop_hook_active: false` |
| `codex/stop.continued.input.json` | `stop.command.input` | `stop_hook_active: true`, null `transcript_path` and `last_assistant_message` |
| `codex/stop.block.output.json` | `stop.command.output` | Codex turns `reason` into a continuation prompt |

Documented behavior the adapters depend on:

- `PermissionRequest` runs only when Codex is about to ask for approval. With
  several hooks, any deny wins; if none decides, the normal approval prompt runs.
- `Stop` must print JSON or nothing; plain text is invalid. `continue: false` from
  any Stop hook wins over a continuation.
- Hooks are on by default (`[features] hooks = false` turns them off;
  `codex_hooks` is a deprecated alias). Non-managed hooks must be trusted with
  `/hooks` before they run. Hooks time out after 600 seconds by default.
