# Security model and threat model

Agent Hotline is a phone line that can steer coding agents on the owner's Mac,
so it is a remote control for that machine. This document says what Hotline
protects, from whom, where each rule is enforced and tested, and which risks
are accepted for Tier 1. It is the HL-13 security pass (#14). The
[README](../README.md#security-model) has the short version for users;
[daemon.md](daemon.md), [hooks.md](hooks.md) and [contracts.md](contracts.md)
have the mechanism details this document links to.

Code, tests and scenario results are the evidence. Where this document and the
code disagree, the code wins and this document is out of date.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| The owner's decisions (approvals, answers, instructions) | `hotline.db` (`answers`, `instructions`, audit log) | An approval runs a command on the Mac; an instruction becomes an agent's next prompt |
| Provider credentials: Twilio auth token and account SID, ElevenLabs API key, tool secret, webhook secret | macOS Keychain (service `agent-hotline`) or `~/.hotline/secrets.json` (`0600`) | Sign or forge webhooks, place calls and texts on the owner's account |
| The per-install agent API token | Same secret store (`daemon.apiToken`) | Lets a local process open, read and cancel asks |
| The owner's PIN | Only as a scrypt hash, `owner.pinHash` in `~/.hotline/config.json` (`0600`) | Unlocks inbound calls and high-risk voice approvals |
| SMS confirmation codes | Orchestrator state in `hotline.db` (`daemon_state`) | Approve a permission request by text |
| Transcripts, ask text, audit log | `hotline.db`, local only | Hold project details and the owner's words |
| Secrets in the project (`.env`, keys, tokens in files and command lines) | The developer's repositories | Must never reach Twilio, ElevenLabs or logs |
| The owner's phone number and attention | Config; the phone | Spam, cost, and calls at night |

## Actors

- **The owner.** Trusted. Proves themselves by answering the configured phone
  (outbound calls), by caller ID plus the PIN (inbound calls and high-risk voice
  approvals), or by texting from the owner's number with a request's single-use
  code (text approvals).
- **Coding agents and every other process running as the owner's user.**
  Partly trusted. They are meant to use the agent API with the shared token, and
  their text (questions, command previews, diffs, tool input) is untrusted data
  that can never approve itself. They can also read everything the owner's user
  can read, which is the main accepted risk below.
- **Strangers on the phone network or SMS.** Untrusted. They can call or text
  the Hotline number and spoof caller ID.
- **Providers (Twilio, ElevenLabs and the LLM inside the ElevenLabs agent).**
  Trusted to deliver calls and texts and to sign their webhooks; not trusted with
  more than short redacted summaries. The voice model is treated as able to make
  things up: its tool calls are checked against the post-call transcript. Since
  HL-13a every decision is also checked against the provider's own record.
- **The reply judge's model (HL-09d, HL-09e).** Only once the owner chooses a
  backend (`hotline init` or `judge.backend`), the owner's own agent provider
  (Claude Code or Codex on the owner's plan login, or the Anthropic API when
  chosen explicitly) sees the owner's redacted reply turns to a read-back, never
  agent-written text, in an isolated run that gets none of Hotline's
  credentials. Its `agreed` can only be taken away by the post-check, never
  added; an error or timeout is "not confirmed" ([README](../README.md#security-model)).
- **The network and the tunnel.** Untrusted. Anyone on the internet can reach the
  tunnel's public URL and send anything to it.

## Trust boundaries

```text
 owner's phone ── PSTN ── Twilio / ElevenLabs ──HTTPS── tunnel ──► 127.0.0.1:<port+1>  webhook listener, /hooks/* only
                                    ▲                                    │ verify signature or secret, then parse
                                    │ redacted summaries                 ▼
                                    └──────────────────────────── hotline daemon ── hotline.db, ~/.hotline (0600), Keychain
                                                                         ▲
 Claude Code / Codex ── MCP server, hook adapters ──► 127.0.0.1:<port>   agent API, Bearer token + loopback Host on every route
```

1. **Internet to webhook listener.** Only the webhook port is meant to be
   forwarded by the tunnel. It serves `/hooks/*` and nothing else; every route
   must declare a verifier, and everything unverified gets the same bare `403`
   ([daemon.md, Webhooks](daemon.md#webhooks)).
2. **Local processes to agent API.** A separate port on 127.0.0.1, so a tunnel
   pointed at the webhook port cannot reach it. Every route, including unknown
   paths, needs the token and a loopback `Host` header (DNS rebinding)
   ([daemon.md, Agent API](daemon.md#agent-api)).
3. **Daemon to providers.** Outbound only to the owner's number; only redacted,
   length-capped summaries leave the machine.
4. **Agent text to the owner.** Everything an agent wrote is fenced as
   `<agent_text>` for the voice model and checked against the owner's own words
   in the transcript before it counts.
5. **Daemon to disk.** `~/.hotline` is `0700`, its files `0600`, refused if a
   symlink, owned by another user or readable by group or others.

## Invariants: where they are enforced and tested

Each row names the main enforcement points and a few of the tests that prove
them. Scenario names are from the suite in `eval/` ([eval.md](eval.md)).

| Invariant | Enforced in | Tested by |
| --- | --- | --- |
| **Owner only.** Outbound goes only to the owner; other callers and texters get a generic rejection; inbound needs the PIN first | Providers take the owner's number at construction and have no recipient argument (`providers/src/sms.ts`, `twilio-sms.ts`, `elevenlabs-voice.ts`); `twilioSmsRoute` (`fromOwner`, `GENERIC_SMS_REPLY`); `elevenLabsRoutes` (`ownerOnCall`, PIN before `get_status`, `send_instruction`, inbound `submit_answer`); `PinGate` (`pin.ts`) | `providers/test/sms.test.ts` "has no way to text anyone but the owner"; `daemon/test/sms-webhook.test.ts` "gives any other number one generic reply and never reaches the handler"; `elevenlabs-webhook.test.ts` "refuses an answer on an inbound call until the PIN, since caller ID can be spoofed"; scenarios `inbound-other-number-rejected`, `inbound-wrong-pin-rejected` |
| **Verify every webhook.** Signature or secret before parsing; bare `403`, logged without body | `buildWebhookServer` (`server.ts`: no verifier means `403`, precheck before the body, only a literal `true` passes); `validTwilioSignature`; `sameSecret` for tool calls; `freshPostCallHeader` and `validPostCallSignature` for post-call | `server.test.ts` "reject with 403 when the verifier returns %s"; `exposure.test.ts` "refuses every public route without its provider's proof, with the same bare 403"; `sms-webhook.test.ts` "refuses a wrong signature, a wrong auth token and another account"; scenarios `unsigned-webhook-rejected`, `replayed-webhook-rejected` |
| **Only `/hooks/*` is public; agent API is local and token-gated** | `LOOPBACK_HOST` (not configurable), two ports, `buildAgentApi`'s `onRequest` hook (Host, then token, on every route and on 404s) | `exposure.test.ts` (HL-13): with Twilio and ElevenLabs fully configured, every route each listener registered is audited (public routes under `/hooks`, every agent API route `401` without the token, `403` with a foreign Host, `404` on the public port); `server.test.ts` "bind 127.0.0.1 only, on two different ports" |
| **Decisions come from the human.** Recorded only from the owner's words or keypresses, transcript excerpt stored; agent text never approves; the voice model cannot invent a decision | `answerProblem` (core contracts) and `HotlineStore.recordAnswer` re-checking it; `confirmVoiceDecision` and `replyVerdict` (`voice-confirm.ts`, read-back plus a clear yes); replies the fast path cannot decide go to the reply judge (`reply-judge.ts`, HL-09d), whose `agreed` is vetoed by `checkedVerdict` and `vetoesAgreement` on any condition, correction or negation, and fails closed on error or timeout; `smsAnswer` (code required); `confirmInstructions` | `orchestration.test.ts` "agent text claiming approval still needs the owner's words"; `voice-confirm.test.ts` "never takes a caller's or the agent's words"; HL-13's `sms-reply.property.test.ts` and `voice-reply.property.test.ts`; scenario `agent-text-cannot-self-approve` |
| **High risk needs the PIN or a confirming text** | `classifyPermission` sets the class; `answerProblem` refuses a high-risk `allow` with `confirmation: "none"`; the hook keeps the stricter of its own and the daemon's class | `contracts.test.ts` "needs the PIN or a confirming text for a high-risk approval"; `hook-adapter.test.ts` "never lets a daemon that stored 'low' lower the hook's own high-risk class"; HL-13's `permission-risk.property.test.ts`; scenario `high-risk-needs-pin` |
| **Silence is not consent** | Queue `noAnswer` paths and `permissionVerdict` (core); every hook failure path denies (`hook-adapter.ts`) | `queue.property.test.ts` "silence never yields approval..."; `hook-adapter.test.ts` "denies every no-answer reason"; scenarios `silence-denies`, `unclear-answer-denies` and the self-test |
| **Send third parties the minimum.** Redact before anything leaves the machine | `createRedactor` (`redact.ts`) with the daemon's own secrets registered; `callVariables` and `describeAsk` (`MAX_SPOKEN_ASK_LENGTH`); `prepareSmsText`; the hook names unknown tool arguments, never their values | `redact.test.ts`; HL-13's `redact.property.test.ts`; `elevenlabs-voice.test.ts` "sends only redacted, length-capped summaries"; scenario `secrets-redacted-before-send` |
| **Bounded noise and cost** | Config bounds (`callsPerHour` and the rest can never be 0); `rateLimitAllows` and the queue; quiet hours; batching; open-ask caps (`MAX_OPEN_ASKS`, `MAX_OPEN_ASKS_TOTAL`); live-session cap; Stop loop guards | `queue.test.ts` "texts once the hourly call limit is used up, and calls again an hour later"; `agent-routes.test.ts` "cap open asks across all sessions..."; `hook-adapter.test.ts` "continues up to maxConsecutiveContinuations in a row..."; scenarios `rate-limit-holds-calls`, `quiet-hours-texts-instead`, `stop-loop-capped` |
| **No permission escalation** | Strict hook output schemas allow only `allow` or a deny (`core/src/hooks.ts`); outside away mode the hook prints nothing | `hooks-secrets.test.ts` "never rewrites input or adds permission rules"; `hook-adapter.test.ts` "never prints interrupt, updatedInput or updatedPermissions" |
| **Testable without a phone** | Pure core (purity scan); providers need an injected `fetch`; fakes for every provider | `purity.test.ts`; `voice.test.ts` "needs an injected fetch in test mode" |

## Webhook replay protection and rate limits (HL-13 review)

What protects each public route against replays and floods today, and what a
daemon restart loses. "Memory" means state lost on restart; "SQLite" means it is
kept in `hotline.db`.

| Mechanism | State | Notes |
| --- | --- | --- |
| Twilio signature (`validTwilioSignature`), exact public URL, own `AccountSid` | none | Twilio signs no timestamp, so freshness rests on the SID records and the reply rules below |
| SMS `MessageSid` dedupe in the route (last 1000) | memory | Retries wait for an attempt in flight; only a successful handling counts |
| Owner texts claimed by SID before any effect (`inbound_messages`, kept 400 days) | SQLite | A replay after a restart is ignored (`orchestration.test.ts` "remembers handled messages across a restart") |
| Verify by pull (HL-13a): an owner text counts only if Twilio's own record of that SID is inbound, from the owner, with the same body (compared after NFC and whitespace collapsing since HL-13c) and at most 15 minutes old; since HL-13c every text path, other senders' included, is pulled before any effect, a refused one gets empty TwiML, and the `status` reply is texted to the owner instead of returned in the response; every ElevenLabs tool call and post-call event is checked against the pulled conversation | none (pulled per request) | A forged or replayed body confirms nothing; the forgery alarm texts the owner at most once an hour (its last send time in SQLite since HL-13b) |
| Post-call retries while ElevenLabs' record is still `processing` (HL-13c): `503` at most 3 times per conversation, then the call ends as no answer | SQLite (`post_call_waits`, 2 h) | Only `processing` is retried, so forged events during a live call (`in-progress`) cannot use the retries up; a store that cannot count falls back to this run's memory |
| Text reply binding: a reply must be first seen 10 s or more after the text; a bare reply needs exactly one waiting ask; approvals need that ask's single-use code; one wrong code burns every waiting code | SQLite | A replayed old "YES 123456" cannot approve a newer request |
| Generic replies to strangers, 5 an hour | memory | Global, not per sender |
| ElevenLabs tool shared secret (`sameSecret`), checked before the body is read | none | Static: no timestamp or nonce |
| Tool-call dedupe (`submit_answer`, `verify_pin`, `send_instruction`; 2 h, 1000 live, refuses rather than evicts) | SQLite (`tool_deliveries`, HL-13b); deliveries still running in memory | Keyed on an HMAC-SHA256 of tool name and body under the tool secret, which never enters the database (a `verify_pin` body holds the PIN). Every delivery is pulled and checked as a live call first, so a replay after the call ended gets the refusal; a remembered `verified: true` is checked again by this run's PinGate. An unreadable store answers `busy` |
| Post-call HMAC with timestamp: at most 30 min old, 5 min ahead | none | Freshness checked before the body is read |
| Post-call replay memory (type plus conversation id, 35 min, 1000, `503` when full) | memory, by design (HL-13b) | A replay after a restart is pulled and handled again and changes nothing: the saved call state ignores it, the held instructions were deleted when the event was handled and `addInstruction` is idempotent by id (`orchestration.test.ts` "a replayed post-call event after a restart changes nothing", `inbound-line.test.ts` "keeps held instructions across a restart") |
| PIN: 2 tries a call, 6 failures an hour, 10 a day, per direction | budgets in SQLite (`pin_failures`, HL-13b); a call's own 2 tries and which calls proved the PIN in memory | A restart gives a guesser no fresh budget and makes every call give the PIN again; a failure log that cannot be read or written refuses the attempt without checking the PIN (`restart-limits.test.ts`, `persisted-limits.test.ts`) |
| PIN lockout texts, one an hour per direction | SQLite (`daemon_state`, HL-13b) | Every lockout is audited |
| Webhook body before verification: 64 KiB by default (HL-13, was 256 KiB); post-call 1 MiB with 4 in flight and a 5 s body deadline; server tools 8 in flight and a 5 s body deadline (HL-13b) | none | `server.test.ts` "read at most 64 KiB before verifying...". The Twilio SMS route has no in-flight cap or body deadline by design: a sender with no valid signature could fill a cap and shut out the owner's texts ([daemon.md](daemon.md#twilio-sms-post-hookstwiliosms)) |
| Call and text rate limits (rolling hour and day) | SQLite (orchestrator state) | If both saved rows are unreadable the hourly windows count as full |
| Open asks per session and in total, live sessions | SQLite | `429` past the cap |

HL-13 confirmed these by reading the code and their tests, and added the body
cap. HL-13b ([#83](https://github.com/neanicc/agent-hotline/pull/83)) then
moved the PIN budgets, the tool-call memory, held instructions and the alarm
and lockout text limits into SQLite. What still resets on a restart is the
route's own SID set (owner texts are claimed in SQLite anyway), the post-call
replay memory (harmless, see above), the stranger-reply throttle, which calls
proved the PIN and each call's own two tries; all of these fail safe. Other
gaps, also failing safe (none approves anything), are listed under
[follow-ups](#follow-ups).

## Fuzz and property tests (HL-13)

| File | Property | Bugs it found, fixed failing closed |
| --- | --- | --- |
| `packages/daemon/test/redact.property.test.ts` | Random registered secrets, values under secret-looking names, PINs and fake phone numbers embedded in JSON, nested JSON, form-encoded, URL query, `.env` (quoted, unquoted, `export`), YAML, HTTP-header and logfmt text never leave a 6-character piece in the output; random 16 KiB hostile shapes are redacted in linear time | A value after an encoded segment that opened a quote (`"token":"+,rest"`) kept its tail; an unquoted value stopped at a quote (`token=a'rest`); the JWT pattern was quadratic on `eyJ-eyJ-...` (now a linear scan of each run of token characters, which still finds a JWT after `-`) |
| `packages/core/test/permission-risk.property.test.ts` | Obfuscated variants of 50+ high-risk commands (wrappers, quoting, `$'...'`, `${...}`, braces, globs, case, fullwidth and Cyrillic lookalikes, zero-width and no-break spaces, absolute command paths, attached option values, `cd`, environment prefixes, NFD) never classify as low; Codex argv arrays likewise; for random command lines the classifier calls low, `bash -n` and `zsh -n` must accept them and zsh's own word split (`${(z)...}`, the command passed as data, never run) must match `splitShell` | `git show HEAD:.env` was low (a revision's `:` was not a path boundary); `; ls`, `ls ;;` and `ls\n;` were low though bash refuses them; `ls &>>x` was low though macOS's bash 3.2 refuses it; `rg` options were a denylist, so `--hostname-bin` (runs a program) and unknown options were low; the first positive list still held `--hidden`, `--no-ignore`, `-u`, `-L`, `-g` and `-t`, so `rg -uu KEY` and `rg -g '.*' KEY` searched `.env` and `.git` as low (staff review) |
| `packages/core/test/sms-reply.property.test.ts` | Random and word-salad texts approve only as `<yes word> <that request's code>`; nothing approves when no code was sent; conditional, negated, hedged or wrong-code yeses never approve | none |
| `packages/daemon/test/voice-reply.property.test.ts` | The voice fast path never agrees with a reply holding a refusal, negation, condition or hedge, in one turn or split across turns; a random reply it agrees with has no doubt marker; whatever the model judge says, a reply with a condition, correction or negation is never agreed | none |
| `packages/daemon/test/exposure.test.ts` | The exposure audit above | none |

The timing checks use `test/linear-time.ts`. Each measurement is the fastest
of seven interleaved runs, and one of up to five attempts must meet all three
bounds: the old one (the full 16 KiB in under 50 ms), hostile text at most 100
times slower than benign text of the same length, and the full hostile text at
most 8 times slower than its first quarter (linear work grows about 4 times,
quadratic about 16). So the old guarantee stands, and a quadratic pass that
happens to stay under 50 ms still fails on growth; what changed is only that
one unlucky timed run under parallel load no longer fails the check. On the dev
Mac benign 16 KiB takes about 0.19 ms, the slowest linear hostile shapes 40 to
50 times that, and the quadratic pattern HL-04 removed about 440 times.
`test/linear-time.test.ts` holds the negative controls: quadratic work, both
slow and under 50 ms on 16 KiB, never passes the helper.

The bash differential only checks syntax, since bash has no way to split words
without running them. zsh is not installed on Ubuntu runners, so there the zsh
half skips and macOS CI runs it.

## Limits of the permission classifier

The classifier ([hooks.md](hooks.md#risk-classes-plan-question-6)) decides how
much proof an approval needs, never whether one is needed: every permission
request still needs the owner's own yes, and every failure denies. Its limits:

- It judges text, not execution. It does not see the shell's aliases,
  functions, `PATH` or rc files; an agent that already edited a script the
  allowlist runs (`pnpm test`) gets that script run on a spoken yes. Writes to
  `package.json`, `.git/`, `node_modules/` and package-manager config are high,
  but an earlier low-risk edit by the same agent in the same away window is not
  remembered (follow-up).
- Read tools (`Read`, `Grep`, `Glob`) aimed outside the project are low unless
  the path looks like a credential (`docs/hooks.md` records this as the
  intended default). The read result reaches the agent, not a third party.
- Only the paths a command names are checked. A recursive read of a folder
  inside the project (`grep -rn KEY src`, `find .`) is low even though it reaches
  any `.env` or `.git` under that folder, and `grep -R` follows symlinks. `rg`
  skips hidden and ignored files by default, so its options that undo that
  (`--hidden`, `--no-ignore`, `-u`, and `-g`/`--glob`/`--iglob` and
  `-t`/`--type`, since a file a glob or type selects is searched even when
  hidden) or follow symlinks (`-L`, `--follow`) are left off its positive list
  and make the command high.
- The tokenizer refuses anything bash and zsh might expand or read differently.
  The differential test covers the separators, quotes, redirections and file
  descriptors it accepts, against zsh's lexer and bash's parser; it cannot prove
  the absence of every differential.
- Codex shell requests are always high, because Codex does not send the folder
  or sandbox setting to the hook.

## Limits of the redactor

The redactor is a safety net under the logging contract (request logs carry
method and path only; bodies and headers of webhooks are never logged). It errs
towards removing too much: once an encoded segment that looks secret is removed
and leaves a quote open, every segment up to the closing quote goes too, on
later lines as well (a quoted `.env` value may span lines). Text after the
closing quote is kept; if the quote never closes, everything after the segment
is removed (`redact.test.ts` pins both). Accepted gaps, each found
by a probe or the fuzzer and none a current leak:

- A registered secret re-encoded another way: base64, upper-cased, or split
  across lines.
- A YAML block scalar under a secret name (`auth_token: >` and the next lines):
  only the first line goes. A long token on the next line is still removed as an
  opaque run.
- An unquoted value with spaces under a secret name (`PASSWORD=two words`): only
  the first word goes. Quoted values go whole.
- A phone number written with slashes (`+1/555/555/0100`).

## Accepted residual risks (Tier 1)

- **Same-user processes can read every secret.** Any process running as the
  owner, coding agents included, can read the Keychain items without a prompt
  (`/usr/bin/security` is on their access list), the `0600` files and
  `hotline.db`, including pending text confirmation codes. With the Twilio or
  ElevenLabs secrets such a process can sign webhooks. HL-13a (verify by pull,
  [#69](https://github.com/neanicc/agent-hotline/pull/69)) makes a signed
  webhook only a trigger: before a text or call decides anything the daemon
  pulls the message or conversation from the provider, so a forged body
  confirms nothing (it is audited as a possible forgery and the owner is texted,
  at most once an hour), and codes are stored only as hashes
  ([contracts.md](contracts.md#secrets-secretsts)). What remains
  after it: a process holding the provider API keys can place calls and send
  texts on the owner's account through the providers' APIs, and can read or
  change the config (owner number, public URL) and away-mode state. Hotline
  protects against other people and other accounts, not against code running as
  the owner. Use narrowly scoped keys.
- **One install token for every agent.** All local sessions share it, so one
  session can read or cancel another session's asks and read its instructions.
  No agent API route can answer an ask, so this cannot approve anything.
- **The classifier only sets proof strength** (see its limits above).
- **Instructions are delivered at most once.** A queued instruction is handed
  to the session's next ask or Stop hook, which acknowledges it before passing it
  on; a hook killed between the acknowledgement and its output loses that
  instruction rather than delivering it twice ([hooks.md](hooks.md#stop-stop)).
  Held instructions (said on a call, waiting for the post-call transcript) are
  saved redacted since HL-13b and survive a restart; one whose words held a
  secret then fails to confirm against the redacted copy, and the owner is
  texted that it did not go through.
- **A saved PIN time labels a restarted call's transcript.** So that a held
  instruction can still be confirmed after a restart, the time a call passed
  the PIN is saved with the instruction (HL-13b). It counts only for the
  post-call transcript of that call: the pulled record must carry the same
  call SID and the time must fall within the call. It covers the turns before
  the restart (and while the daemon was down); turns after it count as the
  owner's only once the PIN is given again in the new run (`pinLapse`). It
  never serves a live tool, which needs the PIN again after a restart.
- **A few counters live in memory.** The route's SID set, the post-call replay
  memory, the stranger-reply throttle, which calls proved the PIN and each
  call's own two tries reset on a restart. None of this approves anything: SID
  claims, code hashes, call state, PIN budgets and tool deliveries are in
  SQLite, and a restarted call must give the PIN again.
- **The Twilio SMS route is not capped.** It has no in-flight cap or body
  deadline, unlike the ElevenLabs routes, because its signature can only be
  checked over the body and a cap would let an unauthenticated sender shut out
  the owner's texts. The 64 KiB body limit still applies.
- **A PIN covers the whole call**, not one ask: after the PIN, a high-risk ask
  later on the same call needs only the read-back and a yes.
- **On an outbound call, whoever answers the owner's phone is the owner**, up to
  the PIN for high-risk requests.
- **The tunnel's own configuration is the owner's.** Hotline cannot check that
  the tunnel forwards only the webhook port; it has no per-IP rate limit (every
  request arrives from 127.0.0.1). Tunnel-level rate limiting is advisable.

## Follow-ups

Tracked on GitHub; each fails safe today.

- Done: [#78](https://github.com/neanicc/agent-hotline/issues/78) (HL-13b,
  [#83](https://github.com/neanicc/agent-hotline/pull/83)) persisted the PIN
  failure budgets, the forgery-alarm and lockout text limits, held inbound
  instructions and the tool-call memory, and capped the ElevenLabs tool routes.
  It decided the post-call replay memory need not be persisted (see the
  replay table).
- Bound the Twilio SMS route with capacity reserved for genuine Twilio
  requests (left open by HL-13b).
- Count texts sent outside the queue (TwiML replies, inbound-line notices,
  lockout texts, crash reports) against the text rate limit (left open by
  HL-13b).
- Done: [#80](https://github.com/neanicc/agent-hotline/issues/80) (HL-13c)
  keeps a genuine answer verify by pull used to refuse (a post-call record
  still processing is asked for again, a bounded number of times; a reply
  Twilio stored with different whitespace or Unicode normalisation counts),
  and pulls every text path before any effect.
- Send every owner reply as an outgoing text rather than in the TwiML (left
  open by HL-13c: only the status moved).
- Raise a package-script run to high after the same away window edited
  `package.json` or a script it runs.
- Consider making read tools aimed outside the project high.
