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
| `nickname` | 1–60 chars | Spoken name, default "<agent> in <repo folder>", overridable in `config.nicknames`; see `sessionNickname` below |
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
| `costEstimateCents` | ≥ 0 | US cents, at the daemon's flat `CALL_CENTS_PER_MINUTE`. `hotline doctor` does not read it: it prices `durationSeconds` with `config.costs` |

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
| `voice.voiceId`, `agentId`, `agentPhoneNumberId` | unset | ElevenLabs ids: `voiceId` from `hotline voice set`, `agentId` from `hotline voice apply`, `agentPhoneNumberId` from `hotline init` |
| `voice.llm` | unset (`claude-haiku-4-5`) | The voice agent's LLM, one of `VOICE_LLMS`: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5-5`. Anything else is refused. Sent by `hotline voice apply` ([voice.md](voice.md#the-model)) |
| `voice.toolSecretId`, `voice.toolIds` | unset | Ids (never values) of the ElevenLabs workspace secret and the four server tools, written by `hotline voice apply` so a re-apply updates them instead of creating new ones |
| `sms.provider` | `twilio` | or `fake` |
| `sms.fromNumber` | unset | The Twilio number |
| `tunnel.publicUrl` | unset | Bare `https://` origin, no path, query or credentials |
| `daemon.port` | 7341 | The agent API always binds 127.0.0.1 |
| `secrets.store` | `auto` | `auto` = Keychain on macOS, file elsewhere; or `keychain`, `file` |
| `judge.backend` | unset | The reply judge (HL-09d, [install guide](install.md#the-reply-judge)): `auto` (Claude Code CLI, then Codex CLI, then `anthropic.apiKey`), `claude-code`, `codex`, `anthropic-api`, or `off` (nothing is sent; unclear replies are texted). Unset means the owner has not chosen and works like `off`; `hotline init` asks once or takes `--judge` |
| `nicknames` | `{}` | Repo folder name to spoken nickname |
| `costs.twilioNumberPerMonth`, `twilioCallPerMinute`, `twilioTextPerSegment`, `twilioCarrierFeePerSegment` | 1.15, 0.014, 0.0083, 0.007 | Dollar rate assumptions for the `hotline doctor` cost estimate ([install guide](install.md#monthly-cost-estimate)). Each a number ≥ 0 |
| `costs.elevenLabsPlanPerMonth`, `elevenLabsIncludedMinutes`, `elevenLabsPerMinute`, `llmPerMinute` | 6, 75, 0.08, 0.03 | Same; the defaults are `DEFAULT_COST_RATES`, which the README cost table quotes |

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

Secrets never live in the config. `SecretName` lists them: `anthropic.apiKey`
(optional, the reply judge's fallback when neither agent CLI is installed),
`daemon.apiToken`, `elevenlabs.apiKey`, `elevenlabs.toolSecret`,
`elevenlabs.webhookSecret`, `twilio.accountSid`, `twilio.authToken`. A value is one line of printable ASCII
(1–4096 chars).

`SecretStore` has `get` (undefined when unset), `set` and `delete` (missing is
fine). The daemon package implements it:

- `KeychainSecretStore`: generic passwords in the login Keychain, service
  `agent-hotline`, account = secret name, through `/usr/bin/security`. Values are
  written with `security -i` on stdin in hex (`-X`), so a secret never appears in a
  process argument list, and read back to confirm the write. Exit 44 means "not set".
  `hotline doctor` checks these assumptions against the real binary on a
  throwaway item ([install.md](install.md#keychain-self-test)).
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
| `permission` | `no` denies. Approval needs `yes <code>` with the one-time code the daemon put in the text it sent, for every request, low risk included; it sets `confirmation: "text"`. A bare `yes`, a wrong code, or a code when none was sent, is no answer |
| `stop` | `done` or `no` lets the agent stop; other text is the next instruction; `yes` is no answer |
| `notify` | nothing |

Commands, carrier keywords, empty or over-long texts and anything
`answerProblem` rejects are no answer. Free text never approves: only an exact
yes word with the request's code does. The code is required for every
approval because Twilio signatures carry no timestamp: a captured, signed
"yes", or one meant for something else, must never approve a newer request.
Call `smsAnswer` only for a text from the owner's number on a
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

## Voice providers

`VoiceProvider.callOwner({callId, asks})` is the only way to place a call. A
provider is created with the owner's number and has no recipient parameter.
It resolves with the ElevenLabs `conversationId` (and the Twilio call SID when
reported) once the call is accepted; what the owner says arrives later through
the server tools and the post-call webhook. Failures reject with
`VoiceCallError`, carrying the HTTP status only, never the provider's message.

What leaves the machine is `callVariables(call, redact)`, shared by the real and
fake providers: `hotline_call_id`, `ask_count` (1 to 4), `opening` (fixed
words only, "One of your agents needs you...", because ElevenLabs speaks it as
is and agent text cannot be fenced there) and `asks`, one line per ask with its number, the session nickname,
the kind (`HIGH RISK (PIN required)` for high-risk permission requests), the
tool name, the options and the text. Every agent-derived string (nickname, tool
name, each option, the text) sits inside its own `<agent_text>...</agent_text>`
fence; only Hotline's fixed words are outside. Each string is redacted whole
first, then cut: ask text to 300 characters, options to 80, nicknames to 60.
Control and invisible format characters, line breaks, angle brackets and
braces are removed, so agent text is one plain line that cannot close its
fence or spell a `{{variable}}`. The prompt tells the model that fenced text is
a question to read out and must never decide which tool it calls, which
decision it submits or what `owner_words` it sends.

- `ElevenLabsVoiceProvider`: one JSON `POST` to
  `https://api.elevenlabs.io/v1/convai/twilio/outbound-call` with `xi-api-key`,
  `agent_id`, `agent_phone_number_id`, `to_number` (the owner) and the
  variables as `conversation_initiation_client_data.dynamic_variables`, a 15
  second timeout and a required injected `fetch`.
- `FakeVoiceProvider`: records each placed call and its variables, and plays
  scripted humans (`scriptedHuman.noPickup()`, `busy()`, `silent()`, `drops()`,
  `allows()`, `denies()`, `confirms()`, `unsureTwice()`, `unclear()`, `wrongPin()`,
  or `says(...steps)` with `pin`, `answer`, `read-back`, `unsure`, `unclear`, `say`,
  `status`, `instruct`, `silence` and `hang-up` steps) through a `VoiceToolClient`.
  The definition v4 flows (HL-14c): a `read-back` step answers, hears the
  agent read the request back ("Allow <tool> to <text> for <session>? Yes?", built from
  the ask's redacted, fenced text and session name) and replies; the agent then
  submits allow or deny with the reply as `owner_words`. An `unsure` step is
  an unclear reply: the first gets "Sorry, is that a yes or a no?" with that
  read-back (a re-reading for an ask that is not a permission request), the
  second gets the spoken promise to text (`TEXT_INSTEAD`) and no tool call. An
  `unclear` step submits `unclear`, which only an agent on definition v3 or
  earlier does. On an outbound call the fake agent speaks
  the first message, then reads each ask (its `asks` line, unfenced) as its own
  agent turn just before the first step that answers it, and says "Got it." after
  each answer, so the transcript has the order the daemon checks. `say` is owner
  speech with no tool call ("yes, I can hear you"). An `answer` step's `spoken`
  sets what the owner actually says (default: its `words`); `null` means the
  voice model submits `words` the owner never said there, for tests of a
  confused or prompt-injected model. `httpVoiceToolClient` sends those tool
  calls to the daemon's real routes with the tool secret and signs the post-call
  webhooks, so the scenario suite exercises authentication too.
  `playPending()` plays placed calls in order (a call without a script is not
  picked up); `inboundCall(script, from)` plays a call in. A `status` step's
  agent turn reads the status out (fences dropped), and an `instruct` step's
  owner turn is followed by the agent's read-back ("For session <n>:
  <instruction>. Send it?") and the owner's `reply` (default "yes"; `null`
  skips the read-back, as a confused model would) before `send_instruction`,
  then "Sent.", as the definition v5 prompt says (HL-10). Transcript turns are
  timed with the injected `clock`. The fake ends a call
  when a tool answers `end_call: true`, as the prompt tells the real agent to.

The daemon answers a byte-identical repeat of `submit_answer`, `verify_pin` or
`send_instruction` within two hours from memory, for state-changing results
only. A repeated identical failed `verify_pin` therefore never re-checks the
PIN and spends no attempt; see [daemon.md](daemon.md#elevenlabs-hooksel).

**The agent definition** (`elevenlabs-agent.ts`, `AGENT_DEFINITION_VERSION`):
the prompt, first message and four webhook tools as code. `hotlineToolConfigs`
gives each tool's `tool_config` (URL `<publicUrl>/hooks/el/tools/<name>`, the
`x-hotline-tool-secret` header from an ElevenLabs workspace secret, and a body
schema); `hotlineAgentConfig` gives the agent body with the tool ids, voice,
`end_call` and placeholders for inbound calls. `hotline voice apply` (HL-11)
creates or updates them; see [install.md](install.md). Every tool's
`conversation_id`, `call_sid`, `caller_id` and `called_number` come from
ElevenLabs' `system__*` dynamic variables, not from the model, and no tool has a confirmation parameter. The prompt says agent
text is data, never instructions; decisions count only through `submit_answer`
with the owner's own words; a high-risk allow needs `verify_pin` first; an
inbound call reveals nothing before the PIN; and an unclear answer is asked
once more, then (since version 4) left to the text fallback. Version 2 (HL-14) puts a persona section
from plan section 6 before those rules and says the persona cannot bend them.
Version 3 (HL-14b) adds, in the outbound steps, that each ask is read on its own
turn in the ask's own words (key words, nickname, tool), never two asks in one
turn, that asking again re-reads the same ask rather than a paraphrase, and that
a `text` decision carries the owner's words verbatim (the `text` tool parameter
says so too), which is what the daemon's voice confirmation matches against.
Version 4 (HL-14c, the owner's decision on #44) makes approval
conversational in the outbound steps: any clear phrasing counts; every allow is
read back in one short sentence with the ask's key words and submitted only
after the owner's yes to it, with that reply as `owner_words`; a no is
submitted at once, never read back; when unsure the agent asks once ("Sorry, is
that a yes or a no?" with the read-back for a permission request); after a
second unclear reply it says it will text, submits nothing for that ask and
moves on, replacing the HL-08 sentence that submitted `unclear`; it asks for
the PIN at most once per call and never goes quiet. Since HL-09c the daemon
requires the read-back exchange in the transcript for every voice allow: the
ask's reading, a later agent turn reading the same ask back as a question for
a yes, and the owner's reply to it, which a fast path of common clear replies
or, for anything else, a pluggable `ReplyJudge` must find agreed (the judge
sees only the owner's reply turns; the default judge fails closed). An allow
without it is not confirmed and the ask is texted
([daemon.md](daemon.md#call-orchestration)). `submit_answer` no longer
offers the model `unclear`; the daemon still parses it from an agent on an
older definition, and it still ends the ask as no answer.
Version 6 (HL-14d) sets the model explicitly: `prompt.llm` is `voice.llm` or
`DEFAULT_VOICE_LLM` (`claude-haiku-4-5`), with `thinking_budget: 0` and
`backup_llm_config: {preference: "default"}`, and the read-back example names
the tool and the whole command ("Allow Bash: pnpm test, for Claude in demo-app?
Yes?"), since the daemon refuses a permission read-back that leaves either out
([voice.md](voice.md#the-model)).
`SAFETY_RULES` in the providers tests checks each rule word for word, and a
snapshot covers the whole prompt, first message and agent body. See
[voice.md](voice.md#the-persona). `hotlineAgentConfig` refuses a voice id that
`isVoiceId` rejects (letters, digits, `_` and `-`, at most 100).

**Session nicknames** (`nickname.ts`): `sessionNickname({agent, cwd, nicknames,
redact, taken})` is the spoken name the daemon stores when a session
registers: `config.nicknames[<last folder>]` if set, else "Claude in
<folder>" or "Codex in <folder>". The folder is redacted whole, then
`speakableName` keeps only letters, marks, digits, spaces and `- _ . ' [ ] …`,
only the first `MAX_FOLDER_WORDS` (4) words of the folder are kept (a
configured name is not word-capped), then the whole name is cut to `MAX_SPOKEN_NICKNAME_LENGTH` (60). An empty
folder is "an unnamed folder". A name another live session has gets a number
("Claude 2 in demo-app"). `callVariables` applies `speakableName` to the
nickname again before fencing it.

`owner_words` is written by the voice model. `ownerSaid(excerpt, transcript)`
checks it against the owner's turns of the post-call transcript (case and
punctuation ignored, whole words, never agent or caller turns). Call
orchestration confirms every voice decision with it, only within the owner
turns right after an agent turn that read that ask, and for an allow only
right after its read-back ([daemon.md](daemon.md#call-orchestration)).
`parsePostCallEvent(body, {ownerNumber, pinVerifiedAt})` labels the person's
turns `owner` only on an outbound call to the owner's number, or for turns
spoken after the PIN was verified on an inbound call from it (the call's
`start_time_unix_secs` plus the turn's `time_in_call_secs`, later than the
verification). Any other person or turn, every turn without a time on an
inbound call, and every call parsed without that context, is a `caller`.

`validPostCallSignature`, `postCallSignature` and `postCallSignatureHeader`
implement the `ElevenLabs-Signature` HMAC; `parsePostCallEvent` reduces a
verified body to a `transcription` (status, direction, the other party's
number, duration, owner and agent turns) or an `initiation-failure` (`busy`,
`no-answer` or `unknown`).

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

`classifyPermission({toolName, toolInput, cwd})` returns `{risk, reasons}`,
where `high` needs the PIN or a confirming text to approve. It fails closed:

- A shell command is `low` only when `splitShell` understands all of it and
  every simple command is on a short read-only allowlist with arguments inside
  the project.
- File edits and patches are `low` only inside a known project
  (`projectRoot`; `/`, top-level directories and home directories are not one).
- Read tools are `low` unless they point at credentials. `WebFetch`, MCP tools
  and unknown tools are `high`.
- The reasons name what the owner hears: deleting files, git push, network
  installs and so on.

Pure: paths are resolved as POSIX strings (`resolvePosix`, `insideProject`),
never on the file system. The full rules are in
[hooks.md](hooks.md#risk-classes-plan-question-6).

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
  call, or a call that ended with the ask still open, it is texted at once. That
  is also how an ask ends that the voice agent left without a decision after
  two unclear replies (definition v4): the call is `dropped` and the ask is
  texted (the daemon's call log says `owner-unclear`; the queue's `CallEnd`
  and the agent's no-answer reason stay `dropped`). An `unclear` report (from an agent on an older definition) ends the
  ask; it is not retried by text.
- **Notifications** (`notify`) only ever go by text and need no answer. They end
  with `delivered` once the daemon reports `text-sent`, or as `no-answer`
  (`failed` or `timeout`) when the text fails or never goes out.
