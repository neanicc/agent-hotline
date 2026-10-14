# MCP server

`hotline mcp` is a stdio MCP server (`packages/agents`, HL-05). Claude Code and
Codex start one per session. It gives the agent three tools and relays each call
to the daemon's agent API on `127.0.0.1`, with the per-install token. It never
decides anything itself.

| Tool | What it does | Returns |
| --- | --- | --- |
| `ask_human` | Queues a question (up to 500 characters, up to 9 options, optional 400-character context) and waits for the owner | JSON: `{"outcome": "answered", "choice": {"option", "text"}` or `"answer", "ownerWords", "channel"}`, or `{"outcome": "no-answer", "reason", "note"}`; plus `instructions` and `instructionsNote` when the owner left this session instructions |
| `notify_human` | Queues a short note (up to 900 characters). Nothing waits for a reply | `{"queued": true, "askId"}`, or an error result |
| `check_inbox` | Lists instructions the owner left for this session (each shown once), and the session's 20 most recent asks with their results | JSON, or an error result |

## Owner instructions (HL-10)

The owner can call the Hotline number, give the PIN, hear every session's
status and leave one session an instruction ([inbound line](daemon.md#inbound-line)).
Only instructions the daemon confirmed against the owner's own words in the
call transcript are queued. A session picks its instructions up at its next
ask: when `ask_human` returns (any outcome from the daemon, or its own
timeout), the server lists them (`GET /v1/sessions/:id/instructions`),
acknowledges them just before it returns (`POST .../instructions/ack`,
`via: "ask"`) and adds the acknowledged ones to the result as
`instructions: [{"text", "receivedAt"}]` with a note that they are not the
answer to the question. `check_inbox` hands them over too. Each instruction is
handed over once; if fetching them fails, the answer is still returned and the
instructions stay queued. A cancelled `ask_human` takes none.

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
  notifications, and all sessions together 10 and 30. Past that the daemon
  answers `429` and stores nothing, and `ask_human` returns `no-answer`. When
  `ask_human` gives up on an unreachable daemon, it also tries to cancel the ask,
  so nobody is called about it if the daemon comes back.
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
- **Only 127.0.0.1, no redirects.** The client sends the token only to
  `127.0.0.1:<port>` and refuses redirects, so a process squatting on the port
  cannot forward the token or the unredacted text to another host. After a
  response that is not the daemon's, it looks the port up again.

## Session registration

Once the client has initialized, the server registers a session with the
daemon (`POST /v1/sessions`). It sends the agent, its working directory and,
for Claude Code, `CLAUDE_CODE_SESSION_ID`. The daemon names it "Claude in
<folder>" or "Codex in <folder>" unless `config.nicknames` has the folder,
numbering a second live session with the same name ("Claude 2 in <folder>");
see [voice.md](voice.md#session-names). A
registration with the same agent session id reuses the live session. If the
daemon is not running yet, the next tool call registers. If the daemon has
forgotten the session, the server registers again once. When the client closes
the server, the server waits for running calls and then ends the session
(`POST /v1/sessions/:id/end`), which cancels its open asks. A server that is
killed cannot do that: the daemon ends a session nobody has heard from for 6
hours that has no open ask and no queued instruction
([session lifetime](daemon.md#session-lifetime)), and the server registers
again on its next call if it is still running.

One known gap fails safe: if creating an ask times out on the client after
the daemon stored it, `ask_human` reports `no-answer` while the ask stays open
until it expires or the session ends. The owner may be asked, but the answer
reaches no agent.

The agent comes from `--agent claude|codex`. Without the flag it is guessed
from the client's name (`claude…` or `…codex…`), and an unknown client gets
`no-answer` from every `ask_human`.

The server finds the daemon through `config.json` in `$HOTLINE_HOME` (else
`~/.hotline`), using `daemon.port` or `--port`, and the `daemon.apiToken` secret
in the configured store. It reads them on first use and again after a failure,
so the daemon can start after the agent. It never creates the token.

## Config snippets

`hotline install claude|codex` writes these entries, keeps a backup and prints
a diff, and `hotline doctor` checks the timeouts below; see
[install.md](install.md). To add them by hand before packaging (HL-15) puts
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

Codex does not tell a stdio server its session id, so a Codex MCP session has
no `agentSessionId`. The hook adapters ([hooks.md](hooks.md)) register with the
`session_id` from their payload, so a Codex session's hooks and its MCP server
show up as two daemon sessions. Claude Code's hooks and MCP server share one,
when `CLAUDE_CODE_SESSION_ID` matches the hooks' `session_id`.

## Daemon routes it uses

All under the agent API's token and loopback `Host` checks; see
[daemon.md](daemon.md#agent-api).
