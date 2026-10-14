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

Routes today (`agent-routes.ts`; the MCP server in [mcp.md](mcp.md) is the client):

| Route | Does |
| --- | --- |
| `GET /v1/health` | `{"ok": true, "version": "..."}` |
| `POST /v1/sessions` | Registers `{agent, cwd, agentSessionId?}` and returns `{session}` (201). A live session with the same agent and `agentSessionId` is reused (200) |
| `POST /v1/sessions/:sessionId/asks` | Queues `{kind: "question" \| "notify", text, options?, urgent?}` and returns `{ask}` (201). Text and options are redacted before they are stored. The ask expires after `policy.askTimeoutMinutes`. A session with 3 open questions or 10 open notifications, or all sessions with 10 or 30, gets `429` (audited as `ask.refused`). `urgent` is the agent's request only; call policy decides |
| `GET /v1/asks/:askId/outcome?waitSeconds=0..30` | `{state: "waiting", ask}` or `{state: "final", ask, outcome}`, waiting up to `waitSeconds` for a change |
| `POST /v1/asks/:askId/cancel` | Cancels an ask that is still open: `{cancelled}` |
| `POST /v1/sessions/:sessionId/end` | Marks the session `ended` and cancels its open asks: `{ended}`. An ended session takes no new asks (`404`) |
| `GET /v1/sessions/:sessionId/inbox` | `{session, instructions, asks}`: owner instructions (always empty until HL-10 adds the queue) and the 20 newest asks with their outcomes |

Bodies are strict: an unknown field, a relative `cwd`, a `permission` or `stop`
kind (HL-06 adds them) or more than 9 options gets `400` with the failing paths,
never the values. An unknown session or ask gets `404`.

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
(`waiting-on-human` while it has an open question, else `working`). On
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

Until call orchestration (HL-09) answers asks by text, an owner's text is
recorded in the audit log as `sms.received` with its SID and reply type
(`yes`, `option`, `status`, ...), not its words, and gets no reply.

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
  handler does not run again, so a repeated wrong PIN spends no attempt. A
  delivery that was refused (`pin-required`, `invalid`, `refused`) or failed is
  forgotten, so the same call can succeed once it is allowed. `get_status` only
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
| `verify_pin` | Checks the PIN with the `PinGate`: 2 wrong PINs per call, then `end_call: true` and no further checks on that call; 6 wrong PINs across all calls of one direction in a rolling hour lock every check on that direction, the right PIN included, until the hour has passed. Inbound and outbound calls have separate budgets, so someone guessing on inbound calls (caller ID can be spoofed) cannot block PIN approvals on calls Hotline placed to the owner. The trade-off: such guessing still locks the owner's own inbound line for up to an hour, which fails closed. Answers `{verified, attempts_left, end_call}`. A verified PIN is registered with the redactor (`addShortSecret`). The PIN is checked against `owner.pinHash` with scrypt and never logged or stored |
| `submit_answer` | On an inbound call (anything but a call to the owner's number from another number), `pin-required` until this call passed `verify_pin`, because caller ID can be spoofed. Otherwise passes the ask number, decision (`option`, `allow`, `deny`, `text`, `done` or `unclear`), the owner's words, the direction and the call ids to the `submitAnswer` handler. `confirmation` is `pin` only when this call passed `verify_pin`; nothing in the request can set it |
| `get_status` | `{"result": "pin-required"}` until this call passed `verify_pin`. Then the `getStatus` handler's text, redacted and cut to 1500 characters |
| `send_instruction` | `pin-required` until this call passed `verify_pin`. Then the `sendInstruction` handler gets the session number, instruction and the owner's words |

**Post-call webhook** (`POST /hooks/el/post-call`):

- **Precheck:** an `ElevenLabs-Signature` header and a JSON content type.
- **Verify:** `t=<seconds>,v0=<hex HMAC-SHA256(webhookSecret, "<t>.<raw body>")>`,
  the algorithm of ElevenLabs' SDK, compared in constant time over the raw body.
  A timestamp more than 30 minutes old or 5 minutes ahead fails.
- **Once per event:** a `post_call_transcription` or `call_initiation_failure`
  for a conversation is handled once. A replay, or a retry after success, gets
  `200` and is ignored, whatever its signature header looks like. Events are
  remembered for 35 minutes, past the signature's age limit. A failed handler
  leaves the event unhandled, so ElevenLabs' retry gets through. Durable replay
  protection is HL-13.
- **Who spoke:** the person's transcript turns are labelled `owner` only on an
  outbound call whose other end is `owner.phoneNumber`, or, on an inbound call
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

Until call orchestration (HL-09) and the inbound line (HL-10) provide the
handlers, `runDaemon` records `voice.answer` (decision kind only),
`voice.instruction` and `voice.<event>` in the audit log, answers
`not-recorded` and `unknown-session`, and reads out no status. The PIN check
and its limits are live.

## Store

SQLite through Node's built-in `node:sqlite`, at `hotline.db` in the hotline home,
mode `0600` in a `0700` directory. A new file is created `0600` before SQLite
opens it, so it never exists with umask permissions. A symlinked database, or one in a directory
other users can reach, is refused. Tables: `sessions`, `asks`, `answers`, `calls`
and `audit`. Each table keeps the record as JSON validated by the HL-02 schemas,
on write and on read, next to the columns the daemon queries by.

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
