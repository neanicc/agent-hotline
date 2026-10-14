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
| `POST /v1/sessions` | Registers `{agent, cwd, agentSessionId?}` and returns `{session}` (201). A live session with the same agent and `agentSessionId` is reused (200) |
| `POST /v1/sessions/:sessionId/asks` | Queues `{kind, text, options?, toolName?, risk?, urgent?}` and returns `{ask}` (201). `kind` is `question`, `notify`, `permission` or `stop`. Only questions carry `options`; `permission` requires `toolName` (identifier characters, up to 100) and `risk` (`low` or `high`), and no other kind may send them. Text, options and the tool name are redacted before they are stored. The ask expires after `policy.askTimeoutMinutes`. Open-ask caps per session / across all sessions: questions 3 / 10, notifications 10 / 30, permission requests 3 / 10, stops 1 / 10; past them `429` (audited as `ask.refused`). A new `stop` cancels the session's older open `stop` first. `urgent` is the agent's request only; call policy decides |
| `GET /v1/asks/:askId/outcome?waitSeconds=0..30` | `{state: "waiting", ask}` or `{state: "final", ask, outcome}`, waiting up to `waitSeconds` for a change |
| `POST /v1/asks/:askId/cancel` | Cancels an ask that is still open: `{cancelled}` |
| `POST /v1/sessions/:sessionId/end` | Marks the session `ended` and cancels its open asks: `{ended}`. An ended session takes no new asks (`404`) |
| `GET /v1/sessions/:sessionId/inbox` | `{session, instructions, asks}`: owner instructions (always empty until HL-10 adds the queue) and the 20 newest asks with their outcomes |

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
- **Verify:** the signature is recomputed with Twilio's documented algorithm
  (`validTwilioSignature` in `@hotline/providers`) over the exact public URL
  (`publicUrl` origin plus the raw path and query) and the form parameters, and
  compared in constant time. A repeated parameter name, or an `AccountSid` other
  than ours, fails.
