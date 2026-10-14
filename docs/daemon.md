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

Routes today: `GET /v1/health` returns `{"ok": true, "version": "..."}`.

### Webhooks

Every route under `/hooks` must declare a verifier (`WebhookRoute.verify`). It
fails closed in two places:

1. Before the body is read, a request for a route without a verifier gets `403`.
   Every path that no ticket has implemented yet lands on a catch-all route
   without one.
2. After parsing, the verifier runs. Anything other than a literal `true`
   (`false`, a truthy value, a throw or a rejected promise) gets `403`.

A rejected request is logged with its method, path and reason only, never its
body, headers or query string. Paths outside `/hooks` get `404`. HL-07 and HL-08
add the Twilio and ElevenLabs routes through `startDaemon({ webhookRoutes })`.

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
It then closes the database and exits 0. If requests are still running after
10 seconds, it gives up and exits 1. A second signal during shutdown gets Node's
default handling, which ends the process at once.
