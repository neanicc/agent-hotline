# Contracts

The shapes every package shares, defined as zod schemas in `@hotline/core`
(`packages/core/src`). The schemas are the source of truth; this page explains
them and the rules they enforce. A change to a contract goes in its own PR that
updates every consumer, fixture and this page together
([team-plan.md](team-plan.md)).

Conventions:

- Records are strict: an unknown field is an error. Hook inputs from the agents
  are the one exception (see below).
- Timestamps are ISO 8601 UTC strings (`2026-10-13T21:58:00.000Z`). Core never
  reads the clock; callers pass times in.
- Phone numbers are E.164 (`+15555550100`). Use fake `+1555555 01xx` numbers in
  tests and fixtures.
- Ids are opaque strings of 1 to 128 characters.

## Records (`contracts.ts`)

### Session

One running Claude Code or Codex session that registered with the daemon.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | id | Assigned by the daemon |
| `agent` | `claude-code` \| `codex` | |
| `agentSessionId` | id, optional | The agent's own `session_id`, as its hooks report it |
| `cwd` | absolute path | |
| `nickname` | 1–60 chars | Spoken name, default "<agent> in <repo folder>", overridable in `config.nicknames` |
| `state` | `working` \| `waiting-on-human` \| `idle` \| `ended` | |
| `lastMessageSummary` | ≤ 500 chars, optional | Redacted before storage |
| `registeredAt`, `lastSeenAt` | timestamp | |

### Ask

Something an agent wants from the owner.

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `sessionId` | id | |
| `kind` | `question` \| `permission` \| `stop` \| `notify` | `stop` is the away-mode "what next?" after a turn ends |
| `text` | 1–1000 chars | Redacted, short. **Untrusted**: agent-written text can never approve anything |
| `options` | ≤ 9 unique strings, default `[]` | Questions only; read out as numbers and chosen by keypad |
| `toolName` | optional | Required for `permission` |
| `risk` | `low` \| `high`, default `low` | High risk needs the PIN or a confirming text to approve |
| `urgent` | boolean, default `false` | May call during quiet hours if `quietHours.allowUrgentCalls` |
| `createdAt`, `expiresAt` | timestamp | `expiresAt` must be after `createdAt` |
| `status` | `pending` \| `in-flight` \| `answered` \| `expired` \| `cancelled` | |

### Answer and Decision

An answer is recorded only from the owner's own words or keypresses.

