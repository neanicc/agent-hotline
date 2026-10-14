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
   one short line for the owner, in this order: why it is high risk
   (`High risk: deletes files.`), the tool and a preview (the command's text, the
   files a patch touches, a path relative to the project), then the agent's own
   `description`, labelled `The agent says: "..."` because it is untrusted.
   Never file contents or diffs: a tool Hotline does not know (MCP tools) shows
   only its argument names, never their values. Control characters are
   removed, and text is only ever cut between words, so no fragment of a secret
   slips past the daemon's redactor.
   - A preview longer than 200 characters is cut and says so
     (`command shortened, 312 more characters`), and the request becomes high
     risk ("is too long to read out in full"): the part the owner cannot hear
     could hold anything.
   - The description never stands in for the command: an empty command reads
     `(no details)`. A description with no letters or digits is dropped; one
     longer than 120 characters is cut.
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
risk needs the PIN or a confirming text.

**Shell commands fail closed.** A command is low risk only when Hotline can
split it into simple commands (on `;`, `&&`, `||`, `|` and newlines, with single
and double quotes) and every one of them is on this allowlist with safe
arguments:

| Command | Allowed when |
| --- | --- |
| `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `echo`, `diff`, `du`, `tree` | Every argument that is not an option is inside the project and names no credential. Not `find -delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*` or `-fls`; not `rg --pre`, `--pre-glob` or `-z`; not `tree -o` |
| `git status`, `diff`, `log`, `show`, `rev-parse`, `ls-files` | No option before the subcommand (`-c`, `-C`, `--exec-path`), none of `--output`, `--ext-diff`, `--git-dir`, `--work-tree`, `--exec-path`, `--no-index`, `--namespace`, and every argument checked as a path (below) |
| `git branch` | Listing only: `-a`, `-r`, `-l`, `-v`, `-vv`, `--list`, `--all`, `--remotes`, `--show-current`, `--no-color` |
| `npm`, `pnpm`, `yarn`, `bun` | `test`, `build`, `lint` or `typecheck` (directly or after `run`), then only options, `--` and paths inside the project |

The tokenizer accepts only text that bash and zsh read the same way. Claude Code
and Codex may run commands under zsh on macOS.

- Outside quotes, only `A-Z a-z 0-9 _ . / : @ % + , - =` are allowed, with `=`
  never at the start of a word (zsh `=cmd`). That rules out globs (`*`, `?`,
  `[...]`), braces, `~`, `^`, `#`, `!`, parentheses and every non-ASCII
  character, lookalike separators included.
- Single-quoted text may hold anything else. Double-quoted text may not hold
  `!` (history expansion).
- `$` (variables, `$(...)`, ANSI-C `$'...'`), backticks and backslashes are
  refused anywhere. So are C0 and C1 control characters other than tab and
  newline (CR, NUL, DEL, ...).
- zsh numeric globs (`<1-10>`, `<->`) are refused.

Redirections are allowed only to `/dev/null`, to file descriptors (`2>&1`), or
to and from paths inside the project.

Hotline does not know which options take a value, so it checks every form:

- `--opt=VALUE`: VALUE is checked as a path.
- `--opt VALUE`: every following word is checked as a path anyway.
- A long option with `/`, `.` or `~` in it is refused.
- `-fVALUE` and clusters such as `-rf/etc/x` or `-fsecrets`: the value could
  start at any character after the dash, so every suffix is checked as a path.
  `head -c1/etc/x` and `grep -f.env` are high.

"Checked as a path" means: inside the project, no credential or settings name,
and no `.git` component. Every git argument, revisions included, gets this check,
so git cannot be pointed at another or a nested repository. `--git-dir`,
`--work-tree`, `--exec-path`, `--no-index` and `--namespace` are refused, as are
`-C` and `-c` (no option may come before the subcommand), and any `VAR=` prefix
(`GIT_DIR=...`).

Anything else is high, including:

- subshells, `&` background jobs (and zsh `&!`, `|&`), here-documents and
  process substitution;
- `FOO=1 cmd` assignments, and a command name with a slash (`/bin/rm`, `./x`);
- wrappers (`env`, `command`, `xargs`, `nohup`, `time`);
- every command not in the table.

The owner hears the matching reason from the table below, or "runs a command
Hotline does not recognise as read-only" when none fits.

**Project code still runs.** Allowlisted `test`, `build`, `lint` and `typecheck`
scripts run the project's own code, and git commands honour repository config
(`core.fsmonitor`, diff and textconv drivers, hooks). Writing any file that sets
these is high risk ("touches credentials or agent settings"), even inside the
project:

