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

Rechecked 2026-10-14 for HL-06 against the installed CLIs, offline and without
starting a session (nothing called a model API):

- **Codex 0.146.0** (`codex-cli 0.146.0`, darwin-arm64): the binary embeds the
  generated hook schemas. The four Hotline uses, extracted by their `title` and
  compared as parsed JSON, are identical to the copies in `codex/schema/`.
- **Claude Code 2.1.299**: the zod schemas in the installed bundle match the
  fixtures. `Stop` input has `stop_hook_active`, optional `last_assistant_message`,
  `background_tasks` and `session_crons`. `PermissionRequest` input has
  `tool_name`, `tool_input` and optional `permission_suggestions`. The
  `PermissionRequest` output decision is `allow` (optional `updatedInput`,
  `updatedPermissions`) or `deny` (optional `message`, `interrupt`).
  Claude Code has added optional input fields since the docs snapshot
  (`prompt_id`, `agent_id`, `agent_type`, `mcp_server`); the loose input schemas
  keep them, and Hotline does not use them. The Stop-hook block cap is still 8
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

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
| `claude-code/permission-request.bash-background.input.json` | "PreToolUse input" (Bash) | HL-06b. The documented Bash `tool_input` (`command`, `description`, `timeout`, `run_in_background`) with `run_in_background: true`, in the PermissionRequest envelope |
| `claude-code/permission-request.bash-unsandboxed.input.json` | Claude Code 2.1.299 Bash input schema | HL-06b. `dangerouslyDisableSandbox: true`, a field the installed bundle's Bash schema has but the docs table does not list |

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
| `codex/permission-request.network-access.input.json` | `permission-request.command.input` | HL-06b. A managed-network approval: Codex sends it as `Bash` with the command and `description: "network-access <host>"` (`ApprovalAction::NetworkAccess` in `codex-rs/core/src/tools/approvals.rs`) |

### Shell and file tool input fields (HL-06b)

Checked 2026-10-14, to make every field that changes what runs high risk
(`actionFields` in `packages/core/src/permission-risk.ts`, docs/hooks.md "What
is judged is what runs"):

- **Claude Code docs** (<https://code.claude.com/docs/en/hooks>, "PreToolUse
  input"): Bash `command`, `description`, `timeout`, `run_in_background`;
  Write `file_path`, `content`; Edit `file_path`, `old_string`, `new_string`,
  `replace_all`; Read `file_path`, `offset`, `limit`; Glob `pattern`, `path`;
  Grep `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline`.
  "PermissionRequest input" says the hook gets `tool_name` and `tool_input` like
  PreToolUse.
- **Claude Code 2.1.299 bundle** (the zod input schemas, read offline): Bash
  also has `dangerouslyDisableSandbox`, `allowed_domains` (when the sandbox's
  network allowlist is on), an internal `_simulatedSedEdit` (left out of the
  model's schema), and an optional field naming another machine to run on in
  some builds. NotebookEdit has `notebook_path`, `cell_id`, `new_source`,
  `cell_type`, `edit_mode`.
- **Codex** at `7eed30ad1beaebc20b7d848ce9ee887525a379b0`: the
  `PermissionRequest` hook's `tool_input` for a shell approval holds only
  `command` (the command string) and `description` (the model's justification,
  or `network-access <host>`), built by `PermissionRequestPayload::bash`
  (`codex-rs/core/src/tools/sandboxing.rs`, `approvals.rs`). The command's
  `workdir` and `sandbox_permissions` are not sent, and the hook's `cwd` is the
  turn's folder (`tool_hook_cwd` in `hook_runtime.rs`). Patches send
  `{"command": <patch>}`; MCP tools send their arguments. The tool arguments
  that can change where or how a command runs: `exec_command` (`ExecCommandArgs`
  in `core/src/tools/handlers/unified_exec.rs`) has `workdir`,
  `environment_id`, `shell`, `login`, `tty`, `sandbox_permissions`,
  `additional_permissions`, `justification` and `prefix_rule`; `local_shell`
  (`LocalShellExecAction` in `protocol/src/models.rs`) has an argv `command`,
  `working_directory`, `env` and `user`; the older `shell` tool had an argv
  `command`, `workdir` and `with_escalated_permissions`.

Documented behavior the adapters depend on:

- `PermissionRequest` runs only when Codex is about to ask for approval. With
  several hooks, any deny wins; if none decides, the normal approval prompt runs.
- `Stop` must print JSON or nothing; plain text is invalid. `continue: false` from
  any Stop hook wins over a continuation.
- Hooks are on by default (`[features] hooks = false` turns them off;
  `codex_hooks` is a deprecated alias). Non-managed hooks must be trusted with
  `/hooks` before they run. Hooks time out after 600 seconds by default.
