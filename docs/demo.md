# Demo script

A step-by-step script for a screen recording of about five minutes. Scenes 1 to 5
use the fake providers: nothing rings, nothing is sent, no account is needed, and
anyone can rehearse them. Scenes 6 to 9 need a real phone and are **owner only**:
the owner's own Twilio and ElevenLabs accounts, tunnel and phone, set up as in
[install.md](install.md). No agent, test or CI job ever runs them, and the
[live check](live-check.md) is where their results are recorded.

| Mark | Meaning |
| --- | --- |
| **[fake]** | Fake providers, a scratch hotline home. Safe to run anywhere |
| **[phone: owner]** | Rings the owner's real phone through real accounts. Only the owner runs it |

## Before recording

- Build the command once: `pnpm run package`, then link
  `dist/hotline/bin/hotline` onto your `PATH` ([README](../README.md#setup)).
- Use a terminal with a large font and a clean prompt. Close anything that shows
  real phone numbers, tokens or `.env` files.
- The fake scenes use a scratch home so the recording never shows your real
  config, and `--home` keeps `install` and `doctor` away from your real
  `~/.claude` and `~/.codex`:

  ```sh
  export DEMO="$(mktemp -d)"
  export HOTLINE_HOME="$DEMO/.hotline"
  ```

- The owner number in the fake scenes is the fake `+15555550100`. Hotline prints
  numbers as their last four digits anyway.
- For the phone scenes, open a second terminal on the owner's real setup (no
  `HOTLINE_HOME` override), with the daemon and tunnel running and
  `hotline doctor` showing no `FAIL`. Put the phone where the camera or a screen
  mirror can show it ringing, and turn on its speaker.

## Scene 1: one command, built locally [fake]

Say: "Agent Hotline is one local command. It isn't published anywhere; you build
it from the repository."

```sh
pnpm run package
hotline --version        # hotline 0.0.0
hotline --help
```

## Scene 2: set up with fakes [fake]

Say: "Setup asks for my number and a PIN. The PIN is only stored as a hash.
Here I use fake providers, so nothing will ring."

```sh
HOTLINE_PIN=480213 hotline init --non-interactive --owner +15555550100 \
  --voice-provider fake --sms-provider fake --secret-store file
hotline install claude --home "$DEMO" --dry-run
hotline install claude --home "$DEMO"
```

Point at the diff: one MCP server (`hotline mcp`) and two hooks
(`PermissionRequest` and `Stop`). Say: "It only adds its own entries, keeps a
backup and shows the diff. It never changes the agent's permission mode."

(`HOTLINE_PIN` is for scripted setup like this; normally `init` asks for the PIN
without echo.)

## Scene 3: the daemon and the doctor [fake]

In a second pane, with the same `DEMO` and `HOTLINE_HOME`:

```sh
hotline daemon
```

Back in the first pane:

```sh
hotline doctor --home "$DEMO"
hotline test-call
```

Expected: `doctor` passes the config, daemon, Claude Code install and
"voice.provider is fake" checks, and warns that Codex is not installed and that
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is not set. `test-call` says the provider is
fake and records a call instead of ringing. Say: "The daemon listens on
127.0.0.1 only. Phone webhooks come in on a separate listener that serves
`/hooks/*` and nothing else, and every one of them is signature-checked."

## Scene 4: silence is not consent [fake]

Say: "Away mode lets the hooks phone me. What if I don't answer?" From the
repository root:

```sh
hotline away on
hotline hook claude permission --wait-seconds 5 \
  < packages/agents/test/fixtures/hooks/claude-code/permission-request.input.json
```

After five seconds it prints `hotline hook: denied: no answer in time` and Claude
Code's deny output:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The owner did not approve this by phone."}}}
```

Say: "Nobody answered, so it's a no. A dropped call or an unclear answer is a no
too. Hotline never approves by default." Then:

```sh
hotline away off
```

## Scene 5: a scripted human on a fake phone [fake]

Say: "The call flows are tested end to end against a fake phone with scripted
humans."

```sh
pnpm exec vitest run --reporter verbose packages/daemon/test/conversational-approval.test.ts
```

Point at the test names: an allow only after the owner confirms the read-back, a
no to the read-back denies, a high-risk allow needs the PIN, and two unclear
replies text the ask instead and never approve.

Stop the daemon (Ctrl-C) before the phone scenes.

## Scene 6: a question by phone [phone: owner]

In the owner's real setup, start Claude Code in a project and type:

> Use ask_human to ask me which color the button should be: blue or green. Then
> continue with my answer.

The phone rings. On speaker: "Hey, it's your hotline ... Claude in
`<folder>` has a question", with the options read as numbers. Answer "green".
It repeats the decision back and hangs up. Cut to Claude Code continuing with
green.

## Scene 7: approving and denying by voice [phone: owner]

```sh
hotline away on
```

Ask Codex (or Claude Code) for a task that needs a command approval, such as
running the tests. When the phone rings, say "yeah, go for it". The voice reads
the request back in one short sentence ("Allow pnpm test in demo-app? Yes?");
say "yes", and the command runs. For a second request, say "nope": it is denied
at once, with no read-back.

Optional, high risk: a `git push` request asks for the PIN before it can be
allowed. Say: "Deleting files, pushing and installing need my PIN or a
confirming text."

## Scene 8: no pickup, so a text [phone: owner]

Let the next call ring out. A text arrives with the ask; reply `1` to choose an
option, or, for a permission, `YES` followed by the code in that text (a bare
`yes` is not an approval). Show the agent continuing. Say: "If I don't pick up, it texts. If
I never answer, the agent hears 'no answer'."

## Scene 9: away mode keeps the agent going [phone: owner]

With away mode on, let an agent finish its turn. The phone rings with a short
summary and "what next?". Say "now add tests for that". The agent starts a new
turn with that instruction. Say "that's it" on a later call to let it stop.

## Not in the demo yet

Calling the hotline yourself (HL-10) is built and tested against fakes only:
the PIN, the numbered status, and an instruction read back ("For session 1,
Claude in demo-app: run the tests. Send it?") that reaches the agent at its
next ask or Stop hook. Add that scene once a live call has been recorded in
the [live check](live-check.md).

## After recording

```sh
hotline away off
rm -rf "$DEMO"; unset DEMO HOTLINE_HOME
```

Check the recording for real phone numbers, tokens or file contents before you
share it. Record what the phone scenes showed (date, commit, what happened) in
[live-check.md](live-check.md#5-results-template).