- **Owner only:** only a text from `owner.phoneNumber` to `sms.fromNumber`
  reaches the handler. Any other sender gets one generic reply ("Sorry, this
  number does not accept messages."), at most 5 per hour in total, and is
  recorded in the audit log by message SID only.
- **Once per message:** the last 1000 successfully handled message SIDs are
  remembered, so a Twilio retry or a replayed request is answered with empty
  TwiML and not handled twice. A SID counts as handled only after its handler
  succeeds: a failure (owner handler or the other-sender audit write) leaves it
  unhandled so Twilio's retry can get through, and a copy that arrives while
  the first is still being handled waits for that attempt, then either answers
  with empty TwiML or, if the attempt failed, handles the message itself.
  Durable replay protection is HL-13.
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

Known limit: the PinGate's attempt counters, its verified calls and both replay
memories are in memory, so a daemon restart resets them. Per-call limits (2
wrong PINs) still apply after a restart; the hourly budget starts again.
Persisting them is HL-13 work.

`elevenLabsRoutes` (`elevenlabs-webhook.ts`) serves the voice agent's four
server tools and the post-call webhook. `runDaemon` registers them only when
`voice.provider` is `elevenlabs`, `voice.agentId` and `tunnel.publicUrl` are set,
and the `elevenlabs.toolSecret` and `elevenlabs.webhookSecret` secrets exist.
Otherwise it logs `voice webhooks off` with the reason and the paths stay a
`403`. The tool definitions that point ElevenLabs at these URLs are in
`@hotline/providers` (`hotlineToolConfigs`; see [contracts](contracts.md#voice-providers)).

**Server tools** (`POST /hooks/el/tools/<name>`):

- **Precheck:** the `x-hotline-tool-secret` header must equal
  `elevenlabs.toolSecret`, compared in constant time (both sides hashed with
  SHA-256), and the content type must be JSON, or `403` before the body is
  read. An empty secret never matches. `verify` repeats the secret check.
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
  reads, after the PIN, and runs every time. The memory does not survive a
  restart (HL-13).
- **Owner on the call:** the body's `caller_id` or `called_number`, which
  ElevenLabs fills from `system__caller_id` and `system__called_number`, must be
  `owner.phoneNumber`. Otherwise the answer is `{"result": "refused",
  "end_call": true}` and no handler runs. The voice model cannot set these
  fields: they are dynamic-variable parameters, not model-filled ones.
- A verified request whose JSON or fields do not parse gets `{"result": "invalid"}`.

| Tool | What the route does |
| --- | --- |
| `verify_pin` | Checks the PIN with the `PinGate`: 2 wrong PINs per call, then `end_call: true` and no further checks on that call; 6 wrong PINs across all calls of one direction in a rolling hour, or 10 in a rolling day, lock every check on that direction, the right PIN included, until enough time has passed. A caller spoofing the owner's number therefore gets at most 10 guesses a day (0.1% of a 4-digit PIN space). Each lockout calls the PinGate's `onLockout` so the owner can be told (HL-10 texts them). Inbound and outbound calls have separate budgets, so someone guessing on inbound calls (caller ID can be spoofed) cannot block PIN approvals on calls Hotline placed to the owner. The trade-off: such guessing still locks the owner's own inbound line for up to an hour, which fails closed. Answers `{verified, attempts_left, end_call}`. A verified PIN is registered with the redactor (`addShortSecret`). The PIN is checked against `owner.pinHash` with scrypt and never logged or stored |
| `submit_answer` | On an inbound call, `pin-required` until this call passed `verify_pin`, because caller ID can be spoofed. A call is outbound only when the injected `placedCall(conversationId)` says Hotline placed it (call orchestration knows) and it went to the owner's number from another number; everything else counts as inbound. `runDaemon` passes call orchestration's `placedCall`, true from the moment a call is placed until its post-call event, its failure or the stuck-call limit. Otherwise passes the ask number, decision (`option`, `allow`, `deny`, `text`, `done` or `unclear`), the owner's words, the direction and the call ids to the `submitAnswer` handler. `confirmation` is `pin` only when this call passed `verify_pin`; nothing in the request can set it |
| `get_status` | `{"result": "pin-required"}` until this call passed `verify_pin`. Then the `getStatus` handler's text, redacted and cut to 1500 characters |
| `send_instruction` | `pin-required` until this call passed `verify_pin`. Then the `sendInstruction` handler gets the session number, instruction and the owner's words |

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
- **Once per event:** a `post_call_transcription` or `call_initiation_failure`
  for a conversation is handled once. A replay, or a retry after success, gets
  `200` and is ignored, whatever its signature header looks like. Events are
  remembered for 35 minutes, past the signature's age limit. A failed handler
  leaves the event unhandled, so ElevenLabs' retry gets through. The memory
  does not survive a restart, so a signed body replayed within its 30 minute
  window after a restart is handled again: call orchestration ignores an event
  for a call it is no longer waiting on. Live events are never evicted: with 1000 held, a new
  one gets `503` so ElevenLabs retries it later. Durable replay protection is
  HL-13.
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

`submit_answer` and the post-call webhook go to call orchestration (below).
Until the inbound line (HL-10) provides its handlers, `runDaemon` records
`voice.instruction` in the audit log, answers `unknown-session`, and reads out
no status.

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
  again (at least once), with the confirmation code it already had; recording an answer, closing an ask and ending a call are
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
    rule alone applies, so the persona's own example ("Allow pnpm test in
    demo-app? Yes?") is recognised. With several asks, a read-back that leaves
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
    "Allow pnpm test in demo-app? Yes?" or "Sorry, is that a yes or a no?"
    followed by that read-back. The owner's words must be found in the window
    right after a read-back, checked newest first. The reply is everything the
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
      echo, so "yes" agrees);
    - anything else ("yes, if the tests pass", "what does that do?", "yeah
      let's ship that one", "of course, wait") goes to a `ReplyJudge`. The
      judge gets only the owner's reply turns, verbatim, never the ask, the
      read-back or any other agent-written text. Only `agreed` confirms; a
      `declined` or `unclear` verdict, an error, or no answer within
      `JUDGE_TIMEOUT_MS` (8 seconds) leaves the allow not confirmed. The
      default judge is `FailClosedJudge`, which finds every reply unclear, so
      today such a reply is never an approval and the ask is texted.
      `FakeJudge` plays scripted verdicts in tests. A model-backed judge
      (sending only the owner's reply text to a model) needs the owner's
      approval and a plan change, since it adds a hosted service; none is
      built. `VoiceCalls` takes `judge` and `judgeTimeoutMs` options, and the
      orchestrator does not pass them yet.

    Doubt markers no longer reject a reply on their own: they keep the fast
    path from agreeing and send the reply to the judge. A clear-no reply, or a
    judge's `declined`, leaves the allow not confirmed (the ask is texted).
    Only a `deny` the voice agent submitted ends the request at once. Doubt
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
  some answers will be refused there until the persona is tuned. Until a
  real judge is approved, any natural yes outside the fast path's table is
  texted rather than approved. With a real judge, its verdict on the owner's
  words is what stands between a voice model that submits an allow on its
  own and an approval. High-risk requests still need the PIN.
- **How a call ended.** `call_initiation_failure` `busy` or `no-answer` is
  `no-pickup`, anything else `failed`. A transcription in which the owner never
  spoke is `no-pickup` (voicemail, silence); one where every ask was settled is
  `answered`; otherwise `dropped`. The call log (`call.ended` audit `result`)
  says `owner-unclear` instead of `dropped` when every ask left open was read
  and the owner replied to it, but no decision for it was confirmed (the owner
  stayed unclear and the voice agent moved on to a text, or the answer was not
  confirmed); each such ask gets a `voice.ask-unclear` audit entry. The queue
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
  "yes" can never approve a newer request. Codes are stored with the state, die
  with the ask, and are spent on first use; a code that matches no waiting ask
  burns every waiting code, so those requests can then only be approved on a
  call. Without a usable code the text says the request can only be approved on
  a call. Codes and held voice answers (with the model's
  `owner_words`) live in `daemon_state`, inside the `0600` database the store
  already requires; same-user processes can read it (see
  [contracts](contracts.md#secrets-secretsts)).
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
  `status` waits for HL-10; `stop` and Twilio's keywords get no reply of
  Hotline's own. Any other text answers only an ask Hotline texted that is
  still open, and only one: a `YES <code>` reply names the ask with that code;
  otherwise there must be exactly one such ask, texted at least 10 seconds
  before the message was first seen (the time its SID was claimed; an ask with
  no recorded send time never qualifies). A reply that predates the text, or
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
until they finish. Rows are tiny.
`onAskAdded` tells listeners about each new ask, as `onAskChange` does about
status changes.

- Migrations are an append-only list (`MIGRATIONS`). `PRAGMA user_version` counts
  how many have run. Each runs in its own transaction, so a failure leaves the
  version unchanged. A database from a newer Hotline is refused.
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
  can never print the PIN as its last four digits. Until the inbound line (HL-10)
  handles a spoken or keyed PIN, the key-based redaction above is what protects
  it.
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
