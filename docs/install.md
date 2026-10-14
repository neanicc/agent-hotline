# Setting up Hotline

The setup commands (`apps/cli`, HL-11): `hotline init`, `hotline voice`,
`hotline install`, `hotline away`, `hotline doctor` and `hotline test-call`.

## Getting the `hotline` command

Hotline is not published. `pnpm run package` (after `pnpm install`) bundles the
CLI into `dist/hotline/`, which runs with plain Node 22 and no `node_modules`:

| Path | Holds |
| --- | --- |
| `bin/hotline` | The launcher. Link it onto your `PATH`, or pass its absolute path to `install --command` |
| `lib/*.mjs` | The CLI; each command's code loads only when that command runs |
| `package.json` | Name and version (`hotline --version` reads it) |
| `LICENSE`, `THIRD_PARTY_LICENSES.txt` | This project's license and those of the bundled packages |

```sh
pnpm run package
ln -s "$PWD/dist/hotline/bin/hotline" ~/.local/bin/hotline   # any folder on your PATH
```

The link survives a rebuild. You can also copy `dist/hotline` anywhere and link
its `bin/hotline`. The agents run `hotline` with the `PATH` they start with; if
it is not on that `PATH`, install with `--command /absolute/path/to/bin/hotline`
(a file named `hotline`, so `install`, `--uninstall` and `doctor` recognise the
hooks as Hotline's). From a checkout without packaging, `pnpm run hotline
<command>` runs the unbundled build.

## Order

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
| Whether to use the reply judge (below) | `--judge auto` (or `claude-code`, `codex`, `anthropic-api`, `off`) | yes, once, `[Y/n]` (`[y/N]` once turned off) | |
| PIN, 4 to 8 digits (6 or more recommended) | never | yes, twice, no echo | `HOTLINE_PIN` |
| ElevenLabs API key | never | yes, no echo | `HOTLINE_ELEVENLABS_API_KEY` |
| ElevenLabs post-call webhook secret | never | yes, no echo | `HOTLINE_ELEVENLABS_WEBHOOK_SECRET` |
| Twilio account SID and auth token | never | yes, no echo | `HOTLINE_TWILIO_ACCOUNT_SID`, `HOTLINE_TWILIO_AUTH_TOKEN` |
| Anthropic API key for the reply judge (optional) | never | no | `HOTLINE_ANTHROPIC_API_KEY` |

- The PIN and credentials are never accepted as flags: other users on the Mac
  can see a process's arguments, and shells keep them in history. The
  `HOTLINE_*` variables are for scripted setup only: other processes of the
  same user can read a process's environment, so prefer the prompts.
- Switching `--secret-store` with `--force` stores the secrets in the new store
  and leaves the old store's copies alone; `init` says so.
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
- `init` explains the reply judge (below) and asks once whether to use it:
  `y` turns it on (`judge.backend: "auto"`, or the backend chosen before), `n`
  turns it off. Enter is yes, except after you turned the judge off: then the
  question reads `[y/N]` and Enter keeps it off.
  `--judge <auto|claude-code|codex|anthropic-api|off>` answers without asking.
  With `--non-interactive` and no `--judge`, the earlier choice stays; on a
  first run nothing is recorded and the judge stays off. `init` ends with a
  `reply judge:` line saying what was recorded.

### The reply judge

When you answer a read-back with something other than a plain yes or no
("yeah, let's ship that one", "sure, no problem"), the daemon can ask a small
model what you meant, on the plan you already have (HL-09d). Your words leave
the machine only once you have chosen this at `init` (or set `judge.backend`
yourself); until then nothing is sent and such replies are texted. Once chosen,
it uses the first of these it finds, with nothing else to set up:

1. **Claude Code** (`claude` on the `PATH`): `claude -p` on your login, model
   `haiku`. Log in once with `claude` if you have not.
2. **Codex** (`codex` on the `PATH`): `codex exec` on your login, Codex's
   default model at low reasoning effort.
3. **An Anthropic API key**, stored as `anthropic.apiKey` when `init` runs with
   `HOTLINE_ANTHROPIC_API_KEY` set. It is never asked for.

Only your short spoken reply is sent, redacted, never the request or anything an
agent wrote. Each run is isolated: an empty temporary folder, hooks off, no MCP
servers, no saved session, and `HOTLINE_JUDGE=1`, under which `hotline hook` and
`hotline mcp` do nothing. Claude Code runs with no tools. Codex keeps its shell
tool, limited to its read-only sandbox without network; choose `--judge
claude-code` if you want a judge with no tools. The CLI gets only the environment it needs
(`PATH`, `HOME`, locale, proxy settings and its own login variables such as
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`); no `HOTLINE_*` variable or Hotline
credential reaches it. A yes with a condition ("yes if the tests pass", "sure,
but not on main") or taken back ("yes... actually no") is never an approval. If
the judge errs, takes longer than 20 seconds, or none is available, the reply is
unclear and the request is texted to you. The judge runs after you hang up,
while the daemon handles the call's transcript, so you never wait on the line
for it. High-risk requests still need your PIN or a confirming text.

`config.json` `judge.backend` records the choice: `"auto"` (the order above),
`"claude-code"`, `"codex"`, `"anthropic-api"`, or `"off"` to send nothing
anywhere. Unset (no choice yet) also sends nothing. The daemon picks the judge
when it starts; restart it after installing Claude Code or Codex, or after
changing this setting. The daemon must find `claude` or `codex` on the `PATH` it
is started with; when it does not, its `reply judge` log line and `hotline
doctor` name the `PATH` they looked on.

## `hotline voice`

- `hotline voice apply` creates, or updates on later runs, the ElevenLabs
  workspace secret holding the tool secret, the four server tools
  (`hotlineToolConfigs`, pointing at `<public URL>/hooks/el/tools/*`) and the agent
  (`hotlineAgentConfig`, tagged `definition-v<AGENT_DEFINITION_VERSION>`). The ids
  go into the config (`voice.toolSecretId`, `voice.toolIds`, `voice.agentId`) as
  each is created, so a failure part way leaves nothing unrecorded; if
  recording an id itself fails, the error names the id so you can add it to
  the config by hand (or delete it in ElevenLabs). Every run
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
  diff only. The printed diff masks values under credential-looking keys
  (`token`, `secret`, `key`, `auth`, ...) and anything after `Bearer`, since
  other MCP servers keep tokens in the same files. The files themselves keep
  them.
- The file is read again just before it is replaced; if something else (a
  running Claude Code) wrote it in between, nothing is written and `install`
  asks you to run it again. Quitting Claude Code first avoids that.
- Running it again changes nothing. An older Hotline hook (another launcher, a
  different wait) is replaced, not duplicated. A hook counts as Hotline's when
  its command starts with `hotline`, an absolute path to a file named exactly
  `hotline`, this run's `--command`, or `node <...>/apps/cli/dist/main.js`,
  followed by exactly `hook <agent> <event>` and only `--wait-seconds` or
  `--port`. Any other `--command` is recognised only when the same `--command`
  is given again (`install --uninstall --command ...`, `doctor --command ...`).
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

One `PASS`, `WARN` or `FAIL` line per check, then `INFO` lines with the monthly
cost estimate, then a count of the checks. Exits 1 if anything fails; `INFO`
lines never pass, warn or fail. The `judge` line names the reply judge the
daemon would use, found the way the daemon finds it (a CLI on the `PATH`, or the
stored key) without any model call. `--check-judge` also asks it one tiny fixed
question, which is one model call on your login or key.

| Check | Fails when | Warns when |
| --- | --- | --- |
| config | missing, unsafe or invalid | |
| secrets (set or not, never values) | a credential the configured providers need is missing | the daemon has not created its API token yet |
| daemon | it refuses the token, or something else answers on its port | it is not running |
| reply judge | with `--check-judge`, its answer to the fixed reply "yes, go ahead" is not `agreed` (not logged in, no network, a bad key) | no judge was chosen yet (`judge.backend` unset; nothing is sent), or no backend is available (the `PATH` searched is named), so unclear replies are texted (`judge.backend: "off"` passes) |
| away mode | | the state file is unusable (it then reads as off) |
| Claude Code and Codex installs (user, and the current project) | a hook's `--wait-seconds` is not below its `timeout`; Codex `tool_timeout_sec` is not above `policy.askTimeoutMinutes`; a Claude per-server `timeout` shorter than that | not installed; a hook or the MCP server is missing; less than 30 s between wait and timeout; a wait shorter than the ask timeout |
| Claude Code idle timeout | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is not above the ask timeout | it is not set in this shell |
| ElevenLabs agent | no phone number id or agent; the deployed agent's `definition-v<n>` tag is not `AGENT_DEFINITION_VERSION`; it lacks one of the four tools, or their ids are not recorded; a tool calls another URL than `<tunnel.publicUrl>/hooks/el/tools/<name>` or uses another secret id than `voice.toolSecretId` | its voice differs from the config |
| webhooks | `tunnel.publicUrl` is unset while a real provider needs it | |

### Monthly cost estimate

The `INFO  cost` lines estimate a month's bill from the last 30 days in the
daemon's store (`hotline.db` in the hotline home), computed locally with no
network call. The store is opened read-only: doctor never creates, migrates or
writes it. A missing store is named and priced as no usage; an unreadable one (say, locked
by the daemon for more than 2 s) is named and gets no figure at all.

- **Calls:** every call that started in the window, placed or received, with its
  duration rounded up to whole minutes (as Twilio bills). Each billed minute
  pays the Twilio call leg and the LLM; minutes past the ElevenLabs plan's
  included ones pay ElevenLabs' per-minute rate.
- **Texts:** Hotline's own texts (`text.sent`, written after a successful send,
  and the crash notice, written before its send), one reply for each text you
  sent, and every text received, yours or another number's. Each counts as one
  segment at the Twilio rate plus carrier fees. The crash notice and the replies
  are upper bounds (a failed notice or an empty text sends nothing); the generic
  reply to another number is not in the audit log and is not counted.
- **Fixed fees:** the Twilio number and the ElevenLabs plan count every month,
  even with no usage.

The rates are assumptions, not quotes. Their defaults are the README's cost
table (`DEFAULT_COST_RATES` in `packages/core/src/config.ts`); override any of
them under `costs` in `config.json`, in dollars, each a non-negative number:

```json
{ "costs": { "llmPerMinute": 0.05, "elevenLabsPlanPerMonth": 22, "elevenLabsIncludedMinutes": 250 } }
```

The estimate does not include Twilio's inbound call rate (calls you place are
priced like outbound ones), multi-segment texts, taxes or anything the store did
not record, such as rejected inbound calls.

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
the hotline home). A stamp file that is not private or not readable refuses the
call until it is removed. If its post-call webhook reaches the daemon, the daemon does
not know the conversation, records `voice.post-call-ignored` in the audit log
and changes nothing. Tests use the fake provider or a fake HTTP layer only; a real test
call is part of the [live check](live-check.md), done by a human.
