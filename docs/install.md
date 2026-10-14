# Setting up Hotline

The setup commands (`apps/cli`, HL-11): `hotline init`, `hotline voice`,
`hotline install`, `hotline away`, `hotline doctor` and `hotline test-call`.
Until packaging (HL-15) puts `hotline` on your `PATH`, run them as
`pnpm run hotline <command>` from the repository, and give `hotline install` a
`--command` path: an executable wrapper script such as
`#!/bin/sh` / `exec node /absolute/path/to/apps/cli/dist/main.js "$@"`.

In order:

```sh
hotline init                    # config, PIN and credentials
hotline voice apply             # create the ElevenLabs agent and its tools
hotline install claude          # and/or: hotline install codex
hotline daemon                  # in its own terminal
hotline doctor                  # until there are no FAIL lines
hotline test-call               # rings your phone once
hotline away on                 # let the hooks phone you
```

## `hotline init`

Creates the hotline home (`$HOTLINE_HOME`, else `~/.hotline`) with mode `0700`
and `config.json` with mode `0600`, and stores credentials in the secret store
(the macOS Keychain, else the `0600` `secrets.json`). An existing home that other
users can open is made private.

| Setting | Flag | Prompt | Environment |
| --- | --- | --- | --- |
| Your number, the only one Hotline calls, texts or answers | `--owner +15555550100` | yes | |
| Quiet-hours time zone | `--time-zone America/Toronto` | no (this Mac's zone) | |
| Tunnel origin for webhooks | `--public-url https://...` | no | |
| Twilio number texts come from | `--sms-from +1...` | no | |
| The Twilio number's id in ElevenLabs (**Phone Numbers**) | `--agent-phone-number-id` | no | |
| Providers, secret store | `--voice-provider`, `--sms-provider`, `--secret-store` | no | |
| PIN, 4 to 8 digits (6 or more recommended) | never | yes, twice, no echo | `HOTLINE_PIN` |
| ElevenLabs API key | never | yes, no echo | `HOTLINE_ELEVENLABS_API_KEY` |
| ElevenLabs post-call webhook secret | never | yes, no echo | `HOTLINE_ELEVENLABS_WEBHOOK_SECRET` |
| Twilio account SID and auth token | never | yes, no echo | `HOTLINE_TWILIO_ACCOUNT_SID`, `HOTLINE_TWILIO_AUTH_TOKEN` |

- The PIN and credentials are never accepted as flags: other users on the Mac
  can see a process's arguments, and shells keep them in history.
- Only the PIN's scrypt hash is stored (`owner.pinHash`), never the PIN. A PIN
  shorter than 6 digits works but prints a warning: caller ID can be spoofed,
  and the PIN is what stops a spoofed call.
- `init` generates the shared tool secret (`elevenlabs.toolSecret`) itself.
  The post-call webhook secret comes from ElevenLabs: enable post-call webhooks
  on the [ElevenAgents settings page](https://elevenlabs.io/app/agents/settings),
  point them at `<public URL>/hooks/el/post-call`, and copy the secret it shows.
- `--non-interactive` never asks and fails if the owner number or PIN is
  missing. Credentials it is not given are reported as `not set`.
- An existing config is kept unless you pass `--force`. With `--force`, settings
  you do not give again (rate limits, nicknames, voice ids, the PIN hash) stay.
  A config `init` cannot read is refused, never replaced: it may hold the
  ElevenLabs ids, and dropping them would orphan the deployed agent.
- Output shows the owner number as its last four digits and never a secret.

## `hotline voice`

- `hotline voice apply` creates, or updates on later runs, the ElevenLabs
  workspace secret holding the tool secret, the four server tools
  (`hotlineToolConfigs`, pointing at `<public URL>/hooks/el/tools/*`) and the agent
  (`hotlineAgentConfig`, tagged `definition-v<AGENT_DEFINITION_VERSION>`). The ids
  go into the config (`voice.toolSecretId`, `voice.toolIds`, `voice.agentId`) as
  each is created, so a failure part way never leaves an orphan. Every run
  also sends the current local tool secret to the existing workspace secret, so
  a new store or a re-run `init` cannot leave ElevenLabs with a stale one. Run
  it again after changing the public URL, the secret store or upgrading Hotline.
- `hotline voice list` lists the voices in your ElevenLabs account (up to 10
  pages of 100, and says so when there are more) and marks the current one.
- `hotline voice set <voice id>` checks the id with `isVoiceId` before anything
  is saved or sent, saves `voice.voiceId`, and re-applies the agent. If the
  re-apply fails it says the voice was saved but not applied, and exits 1. See
  [voice.md](voice.md) for choosing or cloning a voice.

ElevenLabs endpoints and sources are listed at the top of
`apps/cli/src/elevenlabs-admin.ts`. Error messages give the HTTP status only,
never ElevenLabs' response text, which can echo the request.

## `hotline install <claude|codex>`

Writes the entries from [mcp.md](mcp.md#config-snippets) and
[hooks.md](hooks.md#config-snippets):

| | MCP server | Hooks |
| --- | --- | --- |
| `claude` | `~/.claude.json` `mcpServers.hotline` | `~/.claude/settings.json` |
| `claude --project` | `.mcp.json` | `.claude/settings.json` |
| `codex` | `~/.codex/config.toml` (or `$CODEX_HOME`) | `~/.codex/hooks.json` |
| `codex --project` | `.codex/config.toml` | `.codex/hooks.json` |

- Hooks: `PermissionRequest` and `Stop`, `hotline hook <agent> <event>
  --wait-seconds 1830` with `timeout: 1900`. Codex MCP: `tool_timeout_sec = 2100`
  in a block between `# >>> hotline` and `# <<< hotline` markers. Claude Code
  MCP: no per-server `timeout` (it is a hard limit).
- Every file that changes is copied to `<file>.hotline-backup-<UTC time>`
  (`0600`) first, and the change is printed as a diff. `--dry-run` prints the
  diff only.
- Running it again changes nothing. An older Hotline hook (another launcher, a
  different wait) is replaced, not duplicated. A hook counts as Hotline's when
  its command is `hotline`, an absolute path or `node <file>.js`, then exactly
  `hook <agent> <event>` and only `--wait-seconds` or `--port`.
- A Codex config that already defines `mcp_servers.hotline` in any TOML form
  (a table, a quoted name, `hotline = {...}` under `[mcp_servers]`, dotted or
  inline keys) is refused, never edited.
- It never changes permission modes, allow lists or any other setting, and it
  never touches a `[mcp_servers.hotline]` table you wrote by hand (it says so).
  A symlinked config file is refused: add the entries by hand.
- `--uninstall` removes exactly Hotline's entries, with a backup and a diff.
- `--command /abs/path/to/hotline` writes that path instead of `hotline`.
- After installing for Codex, open Codex and trust the new hooks with `/hooks`.
  For Claude Code, set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=2400000` in the
  environment Claude Code starts in ([mcp.md](mcp.md#claude-code)).
- `--home <dir>` uses `<dir>` instead of your home folder. Under the test runner
  (or with `HOTLINE_TEST_MODE=1`) it is required, and `--project` must be inside
  it, so a test can never touch the real `~/.claude` or `~/.codex`.

## `hotline away on|off|status`

Switches away mode, which lets the permission and Stop hooks phone you
([hooks.md](hooks.md#away-mode)). Off is the default.

## `hotline doctor`

One `PASS`, `WARN` or `FAIL` line per check, then a count. Exits 1 if anything
fails.

| Check | Fails when | Warns when |
| --- | --- | --- |
| config | missing, unsafe or invalid | |
| secrets (set or not, never values) | a credential the configured providers need is missing | the daemon has not created its API token yet |
| daemon | it refuses the token, or something else answers on its port | it is not running |
| away mode | | the state file is unusable (it then reads as off) |
| Claude Code and Codex installs (user, and the current project) | a hook's `--wait-seconds` is not below its `timeout`; Codex `tool_timeout_sec` is not above `policy.askTimeoutMinutes`; a Claude per-server `timeout` shorter than that | not installed; a hook or the MCP server is missing; less than 30 s between wait and timeout; a wait shorter than the ask timeout |
| Claude Code idle timeout | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is not above the ask timeout | it is not set in this shell |
| ElevenLabs agent | no phone number id or agent; the deployed agent's `definition-v<n>` tag is not `AGENT_DEFINITION_VERSION`; it lacks one of the four tools, or their ids are not recorded; a tool calls another URL than `<tunnel.publicUrl>/hooks/el/tools/<name>` or uses another secret id than `voice.toolSecretId` | its voice differs from the config |
| webhooks | `tunnel.publicUrl` is unset while a real provider needs it | |

The monthly cost estimate from plan section 8 is not in `doctor` yet.

## `hotline test-call`

Rings the owner's phone once through the configured voice provider with a fixed
test message that needs no answer. It refuses unless the config, the agent id,
the phone number id and the API key exist, prints that it will ring the owner's
phone (last four digits), and asks you to type `yes` unless you pass `--yes`.
With `voice.provider` set to `fake` nothing rings: the fake provider records
the call.

A test call goes straight to the voice provider, not through the daemon's call
policy, so quiet hours and the call rate limits do not apply to it. Instead it
keeps its own cooldown: two minutes between real test calls (`test-call.json` in
the hotline home). If its post-call webhook reaches the daemon, the daemon does
not know the conversation, records `voice.post-call-ignored` in the audit log
and changes nothing. Tests use the fake provider or a fake HTTP layer only; a real test
call is part of the [live check](live-check.md), done by a human.
