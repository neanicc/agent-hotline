# MCP server

`hotline mcp` is a stdio MCP server (`packages/agents`, HL-05). Claude Code and
Codex start one per session. It gives the agent three tools and relays each call
to the daemon's agent API on `127.0.0.1`, with the per-install token. It never
decides anything itself.

| Tool | What it does | Returns |
| --- | --- | --- |
| `ask_human` | Queues a question (up to 500 characters, up to 9 options, optional 400-character context) and waits for the owner | JSON: `{"outcome": "answered", "choice": {"option", "text"}` or `"answer", "ownerWords", "channel"}`, or `{"outcome": "no-answer", "reason", "note"}` |
| `notify_human` | Queues a short note (up to 900 characters). Nothing waits for a reply | `{"queued": true, "askId"}`, or an error result |
| `check_inbox` | Lists instructions the owner left for this session, and the session's 20 most recent asks with their results | JSON, or an error result |

## Rules it keeps

- **Tool input is untrusted.** Control characters are replaced with spaces. The
  daemon redacts the text and options (keys, tokens, phone numbers, the API
  token) before it stores them, so nothing downstream ever holds the raw text.
- **"No answer" is never an answer.** The result is `no-answer` when Hotline is
  not set up, the daemon is unreachable or refuses the token, the daemon stops
  answering for three retries (1, 2 and 4 s), the ask expires
  (`policy.askTimeoutMinutes`, default 30), or the agent cancels the call. The
  `note` tells the agent not to treat it as approval.
- **Answers come only from the daemon's resolution path.** `answered` is relayed
  only when the daemon reports it for exactly the ask this call created, with a
  decision a question can have (an offered option, or free text). Anything else
  (another ask's answer, `allow`, `done`, an option out of range) becomes
  `no-answer` with reason `unclear`. The daemon builds `answered` only from an
  answer `recordAnswer` stored after `answerProblem` passed.
- **Bounded asks.** A session may have at most 3 open questions and 10 open
  notifications. Past that the daemon answers `429` and stores nothing, and
  `ask_human` returns `no-answer`.
- **`urgent` is only a request.** The agent sets it, so a looping or
  prompt-injected agent can set it too. Call policy (HL-09) must honor it only
  when the owner turned on `quietHours.allowUrgentCalls`, and always within the
  rate limits. It is never honored by default.
- **Progress while waiting.** If the client sent a `progressToken`, `ask_human`
  sends `notifications/progress` about every 60 seconds, so an idle timeout does
  not fire.
- **Cancel means nobody is called.** If the agent cancels the call or closes the
  server, the ask is cancelled on the daemon.
- **Only MCP messages on stdout.** Help and errors go to stderr.

## Session registration

Once the client has initialized, the server registers a session with the
daemon (`POST /v1/sessions`). It sends the agent, its working directory and,
for Claude Code, `CLAUDE_CODE_SESSION_ID`. The daemon names it "Claude in
<folder>" or "Codex in <folder>" unless `config.nicknames` has the folder. A
registration with the same agent session id reuses the live session. If the
daemon is not running yet, the next tool call registers. If the daemon has
forgotten the session, the server registers again once.

The agent comes from `--agent claude|codex`. Without the flag it is guessed
from the client's name (`claude…` or `…codex…`), and an unknown client gets
`no-answer` from every `ask_human`.

The server finds the daemon through `config.json` in `$HOTLINE_HOME` (else
`~/.hotline`), using `daemon.port` or `--port`, and the `daemon.apiToken` secret
in the configured store. It reads them on first use and again after a failure,
so the daemon can start after the agent. It never creates the token.

## Config snippets

`hotline install claude|codex` (HL-11) writes these entries, keeps a backup and
prints a diff. Until then, add them by hand. Until packaging (HL-15) puts
`hotline` on your `PATH`, use `node` as the command and put
`/absolute/path/to/apps/cli/dist/main.js` first in the arguments.

### Claude Code

Project scope, `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "hotline": {
      "type": "stdio",
      "command": "hotline",
      "args": ["mcp", "--agent", "claude"]
    }
  }
}
```

Or for every project: `claude mcp add --transport stdio --scope user hotline -- hotline mcp --agent claude`.

Timeouts ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp),
[environment variables](https://code.claude.com/docs/en/env-vars)):

- Do not set a per-server `"timeout"`. It is a hard wall-clock limit that progress
  notifications do not extend. The default `MCP_TOOL_TIMEOUT` (about 28 hours) is
  fine.
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (default 30 minutes for stdio servers, needs
  Claude Code 2.1.187 or later) cancels a call with no response and no progress
  for that long. Progress notifications reset it, but the docs do not say
  whether Claude Code asks for them. With the default 30-minute ask timeout, set
  it a little higher in the environment Claude Code starts in, for example
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=2400000` (40 minutes). Keep it above
  `policy.askTimeoutMinutes`.

### Codex

`~/.codex/config.toml`, or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.hotline]
command = "hotline"
args = ["mcp", "--agent", "codex"]
# Codex's default is 60 s, and its client does not reset the timeout on progress.
# Keep this above policy.askTimeoutMinutes (30 min by default) plus a margin.
tool_timeout_sec = 2100
```

Or `codex mcp add hotline -- hotline mcp --agent codex`, then add
`tool_timeout_sec` by hand. Source:
[Codex MCP docs](https://developers.openai.com/codex/mcp).

Codex does not tell a stdio server its session id, so a Codex session has no
`agentSessionId` until the hook adapters (HL-06) supply one.

## Daemon routes it uses

All under the agent API's token and loopback `Host` checks; see
[daemon.md](daemon.md#agent-api).
