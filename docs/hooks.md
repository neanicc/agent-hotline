# Hook adapters and away mode

`hotline hook <claude|codex> <permission|stop>` is the command hook Claude Code
and Codex run for `PermissionRequest` (`permission`) and `Stop` (`stop`)
(`packages/agents/src/hook-adapter.ts`, HL-06). Each run reads the agent's JSON
payload on stdin and prints that agent's documented output, or nothing. The
payload and output shapes are in [contracts.md](contracts.md#hook-payloads-hooksts);
the fixtures they are tested against are in
[`packages/agents/test/fixtures/hooks`](../packages/agents/test/fixtures/hooks/README.md).

## Away mode

```sh
hotline away on       # the hooks phone you
hotline away off      # the hooks stay out of the way (the default)
hotline away status
```

The state is `away.json` in the hotline home (`$HOTLINE_HOME`, else `~/.hotline`),
written `0600` in a `0700` directory like the config. A file that is missing,
open to other users, a symlink, owned by someone else or malformed counts as
**off**, and the hook says why on stderr. Switching away mode on or off also
clears the Stop-hook continuation counts.

Outside away mode the hooks print nothing: the agent shows its own permission
prompt in the terminal, or simply stops.

## Permission (`PermissionRequest`)

In away mode:

1. The hook works out a risk class from the full tool input (below), and builds
   one short line for the owner: the tool, a preview (the command's text, the
   files a patch touches, a path relative to the project), the agent's own
   `description`, and why it is high risk. Never file contents or diffs.
   Control characters are removed and each part is cut short.
2. It registers the session (`agentSessionId` is the payload's `session_id`) and
   queues a `permission` ask with `toolName` and `risk`. The daemon redacts the
   text and tool name before storing them.
3. It long-polls the outcome and prints:
   - **allow** only when core's `permissionVerdict` allows: the owner's own
     approval of exactly this ask, with the PIN or a confirming text when it is
     high risk. The hook judges with the stricter of its own risk class and the
     one the daemon stored.
   - **deny** with `"The owner did not approve this by phone."` for every other
     case: no answer, a timeout, the daemon unreachable or not set up, a refused
     or malformed outcome, an approval of another ask, a high-risk approval
     without confirmation (which adds that a PIN or confirming text is needed),
     or the agent killing the hook. An explicit "no" from the owner says so and
     passes on the owner's words, so the agent can act on "no, use pnpm".

The hook never sends `updatedInput`, `updatedPermissions` or `interrupt`, never
applies a `permission_suggestions` entry and never offers "approve for the whole
session". It only answers the prompt the agent would have shown.

A payload the hook cannot parse, in or out of away mode, gets no output, so the
agent's own prompt appears.

### Risk classes (plan question 6)

`classifyPermission` in `@hotline/core` (`permission-risk.ts`), pure. **High**
risk needs the PIN or a confirming text:

| Reason | Examples |
| --- | --- |
| deletes files | `rm`, `rmdir`, `unlink`, `find -delete`, `git rm`, `git clean`, an `apply_patch` `Delete File` |
| pushes or rewrites git history | `git push`, `git reset --hard`, `git branch -D`, `git filter-branch`, `git stash drop` |
| installs or downloads from the network | `npm`/`pnpm`/`yarn`/`bun` install or add, `npx`, `pip install`, `brew install`, `cargo install`, `go get`, `curl`, `wget`, `ssh`, `scp`, `git clone`/`fetch`/`pull`, `docker pull` |
| writes outside the project | a write (redirect, `cp`, `mv`, `tee`, `mkdir`, `sed -i`, ...) with a path outside the session's `cwd`, `~` or `$HOME`; a file tool or patch whose path is outside it |
| touches credentials or agent settings | `.env*`, `.ssh`, `.aws`, `.netrc`, `.npmrc`, key and certificate files, `credentials`, `secrets`, `.hotline`, `.claude`, `.codex`, the Keychain, `printenv`, words like `token` or `password` in a command |
| runs with elevated privileges | `sudo`, `doas`, `su` |
| runs nested code Hotline cannot read | `eval`, `exec`, `source`, `sh -c`, `| sh`, `python -c`, `node -e`, `osascript` |
| uses a tool Hotline does not know | every MCP tool (`mcp__*`) and any other unknown tool |
| has input Hotline cannot read | a shell tool without a command string, a patch without file headers, a file tool without a path |

Everything else is **low**: shell commands without any of the above, file edits
inside the project, and read tools (`Read`, `Grep`, `Glob`, `LS`, `WebFetch`,
`WebSearch`) unless they point at credentials. Inside the project only the path
below the project root counts, so a project that itself lives under `.claude/`
(a worktree) is not flagged for that.

This is a heuristic over agent-written text, not a sandbox: a determined agent
can disguise a command. It decides only how much proof the owner gives. A
low-risk request still needs the owner's own "yes", and every failure denies.

## Stop (`Stop`)

In away mode, when the agent finishes a turn the hook asks the owner "what
next?" with a short summary of the last assistant message. The owner's own
instruction (a `text` decision, checked by core's `stopInstruction`) becomes
`{"decision": "block", "reason": "<instruction>"}`, which both agents treat as
the next prompt. "That's it" (`done`), no answer, a timeout or any failure
prints nothing, so the agent stops. Silence never continues an agent.

Loop guards, always on:

- **`stop_hook_active`.** A turn the human started (`false`) starts a fresh
  count. A continuation Hotline did not cause itself (`true`, but no count of its
  own, for example another Stop hook's) is left alone: the agent stops.
- **Continuation cap.** At most `policy.maxConsecutiveContinuations` (default 5)
  continuations in a row per agent session. At the cap the agent stops and a
  notification tells the owner so. Claude Code has its own cap of 8
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- The count lives in `hook-state/<agent>-<hash>.json` in the hotline home
  (`0600`, file name from a SHA-256 of the session id). A count that cannot be
  read or saved lets the agent stop.

The daemon keeps at most one open `stop` ask per session: a new one cancels an
older one, whose hook was killed before it could cancel it.

## Waiting, timeouts and exit codes

- The hook waits up to `--wait-seconds` (default 540), then cancels the ask and
  denies (permission) or lets the agent stop. Both agents kill a command hook at
  its `timeout` (600 seconds by default) and discard its output, so keep
  `--wait-seconds` about 60 seconds below the configured `timeout`. To wait the
  full `policy.askTimeoutMinutes` (30 minutes by default), set the hook's
  `timeout` to about 1900 and `--wait-seconds` to 1830 (plan question 2:
  synchronous wait with a long hook timeout).
- SIGTERM or SIGINT (the agent gave up, or the user interrupted) cancels the
  ask, so nobody is phoned about it, and the hook denies or lets the agent stop.
- Exit code is always 0 for a run; usage errors exit 1. Never 2: exit 2 from a
  Stop hook means "keep going" in both agents.
- Only the JSON output goes to stdout. A one-line note goes to stderr; it never
  holds the agent's text, the owner's words or a secret.

## Config snippets

`hotline install claude|codex` (HL-11) will write these with a backup and a
diff. Until then, add them by hand. Until packaging (HL-15) puts `hotline` on
your `PATH`, use `node /absolute/path/to/apps/cli/dist/main.js` as the command.

### Claude Code

`~/.claude/settings.json`, or `.claude/settings.json` in a project
([hooks docs](https://code.claude.com/docs/en/hooks)):

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "hotline hook claude permission --wait-seconds 1830", "timeout": 1900 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "hotline hook claude stop --wait-seconds 1830", "timeout": 1900 }
        ]
      }
    ]
  }
}
```

### Codex

`~/.codex/hooks.json` ([hooks docs](https://developers.openai.com/codex/hooks)).
Codex runs a non-managed hook only after you trust it with `/hooks`.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "hotline hook codex permission --wait-seconds 1830", "timeout": 1900 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "hotline hook codex stop --wait-seconds 1830", "timeout": 1900 }
        ]
      }
    ]
  }
}
```

Or inline in `config.toml` as `[[hooks.PermissionRequest]]` and
`[[hooks.PermissionRequest.hooks]]` tables with the same fields.

## Daemon routes it uses

`POST /v1/sessions`, `POST /v1/sessions/:id/asks` (kinds `permission` and
`stop`), `GET /v1/asks/:id/outcome` and `POST /v1/asks/:id/cancel`, under the
agent API's token and loopback `Host` checks; see
[daemon.md](daemon.md#agent-api). It reads the port and token the same way as
the MCP server ([mcp.md](mcp.md#session-registration)), and only when away mode
is on.