| Field | Type | Notes |
| --- | --- | --- |
| `askId` | id | |
| `decision` | Decision | See below |
| `channel` | `voice` \| `sms` | |
| `ownerExcerpt` | 1–2000 chars, not blank | The owner's words, verbatim and untrimmed. Required: no excerpt, no decision |
| `sourceId` | id | Call (conversation id or call SID) or message SID that carried it |
| `confirmation` | `none` \| `pin` \| `text`, default `none` | How the owner proved it was them beyond caller ID. The daemon sets `pin` or `text` only from its own check (a PIN verified against the stored hash, or a confirming text from the owner's number on a verified webhook), never from model, tool or agent output |
| `answeredAt` | timestamp | |

`Decision` is one of `{type: "option", option: 1..9}`, `{type: "allow"}`,
`{type: "deny"}`, `{type: "text", text}` (not blank) or `{type: "done"}`. There
is deliberately no variant for silence, a timeout or an assumed answer.

`answerProblem(ask, answer, receivedAt)` returns why an answer cannot resolve an
ask, or `undefined`. `receivedAt` is the daemon's injected clock reading when the
answer arrived; core never reads the wall clock. Callers treat any problem as
"no answer". Before looking at the decision it rejects:

- an answer for a different ask;
- an ask whose `status` is not `pending` or `in-flight` (already `answered`,
  `expired` or `cancelled`), so a late answer cannot resolve an ask twice;
- an answer received (`receivedAt`) or given (`answeredAt`) at or after the ask's
  `expiresAt`, even if the stored status has not caught up yet;
- an invalid `receivedAt`.

| Ask kind | Accepted decisions |
| --- | --- |
| `question` | `option` within the offered options, or `text` |
| `permission` | `deny`; `allow` only if `risk` is `low` or `confirmation` is `pin` or `text` |
| `stop` | `text` (the next instruction) or `done` (let the agent stop) |
| `notify` | none |

### AskOutcome

What the agent gets back: `{outcome: "answered", answer}` or
`{outcome: "no-answer", askId, reason}` with `reason` one of `timeout`,
`no-pickup`, `unclear`, `dropped`, `failed`, `cancelled`. Every `no-answer`
denies a permission request and reports a question unanswered.

### CallRecord

| Field | Type | Notes |
| --- | --- | --- |
| `id` | id | |
| `provider` | `elevenlabs` \| `fake` | |
| `direction` | `outbound` \| `inbound` | |
| `providerIds` | `{conversationId?, callSid?}` | |
| `askIds` | ids | Several when asks were batched; at least one for an outbound call |
| `outcome` | `answered` \| `no-answer` \| `failed` \| `rejected` | |
| `startedAt`, `endedAt?` | timestamp | `endedAt` not before `startedAt` |
| `durationSeconds` | ≥ 0 | |
| `costEstimateCents` | ≥ 0 | US cents, for the `hotline doctor` monthly estimate |

## Config (`config.ts`)

`config.json` in the hotline home: `$HOTLINE_HOME` if set (absolute), else
`~/.hotline`. The daemon's `loadConfig` reads it and refuses a file that other
users can read or write (it holds the PIN hash), so it must be mode `0600`.
`parseConfig` / `parseConfigText` validate and fill defaults; errors list
`path: message` lines and never quote the file's contents.

| Setting | Default | Notes |
| --- | --- | --- |
| `version` | required, `1` | |
| `owner.phoneNumber` | required | The only number Hotline calls, texts or answers |
| `owner.pinHash` | required | `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>`, base64url salt ≥ 16 bytes and hash ≥ 32 bytes, 15 ≤ log2 N ≤ 20, 1 ≤ r ≤ 16, 1 ≤ p ≤ 4. Never the PIN itself |
| `quietHours.timeZone` | required | IANA name, such as `America/Toronto` |
| `quietHours.start` / `end` | `22:00` / `08:00` | `HH:MM`, may wrap past midnight. Always on |
| `quietHours.allowUrgentCalls` | `false` | |
| `rateLimits.callsPerHour` / `callsPerDay` | 4 / 20 | Minimum 1: limits cannot be switched off |
| `rateLimits.textsPerHour` / `textsPerDay` | 10 / 50 | Minimum 1 |
| `policy.batchWindowSeconds` | 20 | Asks within the window share one call |
| `policy.askTimeoutMinutes` | 30 | Then "no answer" |
| `policy.maxConsecutiveContinuations` | 5 | Away-mode Stop continuations in a row (1–20) |
| `voice.provider` | `elevenlabs` | or `fake` |
| `voice.voiceId`, `agentId`, `agentPhoneNumberId` | unset | ElevenLabs ids, set by `hotline init` / `hotline voice set` |
| `sms.provider` | `twilio` | or `fake` |
| `sms.fromNumber` | unset | The Twilio number |
| `tunnel.publicUrl` | unset | Bare `https://` origin, no path, query or credentials |
| `daemon.port` | 7341 | The agent API always binds 127.0.0.1 |
| `secrets.store` | `auto` | `auto` = Keychain on macOS, file elsewhere; or `keychain`, `file` |
| `nicknames` | `{}` | Repo folder name to spoken nickname |

The PIN hash's scrypt cost is capped so a hostile or corrupt config cannot hang
or crash the inbound-call PIN check; `parsePinHash` returns `undefined` outside
the range, and a verifier treats that as a failed check. scrypt needs
`128 * r * (N + p + 2)` bytes, which `pinScryptMaxmem` computes; the verifier
passes it as `maxmem` to Node's `crypto.scrypt`, because the 32 MiB default is
already too small at the minimum cost (`scrypt$15$8$1` needs 32 MiB plus 3 KiB).
At the caps it is just over 2 GiB.

Unknown keys are rejected. A key that looks like a credential (`token`, `secret`,
`password`, `apiKey`, `auth`, `sid`, ...) gets a message pointing to the secret store.

## Secrets (`secrets.ts`)

Secrets never live in the config. `SecretName` lists them: `daemon.apiToken`,
`elevenlabs.apiKey`, `elevenlabs.toolSecret`, `elevenlabs.webhookSecret`,
`twilio.accountSid`, `twilio.authToken`. A value is one line of printable ASCII
(1–4096 chars).

`SecretStore` has `get` (undefined when unset), `set` and `delete` (missing is
fine). The daemon package implements it:

- `KeychainSecretStore`: generic passwords in the login Keychain, service
  `agent-hotline`, account = secret name, through `/usr/bin/security`. Values are
  written with `security -i` on stdin in hex (`-X`), so a secret never appears in a
  process argument list, and read back to confirm the write. Exit 44 means "not set".
- `FileSecretStore`: `secrets.json` in the hotline home,
  `{"version": 1, "secrets": {...}}`, written atomically with mode `0600` in a
  `0700` directory. A file other users can access is refused. `set` and `delete`
  are read-modify-write steps queued per file path within the process, so
  overlapping calls do not lose each other's changes; two processes writing the
  same file at once are not coordinated.
- `openSecretStore` picks one from `config.secrets.store` and the platform.

Both the config and the secrets file are read and written only when neither the
file nor its directory is a symlink, both belong to the current user, the file
has no group or other permission bits (`0600`), and the directory has none
either (`0700`). Hotline refuses rather than repairs: the error names the path
and the `chmod` to run. A Keychain store failure reports only `security`'s exit
code, because interactive mode can echo the command and its hex-encoded value.

Tests use an injected fake `security` and temporary directories; they never touch
the real Keychain or home directory.

**Known limitation: same-user access.** Neither store protects secrets from other
processes running as the owner's own user account, coding agents included. A
Keychain item that `/usr/bin/security` added lists that binary as trusted, so any
same-user process can run `security find-generic-password -s agent-hotline -a <name> -w`
and read it without a prompt. The `0600` file is just as readable to that user.
The stores protect against other accounts and against secrets landing in the
repository, config or process lists, not against the owner's own processes. This
does not let an agent approve anything: decisions come only from the owner's own
words on the owner's phone, high-risk approvals also need the PIN or a confirming
text, and the PIN is stored only as a scrypt hash. An agent holding the Twilio or
ElevenLabs keys could still place calls or texts on the owner's account, or forge
a provider webhook to the daemon. The daemon token likewise lets an agent talk to
the local API, which it is meant to do.

## Text replies (`sms-reply.ts`)

`parseSmsReply(body)` classifies one text from the owner. Matching is on the
whole message, case-insensitive, with spaces collapsed and trailing `.`, `!` or
`?` dropped:

| Reply | Result |
| --- | --- |
| `call me`, `call` | command `call-me` |
| `status` | command `status` |
| `stop` and Twilio's other opt-out keywords (`stopall`, `unsubscribe`, `end`, `quit`, `cancel`, `revoke`, `optout`) | command `stop`: stop texting me. Twilio blocks texts to the number after these until `START`, so they all mean the same |
| `start`, `unstop`, `help`, `info` | `carrier-keyword`: Twilio answers these itself; never an answer |
| `1` to `9`, optionally `#2` | `option` |
| `yes`, `y`, `yeah`, `yep`, `yup`, `approve`, `approved`, `allow` | `yes` |
| one of those, a space and 4 to 10 digits (`yes 482913`) | `yes` with a confirmation `code` |
| `no`, `n`, `nope`, `deny`, `denied`, `reject` | `no` |
| `done`, `all done`, `that's it`, `thats it`, `nothing` | `done` |
| anything else (`ok`, `yes please`, `yes but not on main`) | `text`, verbatim |

`smsAnswer({ask, body, messageSid, receivedAt, confirmationCode})` turns a text
into an `Answer` (channel `sms`, the body verbatim as `ownerExcerpt`, the message
SID as `sourceId`), or `{outcome: "no-answer", reason}`:

| Ask kind | Answered by |
| --- | --- |
| `question` | an offered option number, or any other non-command text verbatim (a number is text when no options were offered) |
| `permission` | `no` denies. `yes` allows a low-risk request. A high-risk one needs `yes <code>` with the one-time code the daemon put in the text it sent, which sets `confirmation: "text"`. A wrong code, or a code when none was sent, is no answer |
| `stop` | `done` or `no` lets the agent stop; other text is the next instruction; `yes` is no answer |
| `notify` | nothing |

Commands, carrier keywords, empty or over-long texts and anything
`answerProblem` rejects are no answer. Free text never approves: only an exact
yes word does. Call `smsAnswer` only for a text from the owner's number on a
verified webhook, since `confirmation: "text"` rests on that check. The owner's
PIN is never accepted by text, so it never passes through Twilio.

## SMS providers (`@hotline/providers`)

`SmsProvider.sendToOwner(text)` is the only way to send a text. A provider is
created with the owner's number and has no recipient parameter, so it cannot text
anyone else. Every text goes through the injected `redact` function first and
must be 1 to 1600 characters after it. Failures reject with `SmsSendError`
carrying the HTTP status and Twilio's numeric error code, never Twilio's message
text (it can quote numbers).

- `TwilioSmsProvider`: one form-encoded `POST` to
  `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json` with
  HTTP Basic auth (account SID and auth token), a 10 second timeout, and a
  required, injected `fetch` so tests never reach the network.
- `FakeSmsProvider`: records what it sent, with Twilio-shaped SIDs, and can be
  told to fail the next send (default: Twilio 21610, recipient opted out).
- `twilioSignature`, `twilioSignaturePayload` and `validTwilioSignature`
  implement Twilio's `X-Twilio-Signature` algorithm; the tests reproduce
  Twilio's documented example.

## Hook payloads (`hooks.ts`)

Schemas for what Claude Code and Codex send to `PermissionRequest` and `Stop`
command hooks on stdin, and for what Hotline prints. Fixtures with source links
are in
[`packages/agents/test/fixtures/hooks`](../packages/agents/test/fixtures/hooks/README.md).

Inputs are parsed loosely (unknown fields kept, since agents add fields between
releases) but require what the adapters use: `session_id`, `cwd`,
`hook_event_name`, plus `tool_name` and `tool_input` for `PermissionRequest`, and
`stop_hook_active` for `Stop`. Codex inputs also require `model`,
`permission_mode` (any string: five modes are documented today, and a new one
must not stop every payload from parsing), `turn_id` and a nullable
`transcript_path`; Codex `Stop` has a nullable `last_assistant_message`. An
adapter that cannot parse its input never approves: it leaves a permission
request to the agent's own terminal prompt and lets a stopping agent stop.

Outputs are strict and narrower than what the agents accept:

| Event | Output Hotline prints |
| --- | --- |
| `PermissionRequest`, allow | `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}` |
| `PermissionRequest`, deny | Same with `{"behavior": "deny", "message": "..."}`. Claude Code also accepts `interrupt`; Codex fails closed on it, so Codex output never has it |
| `Stop`, continue | `{"decision": "block", "reason": "<the owner's instruction>"}` (non-blank) |
| `Stop`, let it stop | Nothing on stdout, exit 0 |

Hotline never sends `updatedInput` or `updatedPermissions`, and never applies a
`permission_suggestions` entry: it only answers the prompt the agent would show
in the terminal. The adapters that print these are in `packages/agents`; see
[hooks.md](hooks.md).

## Permission risk (`permission-risk.ts`)

`classifyPermission({toolName, toolInput, cwd})` returns `{risk, reasons}`:
`high` (needs the PIN or a confirming text to approve) for deleting files, git
push or history rewrites, network installs and downloads, writes outside the
project, credentials or agent settings, `sudo`, nested shell code, unknown and
MCP tools, and input it cannot read; `low` otherwise. Pure: paths are resolved
as POSIX strings (`resolvePosix`, `insideProject`), never on the file system.
The full table is in [hooks.md](hooks.md#risk-classes-plan-question-6).

## Ask queue and call policy (`queue.ts`, `policy.ts`)

The queue decides who to call or text, when, and what each agent gets back. It is
a pure state machine: the daemon owns a `QueueState` (plain JSON), passes every
event to `step(state, event, now, settings)` with its own clock reading, carries
out the returned actions in order, and sends a `tick` at
`nextWakeAt(state, now, settings)`, which is never earlier than `now` and is `now`
itself when work is overdue (say, after restoring saved state). Core never reads the clock, sets a timer or
does I/O; `packages/core/test/purity.test.ts` scans the sources to keep it so.
`policySettings(config)` builds the settings from a parsed config.

| Event | Meaning |
| --- | --- |
| `ask` | A new ask. It must parse and be `pending`; an id already queued is ignored |
| `tick` | Time moved on |
| `answer` | An owner answer from `submit_answer` or a text reply |
| `unclear` | The owner was asked (the ask is on the call in progress or texted) but the answer stayed unclear |
| `call-ended` | The call in progress ended: `answered`, `no-pickup`, `dropped` or `failed` |
| `text-sent` | The text for an ask went out; ends a notification as `delivered` |
| `text-failed` | The text for an ask could not be sent |
| `cancel` | The agent stopped waiting |
| `call-me` | The owner texted `call me`. The daemon sends it only for an inbound text it verified came from the owner's number. Not an answer |

| Action | What the daemon does |
| --- | --- |
| `place-call {callId, askIds}` | One call covering these asks, read in this order |
| `end-call {callId}` | Hang up this call if it is still live: it was never reported as ended and has been given up on |
| `send-text {askId, reason}` | Text the owner this ask; `reason` is `notify`, `quiet-hours`, `call-limit` or `after-call` |
| `resolve {askId, outcome, status}` | Final: return the `AskOutcome` to the agent, store the ask with `status` (`answered`, `cancelled`, or `expired` for every other no-answer). If the ask is on the live call (it expired or was cancelled mid-call), tell the voice side to drop it; a later answer for it is ignored |
| `delivered {askId}` | Final for a `notify` ask, after `text-sent` |
| `ignored {event, reason}` | The event changed nothing; log it, never treat it as an answer |

Rules:

- **Answers.** An `answered` outcome comes only from an `answer` event that parses
  as an `Answer`, is for an open ask, arrives on a channel the ask actually went
  out on (voice only while the ask is on the call in progress, so the daemon must
  deliver `submit_answer` before that call's `call-ended`; SMS only after it was
  texted), and
  passes `answerProblem` at the moment it arrived. Anything else is ignored and the
  ask stays open. A high-risk approval without the PIN or a confirming text is
  ignored, so the owner can still confirm before the ask expires.
- **Silence is not consent.** No pickup, a dropped or failed call, an unclear
  answer, a failed text, cancellation and expiry all end in `no-answer`. An ask
  that expires reports the last failure (`no-pickup`, `dropped`, `failed`) or
  `timeout`. `permissionVerdict(ask, outcome)` turns an outcome into `allow` only
  for an owner approval of that permission ask, with confirmation when it is high
  risk; every other input, malformed ones included, is `deny`.
  `stopInstruction(ask, outcome)` returns the owner's next instruction only for
  a `text` answer to that stop ask; `done`, any no-answer and malformed input
  return undefined, which lets the agent stop.
- **Priority.** Urgent asks first, then `permission`, `question`, `stop`,
  `notify`, then oldest, then id.
- **Batching.** A new ask waits `policy.batchWindowSeconds`. When any callable ask
  is due and no call is in progress, one call covers every callable waiting ask,
  highest priority first, at most `DEFAULT_MAX_ASKS_PER_CALL` (4). New asks still
  in their batch window join; an ask waiting out a retry delay does not. There is
  one call at a time. A call never reported as ended is given up on after
  `DEFAULT_CALL_STUCK_MINUTES` (15): the queue emits `end-call` and treats it as
  dropped.
- **Dedupe** applies to `question` and `notify` asks only. One with the same
  session, kind, text, options, tool and risk as an open ask joins it: it is never
  contacted itself, shares the owner's answer (re-checked with `answerProblem`
  against the duplicate) or an unclear result, and takes over if the first ask is
  cancelled, expires or fails. A shared answer always has `confirmation: "none"`:
  a PIN or confirming text is never copied from one ask to another. `permission`
  and `stop` asks are never deduped, because `text` is a redacted, length-capped
  summary and two different commands can share it. Each gets its own decision,
  though one call can read several of them out.
- **Quiet hours** (start inclusive, end exclusive, local time in
  `quietHours.timeZone`, equal start and end meaning none): asks are texted. Only
  urgent asks are called, and only when `allowUrgentCalls` is set, plus the one
  call the owner asks for with `call me`.
- **Call me.** A `call-me` event asks for one call now.
  - *Who is on it.* Open asks that are not notifications, not duplicates, not past
    their expiry, and waiting or already texted: highest priority first, at most
    `DEFAULT_MAX_ASKS_PER_CALL`.
  - *What it overrides.* Quiet hours, the batch window, a retry delay and an
    earlier fallback to text (`after-call`, the only reason an ask is held to
    text), for that call only. Later asks and retries follow the normal rules.
  - *What it never overrides.* The call limit: over it the event is `ignored`
    ("over the call limit; open asks keep going by text") and the asks carry on
    by text. A call in progress: `ignored` ("a call is already in progress"); a
    call past the stuck-call timeout is hung up with `end-call` first and does not
    count. With nothing to call about it is `ignored` ("no open asks to call
    about"). The daemon may reply to the owner from these reasons, since
    `send-text` always carries an ask.
  - *Not an answer.* Each ask on the call still needs the owner's own words.
    `place-call` names asks, never a number: the daemon dials only the configured
    owner number.
  - *After the call.* An ask that was texted before it and is still open goes back
    to awaiting its text reply (no retry, no second text); if it then expires the
    reason is `timeout` (the unanswered text), not the call's result. A
    `text-sent` or `text-failed` may arrive while it is on the call: a failed text
    marks it as not texted (no SMS reply counts) and, when the call ends, it
    follows the usual no-pickup rules, which text it again. An ask never texted
    follows the usual no-pickup rules. A call-me call counts as a call attempt for
    each ask on it, so it uses up automatic retries (`DEFAULT_MAX_CALL_ATTEMPTS`).
  - *Daemon duties.* Send `call-me` only for an inbound text verified as coming
    from the owner's number, and deliver each inbound text once (dedupe on the
    provider message id). The queue has no call-me cooldown beyond the call limit
    and one call at a time, so a redelivered webhook could otherwise place a
    second call.
- **Rate limits** count over a rolling hour and a rolling 24 hours; a send stamped
  after `now` (the clock moved back) still counts. With no call
  left, a due ask is texted; with no text left either, it waits for a slot or its
  expiry.
- **No pickup.** A call that is not picked up or fails is retried once after
  `DEFAULT_RETRY_DELAY_SECONDS` (120); then the ask is texted. After a dropped
  call, or a call that ended with the ask still open, it is texted at once. An
  unclear answer ends the ask; it is not retried by text.
- **Notifications** (`notify`) only ever go by text and need no answer. They end
  with `delivered` once the daemon reports `text-sent`, or as `no-answer`
  (`failed` or `timeout`) when the text fails or never goes out.