- any path with a `.git` component, at any depth, directory or file;
- `.gitattributes`, `.gitmodules`, `.husky/`;
- `package.json`, `node_modules/`;
- `.npmrc`, `.yarnrc*`, `.yarn/`, `.pnpmfile.cjs`, `bunfig.toml`, `.envrc`.

Sensitive names are matched case-insensitively after NFC normalisation, because
macOS file systems ignore case and normalisation by default (`.GIT/config`,
`.Env` and `Package.json` all count). Reading them stays low.

Other project code the owner already approved an edit to (a test file, a build
script it imports) runs as low risk. There the protection is that a low-risk
request still needs the owner's explicit "yes" to the command they hear.
Hotline also cannot see the shell's aliases or `PATH`. This is a classification
of the command text, not a sandbox.

**What the classifier decides.** It decides only how much proof an approval
needs: the PIN or a confirming text, or the owner's spoken "yes". It never
decides whether an approval is needed. Every permission request needs the
owner's own approval, and every failure denies. Bypass classes not covered here
are tracked for HL-13's fuzz tests.

**Unknown project.** When the session's `cwd` is empty, relative, `/`, a
top-level directory such as `/tmp`, or a home directory (`/Users/<name>`,
`/home/<name>`), there is no known project: every path counts as outside it, so
any write and any path argument is high risk.

| Reason | Examples |
| --- | --- |
| deletes files | `rm`, `rmdir`, `unlink`, `find -delete`, `git rm`, `git clean`, an `apply_patch` `Delete File` |
| pushes or rewrites git history | `git push`, `git reset --hard`, `git branch -D`, `git filter-branch`, `git stash drop` |
| installs or downloads from the network | `npm`/`pnpm`/`yarn`/`bun` install or add, `npx`, `pip install`, `brew install`, `cargo install`, `go get`, `curl`, `wget`, `ssh`, `scp`, `git clone`/`fetch`/`pull`, `docker pull` |
| writes outside the project | a write (redirect, `cp`, `mv`, `tee`, `mkdir`, `sed -i`, ...) with a path outside the session's `cwd`, `~` or `$HOME`; a file tool or patch whose path is outside it |
| touches credentials or agent settings | `.env*`, `.ssh`, `.aws`, `.netrc`, `.npmrc`, key and certificate files, `credentials`, `secrets`, `.hotline`, `.claude`, `.codex`, the Keychain, `printenv`, words like `token` or `password` in a command |
| runs with elevated privileges | `sudo`, `doas`, `su` |
| runs nested code Hotline cannot read | `$(...)`, backticks, `eval`, `exec`, `source`, `env`, `command`, `xargs`, `sh -c`, `| sh`, `python -c`, `node -e`, `osascript` |
| runs a command Hotline does not recognise as read-only | any shell command outside the allowlist that matches none of the reasons above |
| sends data off the machine | `WebFetch` (its URL can carry data) |
| uses a tool Hotline does not know | every MCP tool (`mcp__*`) and any other unknown tool |
| has input Hotline cannot read | a shell tool without a command string, a patch without file headers, a file tool without a path |
| is too long to read out in full | a preview cut at 200 characters (set by the hook, see above) |

Everything else is **low**: allowlisted shell commands, file edits and patches
inside a known project, and read tools (`Read`, `Grep`, `Glob`, `LS`,
`WebSearch`) unless they point at credentials. Inside the project only the path
below the project root counts, so a project that itself lives under `.claude/`
(a worktree) is not flagged for that.

It decides only how much proof the owner gives. A low-risk request still needs
the owner's own "yes", and every failure denies.

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
  read or saved lets the agent stop. Every exit that does not continue the agent
  (no answer, "that's it", a failure) clears the count, so a later continuation
  by another Stop hook is never taken for Hotline's own.
- Away mode is checked again after the owner answers: if it was switched off
  while the hook waited, no continuation goes out. Agent commands that would
  change this state (`hotline away`, anything under `.hotline/`) are high risk.

The daemon keeps at most one open `stop` ask per session: a new one cancels an
older one, whose hook was killed before it could cancel it.

## Waiting, timeouts and exit codes

- The hook waits up to `--wait-seconds` (default 540), then cancels the ask and
  denies (permission) or lets the agent stop. Each outcome request ends at that
  deadline, and an answer that arrives after it does not count. Both agents kill a command hook at
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

`hotline install claude|codex` writes these with a backup and a diff, and
`hotline doctor` checks that each `--wait-seconds` is below its `timeout`; see
[install.md](install.md). To add them by hand before packaging (HL-15) puts
`hotline` on your `PATH`, use `node /absolute/path/to/apps/cli/dist/main.js` as
the command.

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
