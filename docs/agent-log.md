# Agent development log

Each PR that makes a substantive decision, design change or measurement appends
one entry at the end of this file in the same PR. Keep entries short and factual.
Earlier entries are history, not current instructions.

Template:

```
## YYYY-MM-DD — HL-xx <title> (#PR)
- Decision / change:
- Evidence: commands run and results (automated / scenarios / real agent / live call)
- Open issues or follow-ups:
```

## 2026-10-13 — Scaffold

- Decision / change: repository created with agent workflows (adapted from the
  Trail/teachAR delivery skills, hardened during the Stream Privacy Guard setup),
  plan, lanes, scenario definitions, human-owned thresholds, CI structure (`check`
  aggregate, protected-path guard, actionlint, Ubuntu and macOS build/test,
  scenario suite through `scripts/ci/run.sh`), Claude staff review on PRs and
  Greptile configuration. License: MIT.
- Evidence: `python3 scripts/check_agent_files.py` and actionlint passed on the
  scaffold. No product code exists yet.
- Open issues: plan section 12 open questions.

## 2026-10-13 — HL-01 Workspace foundation (#18)

- Decision / change: pnpm workspace with `packages/{core,daemon,providers,agents}`
  and `apps/cli` (`hotline --version` / `--help` only). Exact pins, each at least
  two weeks old when pinned: TypeScript 6.0.3 (not 7.0.x: the native port is
  three months old and 6.x is the stable JS compiler), Vitest 4.1.11 (not 5.0.x,
  a one-month-old major), Biome 2.5.14, `@types/node` 22.20.4, pnpm 11.27.1 via
  `packageManager` and Corepack. `pnpm-workspace.yaml` sets `saveExact`, and
  `test/workspace.test.ts` fails on any `^`/`~` range, a missing lockfile, a
  package missing from the `tsc -b` solution, or a package overriding strictness.
  `.node-version` stays `22` (CI gets the newest 22.x patch); `engines.node` is
  `>=22.13.0` because pnpm 11 requires it, and `run.sh setup` warns when the
  running Node differs from `.node-version`. Build uses project references
  (`tsc -b`); `typecheck` adds a no-emit pass over every test file. Vitest runs one
  project per package and aliases `@hotline/*` to `src/`, so tests never read a
  stale `dist/`. CI only calls `run.sh`, so the `build` stage runs Biome, `tsc -b`,
  the typecheck and a smoke run of the built CLI. `package` stays a notice until
  HL-15; `eval` still prints `THRESHOLDS: NOT RUN` (exit 0 in CI, 1 with `--local`).
- Evidence (automated, worktree on Node 22.23.1 and 24.11.0, clean `node_modules`):
  `run.sh setup`, `build`, `test` (17 tests in 6 files), `package` (notice) and
  `eval` (NOT RUN) exit 0; `eval --local` prints NOT RUN and exits 1. Changing one
  pin to `^4.1.11` made the workspace test fail. `python3 scripts/check_agent_files.py`
  passes. Ubuntu and macOS CI results are on the PR. No scenario suite, real agent
  or live call evidence applies yet.
- Open issues or follow-ups: `pnpm exec` under pnpm 11 rewrote the lockfile after a
  manifest edit, so run `pnpm install` after changing a `package.json`;
  `setup --frozen-lockfile` catches drift in CI. The CLI reads its version from
  `../package.json`; HL-15 must keep that working when it bundles. Revisit
  TypeScript 7 once it has a few months of patch releases.

## 2026-10-13 — HL-02 Contracts and config (#21)

- Decision / change: zod 4.6.5 pinned in `@hotline/core` (4.6.6 and 4.6.7 were
  under two weeks old). Core holds the schemas for Session, Ask, Answer/Decision,
  AskOutcome, CallRecord, Config, secret names and the hook payloads, plus
  `answerProblem` (wrong-kind decisions, unoffered options and high-risk approvals
  without PIN or text confirmation never count) and pure config parsing; it does no I/O.
  The I/O adapters live in `packages/daemon`: `hotlinePaths`, `loadConfig`,
  `KeychainSecretStore`, `FileSecretStore`, `openSecretStore`. Choices made without
  a plan answer: the config is JSON (`config.json`, no TOML dependency) in
  `$HOTLINE_HOME` or `~/.hotline`; plan question 5 takes the recommended default,
  so `secrets.store: "auto"` means the Keychain on macOS and the `0600` file
  elsewhere. The config holds the PIN hash (plan section 5), and a 4–6 digit PIN
  is cheap to brute-force offline, so `loadConfig` refuses a config that other
  users can access, the same rule as the secrets file. PIN hash format is
  `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` with log2 N ≥ 15. Rate limits and the
  continuation cap have a minimum of 1, so they cannot be switched off.
  `policy.maxConsecutiveContinuations` defaults to 5, below Claude Code's own
  cap of 8. Keychain writes go through `security -i` on stdin with a hex value
  (`-X`), so a secret never appears in a process argument list. Each write is read
  back, because interactive mode can exit 0 after a failed command. Secret values
  are one line of printable ASCII. Hook fixtures are in
  `packages/agents/test/fixtures/hooks` (lane:agents owns hook fixtures, and HL-06
  consumes them). The Claude Code fixtures adapt the examples on
  code.claude.com/docs/en/hooks. The Codex docs show no full payloads, so the Codex
  fixtures are built from Codex's generated JSON schemas at openai/codex
  `e444aa99`. Those four schemas are vendored verbatim (Apache-2.0) and excluded
  from Biome so they stay byte-identical. A small draft-07 checker in the test
  validates the Codex fixtures against them. Hook inputs are parsed loosely and
  outputs strictly: Hotline never sends `updatedInput`, `updatedPermissions`, or
  `interrupt` to Codex.
- Security changes (from review): a Keychain store failure reports `security`'s
  exit code only, because interactive mode can echo the command with the hex
  value. Read and delete errors mask hex runs of 8 or more characters and never
  include stdout. The config and secrets file are opened with `lstat`, so a
  symlinked file or directory is refused. Their directory must belong to the user
  and have no group or other bits (`0700`), and an existing wider directory is
  refused with the `chmod 700` to run, not silently fixed.
- Known limitation: same-user processes, coding agents included, can read every
  secret. The `security` binary that added a Keychain item is on that item's
  trusted list, so `security find-generic-password -w` reads it without a prompt.
  The `0600` file is equally readable to the same user. This cannot make an
  approval happen: decisions come only from the owner's own words or keypresses on
  the owner's phone, high-risk approvals also need the PIN or a confirming text,
  and the PIN is stored only as a scrypt hash. It does mean an agent could misuse
  the provider keys, by placing calls or texts or forging provider webhooks.
  Documented in `docs/contracts.md`.
- Review fixes (staff review and Greptile on the PR): `answerProblem` now takes
  the daemon's clock reading and rejects an answer for an ask that is not
  `pending` or `in-flight`, or one given or received at or after `expiresAt`, so a
  late answer cannot resolve an ask that already returned "no answer". The PIN
  hash's scrypt cost is capped (log2 N 15–20, r ≤ 16, p ≤ 4) and
  `pinScryptMaxmem` states the `maxmem` the verifier needs. `ownerExcerpt` and
  free-text decisions must not be blank. Codex `permission_mode` is any string, so
  a new Codex mode does not silently disable Hotline. `FileSecretStore` queues
  `set` and `delete` per path within the process. Declined: Greptile's report that
  a shared `HOTLINE_HOME` is accepted; every read and write already checks the
  directory and refuses one with group or other bits.
- Evidence (automated, worktree, Node 22.23.1 and 24.11.0): `run.sh setup`,
  `build` and `test` pass, with 106 tests in 12 files (117 after the review
  fixes, Node 24.11.0 locally; CI covers Node 22). Tests use temporary
  directories and a fake `security`. `nodeExec` is exercised only by running Node
  itself. No scenario suite exists yet (HL-12). No real agent or live call evidence
  applies.
- Open issues or follow-ups: the real `security` path is unverified on a Mac. That
  covers `-i` with `-X`, exit 44 for a missing item, and `find -w` printing the
  stored text. The read-back makes a wrong assumption fail loudly instead of
  silently. Check it once by hand (HL-11 `hotline doctor` is a natural place).
  Recheck the fixtures against `claude --version` and `codex --version` before
  HL-06 golden tests rely on them. Neither docs page carries a version. On the
  same-user limitation, the cheap mitigation is for `hotline init` and the docs
  (HL-11, HL-14) to recommend a narrowly scoped ElevenLabs API key (Agents and
  outbound calls only) and to keep Twilio credentials to what SMS and signature
  checks need. Putting the provider calls behind a separately signed helper with
  its own Keychain access list would close the gap. That is Tier 2 work, not a
  Tier 1 ticket.

## 2026-10-13 — HL-04 Daemon skeleton (#25)

- Decision / change: `packages/daemon` gains the server, store, logging and
  lifecycle, and `apps/cli` gains `hotline daemon [--port <n>]`. Fastify is pinned
  at 5.12.5, the newest release at least two weeks old. 5.12.6 and 5.12.7 came out
  today. 5.12.6 fixes GHSA-389g-gv7q-r4x8, a header validation bypass through
  case-sensitive `propertyNames`, which does not apply: Hotline declares no header
  schemas and does its own auth in hooks. Bump once 5.12.7 is two weeks old.
  SQLite uses Node's built-in `node:sqlite`, so there is no native dependency. It
  works unflagged on Node 22.23.1 (SQLite 3.51.3) and 24.11.0 (3.50.4), and Node
  unflagged it in 22.13.0, which is already `engines.node`. It prints a one-time
  `ExperimentalWarning`. The CLI imports the daemon lazily, so `hotline --version`
  does not.
- Decisions without a plan answer: (1) **Two listeners**, both on 127.0.0.1 and
  neither configurable to 0.0.0.0. The agent API is on `daemon.port`. The webhook
  listener, which serves only `/hooks/*`, is on `daemon.port + 1` and is the
  tunnel's target. A tunnel therefore cannot reach the agent API whatever its path
  rules, which is stronger than one port with a prefix. Core's config was left
  alone, so `daemon.port` 65535 is refused at startup. (2) The API token is the
  existing `daemon.apiToken` secret: 32 random bytes in base64url, created on
  first start in the configured store (Keychain on macOS, else the `0600` file)
  and compared in constant time over SHA-256 digests. (3) The agent API also
  requires a loopback `Host` header, against DNS rebinding and a misrouted tunnel.
  Every path needs the token, so an unauthenticated caller cannot tell which
  routes exist. (4) Webhook routes must declare a verifier. A route without one is
  refused in `onRequest`, before the body is read, and the verifier runs in
  `preHandler`, where anything but `true` (a throw included) is a 403. All of
  `/hooks/*` answers 403 until HL-07 and HL-08 add verified routes. Rejections log
  method, path and reason only. (5) The store keeps validated JSON records plus
  query columns. Migrations use `PRAGMA user_version`, one transaction each, and
  a newer schema is refused. `recordAnswer` runs `answerProblem` inside the
  insert transaction, and `answered` cannot be set any other way. Triggers make
  the audit table append-only. The database is `0600` and gets the same
  symlink and ownership checks as the config. (6) Redaction runs on each final
  JSON log line, not on chosen fields, so messages, serializers and error stacks
  are covered. Numbers keep their last four digits. Known secret values,
  credential-like `name=value` and JSON pairs, Bearer credentials, PEM keys,
  common key formats and long letter-digit runs are removed. Only Twilio SIDs
  are kept (see the sixth review round). (7) Shutdown: the first
  SIGINT or SIGTERM closes both listeners (in-flight requests finish), then the
  database, and exits 0. After 10 s it gives up and exits 1. A second signal
  gets Node's default handling.
- Evidence (automated, worktree, Node 24.11.0 and 22.23.1): `run.sh build`
  passes (Biome, `tsc -b`, typecheck, CLI smoke) and `run.sh test` runs 229 tests
  in 17 files. New daemon tests and the extended CLI tests cover redaction, the
  token, the store and migrations on temp-directory databases, both listeners on
  ephemeral 127.0.0.1 ports, `runDaemon` with SIGINT and SIGTERM on an injected
  signal source, the shutdown timeout, and the CLI command. Mutation checks:
  making `tokensMatch` always true fails 3 tests; removing the `onRequest`
  webhook guard fails 1, because the `preHandler` check still answers 403.
  Manual: the built CLI ran as a child process in a temp `HOTLINE_HOME`. Health
  with the token got 200, without it 401, and a webhook POST got 403. A real
  SIGTERM and a real SIGINT each exited 0 in about 5 ms, and the logs held
  neither the token nor the number. No scenario suite exists yet (HL-12). Real
  agent integration and live calls do not apply.
- Review fixes (staff review and Greptile on #25):
  - Fastify's automatic "incoming request" line logged the full URL, query
    included, before any auth hook ran. Its `req` serializer now logs method and
    path only, and tests assert that a query marker never reaches the log on
    either listener. Without the serializer, 2 tests fail.
  - Two daemons starting at once on the same home could each store a different
    token. A `daemon.lock` pid file, created exclusively before the token and the
    database, now refuses a second daemon. Stale locks from dead processes are
    replaced, and the lock is released on stop and on any startup failure.
  - `runDaemon` now closes the listeners and store, removes its signal handlers
    and releases the lock if anything fails after the listeners start,
    `onReady` included.
  - The database file is created `0600` before SQLite opens it.
  - Second review round: replacing a stale lock was racy (two starters could
    both remove it). Only the starter that exclusively creates
    `daemon.lock.break` may now replace it, after re-reading that it still
    holds the stale pid. A 4-starter race test, run 25 times, fails 2 tests
    with the old plain `rm`. The credential-assignment pattern is now anchored
    at a name boundary with bounded repetitions. Strings over 16 KiB are cut
    before pattern redaction, after known secrets have been replaced, and the
    word at the cut is dropped, so no token fragment survives.
  - Third round (coordinator security findings on `redact.ts`):
    - (1) Truncation now uses a backward scan instead of `/[^…]*$/`. That
      regex took 129 ms on a hostile 16 KiB line, and a test now requires
      under 50 ms. Every other pattern is anchored or bounded, and six hostile
      16 KiB shapes are timed.
    - (2) `pin`, `passcode`, `otp` and Twilio's `Digits` count as secret names
      in keys, `name=value` and JSON text. `addShortSecret` registers a 4 to 8
      digit PIN, matched only where it stands alone, and runs after phone
      masking so it cannot break a number apart.
    - (3) Object keys go through text redaction. Numbers with 10 to 15 digits
      are masked as phone numbers, except pino's top-level `time`.
    - (4) Quoted values honour backslash escapes, and the rest of the word
      after the closing quote goes too. An unterminated or over-long quote
      fails closed to the end of the line.
    - (5) A `%XX` escape before a number is a boundary, and any bare 10 to 15
      digit run is masked even inside a word.
    - The bias is to over-redact: ids with 10 or more consecutive digits lose
      those digits.
  - Fourth round (coordinator follow-up on 0dc356c):
    - (1) Every number is redacted like its decimal text, so `{input: 1234}`
      with that PIN registered, or a number equal to a known secret, is
      removed under any key.
    - (2) The short-secret pass now runs before phone masking. It removes
      whole any digit run or formatted number containing the PIN, so `12345`,
      `12341234`, a 12-digit run ending in the PIN and `+1 (555) 555-1234` all
      fail closed, and a masked number can never print the PIN as its last
      four digits. The digit-cluster pattern is linear, and timed tests cover
      four hostile shapes with a PIN registered.
    - (3) Known secrets also match their `encodeURIComponent` form (upper- and
      lowercase escapes) and their JSON-escaped form.
  - Fifth round (coordinator, parser differential): form parsers decode `%XX`
    and `+` before they read a name, which raw-text patterns missed
    (`Dig%69ts=1234`, `Digits+=1234`, `%44igits=1234`). Each `&`/`;`/`?`/`#`/`,`
    or whitespace segment holding an escape or `+` is also checked decoded.
    Malformed escape runs decode byte by byte. If the decoded copy looks secret,
    the whole raw segment is removed (made fully fail closed in the sixth
    round). With the pass disabled, 6 tests fail.
  - Not changed: webhook verification still runs after body parsing (256 KiB
    cap), which signatures over form parameters need. HL-07 can refuse a
    missing signature header earlier.
  - Sixth round (coordinator, last redaction changes in HL-04):
    - A stray `]` appeared when an earlier pass had already written
      `[REDACTED]` (`From=%2B15555550100&Digits=4821` gave
      `Digits=[REDACTED]]`). The assignment value group now consumes an
      existing marker whole.
    - The decoded-copy check fails closed: if the decoded segment looks secret,
      the whole raw segment goes, even when the raw form already matched in
      part.
    - The id exemption is now exact: only Twilio `CA`/`SM`/`MM`/`PN`/`MG` SIDs
      with exactly 32 hex digits. ElevenLabs-prefixed values and UUIDs are
      removed like any other long run. The daemon logs its own ids through
      structured fields it controls.
    - Staff P3: after a shutdown timeout the lock is kept, because the store
      may still be open, and the stale-pid check frees it once the process
      exits.
    - The rest goes to HL-13 (#14): base64, upper-cased or line-split copies
      of registered secrets, slash-separated phone numbers, and YAML
      continuation lines.
  - Staff P2 (audit ids): migration 2 adds nullable `ask_id`, `session_id` and
    `call_id` columns to `audit`. `appendAudit` takes them as typed ids,
    validated against core's `Id` and stored unredacted, while `detail` is still
    redacted with no exemption, so UUID ids stay queryable and a UUID-shaped
    secret in `detail` is still removed.
- Logging contract (documented at the top of `logger.ts` and in
  `docs/daemon.md`):
  - Callers log parsed, allowlisted fields only.
  - Request logs carry method and path only.
  - The redactor is a safety net, not the primary control.
  - Deeper work belongs to HL-13 (#14): fuzzing the redactor, `.env` lines and
    the threat model.
- Open issues or follow-ups: add `daemon.webhookPort` to the config contract
  (lane:core) if the `port + 1` convention gets in the way. HL-07 needs a
  urlencoded body parser on the webhook listener and HL-08 the raw body for
  HMAC; both plug into `WebhookRoute`. HL-13 should extend the redaction corpus
  with `.env` files and real provider payload shapes. Bump Fastify once a fixed
  release is two weeks old.

## 2026-10-13 — HL-03 Ask queue and call policy (#24)

- Decision / change: `packages/core` gains `policy.ts` (settings, priority, quiet
  hours, rolling rate limits) and `queue.ts`, a pure state machine:
  `step(state, event, now, settings)` returns a new JSON-serializable state and
  actions (`place-call`, `send-text`, `resolve`, `delivered`, `ignored`) for the
  daemon to execute, and `nextWakeAt` says when to tick. No contract changed.
  Documented in `docs/contracts.md`. Choices the plan leaves open, taken without
  asking: priority is urgent, then permission > question > stop > notify, then
  oldest. A new ask waits the batch window, then one call covers every callable
  waiting ask (at most 4 per call, one call at a time). Duplicate questions and
  notifications (same session, kind, text, options, tool and risk while the first
  is open) share its answer, each re-checked with `answerProblem`; permission and
  stop asks are never deduped (see the security fix below). Quiet hours text everything except urgent
  asks when `allowUrgentCalls` is set, and only those urgent asks join a
  quiet-hours call. Equal start and end means no quiet time. Rate limits are rolling
  1 h and 24 h windows. Over the call limit an ask is texted; over the text limit
  too, it waits for a slot or expires. No pickup or a failed call retries once
  after 2 minutes, then texts (the HL-03 wording; HL-09's row says "no pickup to
  text to retry", and the eval scenario only needs the text). A dropped call, or
  one that ended with the ask open, texts at once. An unclear answer ends the ask
  as `no-answer` (`unclear`) at once, matching `unclear-answer-denies`.
  Notifications are text-only and end with `delivered`, not an outcome. A call
  never reported as ended counts as dropped after 15 minutes. Retry count and
  delay, asks per call and the stuck-call timeout are constants, not config, so
  the config contract is unchanged. No plan section 12 question bears on the
  queue.
- Safety (issue #10 carry-over): an `answered` outcome comes only from an
  `answer` event that parses, targets an open ask, arrives on a channel the ask
  went out on, and passes `answerProblem(ask, answer, receivedAt)`. A high-risk
  allow without PIN or text confirmation is ignored and the ask stays open, so
  silence after it still ends as a deny. `permissionVerdict(ask, outcome)` gives
  HL-06 one function that denies everything except a confirmed owner approval,
  and it re-parses the outcome so a missing `confirmation` cannot slip through.
- Security fix (coordinator review before the PR was ready): the first version
  deduped permission asks on `ask.text`, which is a redacted, length-capped
  summary. Two different commands in one session could therefore share one
  `allow`, along with a copied PIN confirmation. Now only `question` and `notify`
  asks are deduped. `permission` and `stop` asks always get their own decision,
  though one call may still read several out. A shared answer is always stored
  with `confirmation: "none"`, so a PIN or confirming text never moves from one
  ask to another. New tests: two identical high-risk permission asks each need
  their own answer, and allowing one leaves the other open until it times out
  as a deny. A shared question answer carries no confirmation. A property
  checks that no permission ask is ever answered by an answer the owner
  addressed to another ask id.
- Review fixes (Greptile and the bot staff review on the first head):
  `nextWakeAt` returns `now` for overdue work instead of skipping to a later
  deadline. A notification ends as `delivered` only after a new `text-sent`
  event; a failed text ends it as `no-answer` (`failed`) and a duplicate is tried.
  Giving up on a stuck call emits `end-call` so the daemon hangs up before placing
  another. A retry waiting out its delay is no longer pulled into another ask's
  call. Sends stamped after `now` keep counting against the rate limits when the
  clock moves back. A voice answer counts only while its ask is on the call in
  progress, not after that call ended, and an `unclear` report only while the ask
  is on a call or awaiting a text reply (not during a retry wait). An ask that
  expires or is cancelled mid-call is resolved at once; `docs/contracts.md` tells
  the daemon to drop it from the live call.
- Dependency: fast-check 4.10.2 (released 2026-09-19; its one dependency
  pure-rand 8.4.2 is from 2026-07-10) as a core dev dependency for property tests.
- Evidence (automated, worktree, Node 24.11.0 locally; CI covers Node 22):
  `pnpm --filter @hotline/core test` passes 107 tests in 8 files. Three
  properties of 400/400/100 runs each cover about 34,000 steps, 1,070 calls, 680
  given-up calls, 1,430 texts and 480 answered outcomes per run of the suite. Every answered outcome is
  re-checked against `answerProblem` and the channel. The silent property asserts
  only `no-answer` outcomes and `deny` verdicts. Both check one call at a time, no early retries, delivery only after
  `text-sent`, a next wake-up after `now`,
  rate limits over every rolling window, quiet hours, and exactly one end per ask
  by its expiry. A mutation check run by hand broke the queue eleven ways: skipping
  `answerProblem`, ignoring the call limit, ignoring quiet hours, skipping the
  channel check, accepting voice answers after the call, batching retries early,
  delivering a notification on send, turning an unclear answer into an allow,
  dropping expiry, deduping permission asks again, and copying confirmation to
  duplicates.
  Each made the property tests fail. No scenario suite exists yet (HL-12); no real
  agent or live call evidence applies.
- Open issues or follow-ups: HL-09 drives `step` and `nextWakeAt`, maps text
  replies to ask ids, and picks a stored status for a delivered notification
  (`AskStatus` has no `delivered`). A `call me` text reply has no queue event yet.
  An ask held only by the text limit during quiet hours is not woken when quiet
  hours end; it waits for a text slot or its expiry.

## 2026-10-13 — HL-07 SMS provider (#30)

- Decision / change:
  - `packages/providers`: `SmsProvider` with `sendToOwner(text)` only. A provider
    is bound to the owner's number when created, so no caller can text anyone
    else. `TwilioSmsProvider` is a small hand-written REST call (one form POST to
    the Messages resource, Basic auth, 10 s timeout) with a required injected
    `fetch`, instead of the `twilio` package: one request type does not justify
    the dependency, and a required `fetch` means no test can reach the network.
    Texts are redacted by an injected function and capped at Twilio's 1600
    characters. Errors carry Twilio's numeric code, never its message text.
    `FakeSmsProvider` keeps the same rules and records sends.
  - Signature validation is hand-written HMAC-SHA1 per
    https://www.twilio.com/docs/usage/security#validating-requests. The test
    reproduces Twilio's documented example (token `12345`, signature
    `L/OH5YylLD5NRKLltdqwSvS0BnU=`) verbatim. Its numbers are Twilio's
    published example values, not 555 numbers, because the signature covers
    them; every other test uses `+1555555 01xx`. Comparison hashes both sides
    with SHA-256, then `timingSafeEqual`. Repeated parameter names fail closed.
  - Webhook router (issue #8 constraints from the HL-04 review): routes can
    declare a `precheck` that runs in `onRequest` before the body is read
    (Twilio: signature header present and form content type). A strict
    `parseFormBody` replaces `URLSearchParams` semantics (malformed escapes,
    invalid UTF-8 and empty segments throw). Every 4xx on the webhook listener,
    parse errors included, becomes the same bare `403` with an empty body, as do
    all other rejections; the HL-04 test that expected `{"error":"forbidden"}`
    now expects the empty body.
  - `POST /hooks/twilio/sms`: verified against the exact public URL (configured
    origin plus raw path and query) and our `AccountSid`. Only `From` = owner and
    `To` = `sms.fromNumber` reaches the handler; anyone else gets one generic
    reply, capped at 5 per hour in total, so strangers cannot run up the bill.
    The last 1000 message SIDs are remembered to drop retries and replays
    (durable replay protection stays with HL-13). When Twilio sends
    `OptOutType`, Hotline does not reply on top of Twilio's own reply.
    `runDaemon` registers the route only with the config and both Twilio secrets
    present, and adds the auth token to the redactor. Until HL-09, an owner's
    text is audited by SID and reply type only.
  - Reply parsing is pure in `packages/core/src/sms-reply.ts` (a new file, so it
    stays disjoint from HL-03's `queue.ts`). Exact whole-message matching; free
    text never approves a permission request. `stop` and all of Twilio's default
    opt-out keywords mean "stop texting me", because Twilio blocks further texts
    after any of them; Twilio's opt-in and help keywords are never answers.
  - High-risk approvals by text (plan section 8): the owner replies
    `yes <code>` with a one-time code the daemon put in the outgoing text, and
    only a match sets `confirmation: "text"`. The code proves the reply came from
    the phone that received the text, which a spoofed sender number cannot.
    The PIN is never accepted by text, so it never passes through Twilio.
    Generating and storing the code per ask is HL-09's job.
- Evidence (automated): `scripts/ci/run.sh build` (Biome, `tsc -b`, typecheck
  including tests, CLI smoke) passed; `scripts/ci/run.sh test` passed (490
  tests in 26 files after rebasing on HL-03). A mutation check (dropping the account SID check, the signature
  header precheck and the `From` check) failed 5 webhook tests. Scenario suite:
  not built yet (HL-12). No real agent or live-call testing; no real Twilio
  request was made.
- Open issues or follow-ups: HL-09 constructs `TwilioSmsProvider` from the
  config and secrets (passing `globalThis.fetch` and the daemon redactor),
  generates confirmation codes, and replaces the audit-only owner handler with
  `smsAnswer` plus replies. HL-10 answers the `status` text. HL-13: durable
  replay protection by message SID, fuzzing `parseSmsReply`. If Twilio's
  Advanced Opt-Out is configured to treat `YES` as an opt-in keyword, the owner
  may also see Twilio's opt-in confirmation; the answer still arrives.
- Staff review (two P2s, both constraints on HL-09, nothing exploitable in this
  PR). These are HL-09 acceptance criteria:
  - (1) Twilio signatures carry no timestamp, and the SID set is in memory, so a
    captured signed "yes" could be replayed after a restart. Accept a text only
    for an ask Hotline actually texted that is still open (`answerProblem` covers
    the time window). Persist handled SIDs (HL-13).
  - (2) Bind each reply to one texted ask. When several permission asks are
    waiting on texts, fail closed instead of giving a bare "yes" to the newest.
    Generate confirmation codes randomly per ask, expire them with the ask, and
    consume them on first use.
  - The outgoing text should say "reply YES or NO", because `cancel`, `end` and
    `quit` mean stop.
  - Fixed here (P3): a network failure's `SmsSendError` keeps only the system
    error code, not the raw error, whose cause can name the URL with the account
    SID. `docs/daemon.md` now says the Twilio webhook URL must be exactly
    `<publicUrl>/hooks/twilio/sms` (the config already refuses a `publicUrl` with
    a path).
- Greptile fixes (three threads on #30):
  - Webhook replies: `twilioSmsRoute` now requires a `redact` option, and a
    reply from the owner handler is redacted and length-checked with
    `prepareSmsText` before it reaches the TwiML, the same path outgoing texts
    take. A reply that is empty after redaction or too long is dropped, not
    sent. `runDaemon` passes the daemon redactor.
  - Retries: a SID is recorded as handled only after its handler succeeds. A
    copy that arrives while the first attempt is still running waits for it
    and handles the message itself if that attempt fails, instead of getting a
    200 before the work is done. A failed other-sender audit write also leaves
    the SID unhandled.
  - The generated "never approves" test judged results with `parseSmsReply`,
    the parser under test. It now uses its own literal yes-word list and code
    rule, and requires the approvals to match that list exactly.
  - Mutation checks: the old route fails 4 of the new webhook tests; adding
    `ok` to the parser's yes words fails the generated test, which passed
    before.

## 2026-10-13 — HL-03b Call-me text event (#31)

- Decision / change: the queue takes a pure `call-me` event for an owner text of
  `call me` (issue #28, plan flow E). With no call in progress and at least one
  open ask that needs an answer (not a notification, not a duplicate, not past
  expiry, waiting or already texted), it places one call at once, highest
  priority first, at most four asks. `place-call` still names asks only; the daemon
  dials the owner number and must send `call-me` only for a text it verified came
  from that number. The event is never an answer, so silence after it still ends
  as `no-answer` and a permission request still denies.
- Decisions (no human available; recorded per the ticket):
  - An explicit owner request overrides quiet hours for that one call (the issue's
    stated default). It also overrides the batch window, a retry delay and an
    earlier fallback to text, because the owner asked to be called now. Later asks
    and retries follow quiet hours again.
  - It never overrides the call limit: over the limit the event is `ignored` with
    the reason "over the call limit; open asks keep going by text", and the asks
    keep their text path. A call already in progress also makes it `ignored`.
  - No open asks: the event is `ignored` ("no open asks to call about") rather than
    a new "nothing pending" text action. `send-text` always carries an ask id, and
    a new action type would widen the daemon contract for one reply; HL-09 can
    answer the owner from the ignore reason.
  - A call already past the stuck-call timeout does not block the request: it is
    hung up (`end-call`) and treated as dropped first, as a `tick` would.
  - When a `call-me` call ends with an ask that had been texted still open, the ask
    returns to awaiting its text reply instead of being retried or texted again,
    so the owner gets no duplicate text and can still reply by SMS.
- Evidence (automated, worktree, Node 24.11.0 locally; CI covers Node 22):
  `scripts/ci/run.sh build` passes (Biome, `tsc -b`, test typecheck);
  `scripts/ci/run.sh test` passes 376 tests in 22 files, 116 of them in core.
  Nine new unit tests cover: open asks with no call (calls at once, by priority,
  notifications left to text), an ask already texted (voice answer on the call, an
  SMS reply afterwards, no second text), an ask in its retry delay, a call in
  progress, a stuck call (hung up, then the owner's call placed), quiet hours (one call only, no retry call, the next ask texted), over
  the call limit, no open asks (empty, notification only, expired), and call-me
  never answering a high-risk permission. The property suite adds `call-me` to the
  random event mix: the silent property still sees only `no-answer` and `deny`;
  every place-call names asks and no number; a call-me call never starts while
  one is in progress and covers only eligible asks; quiet-hours and retry-delay
  checks are exempted only for the call the owner asked for; rate limits hold
  with call-me calls counted. A liveness check requires a call-me with an open
  ask, no call and a free call slot to place exactly the expected call; a
  temporary counter showed it firing 384 times per suite run. A mutation check
  broke the change eight ways (ignore the call limit, ignore a call in progress,
  call about notifications, never call, wrong order, call about expired asks,
  keep a stuck call blocking, retry or re-text an already texted ask);
  each made the tests fail. `scripts/ci/run.sh eval` is not built yet (HL-12);
  no real agent or live call evidence applies.
- Review fixes (bot staff review): a `call-me` during a live call now always
  reports "a call is already in progress", even when every open ask is on that
  call. `docs/contracts.md` states that a call-me call counts as a call attempt
  (it uses up automatic retries) and that the queue has no call-me cooldown beyond
  the call limit and one call at a time. Repeated owner texts after a call ended
  are honored as fresh requests; a redelivered webhook is the daemon's to dedupe
  by message id.
- Review fixes (Greptile P1 and the bot staff review on 233d8e8): a texted ask can
  be on a `call-me` call before its text is confirmed. A `text-failed` arriving then
  used to be ignored, leaving the ask waiting for a reply to a text that never
  arrived. It now marks the ask as not texted (no SMS reply counts), and when the
  call ends the ask follows the no-pickup rules and is texted again. `text-sent`
  is accepted during the call too. A texted ask whose call-me call goes unanswered
  now expires as `timeout`, not as the call's `no-pickup` or `dropped`, because
  the text is the outstanding channel. The property suite then found a stale
  `readyAt`: a call-me call placed inside the batch window left `readyAt` in the
  future, so a zero-delay retry looked early. The call now sets `readyAt` to the
  call time. A regression unit test pins it, and 40 more property-suite runs
  (about 36,000 random runs) passed. The hand mutation check now has eleven
  mutants: the eight above, plus keeping a failed text as texted, dropping the
  `readyAt` reset, and ignoring a text failure during the call. All are killed.
  `scripts/ci/run.sh test` passes 379 tests (119 in core).
- Catch-up with main after HL-07 (#30): only this log conflicted; HL-07's
  `sms-reply.ts` sits next to the queue in `@hotline/core` with no name clash.
  `scripts/ci/run.sh build` passes and `scripts/ci/run.sh test` passes 507 tests
  in 26 files (186 in core).
- Open issues or follow-ups: HL-07's `parseSmsReply` already turns `call me` into
  the `call-me` command; HL-09 maps that command to this event, dedupes inbound
  texts by message id, and turns the ignore reasons into owner replies.

## 2026-10-13 — HL-05 MCP server (#32)

- Decision / change: `hotline mcp` (stdio, `packages/agents`) offers
  `ask_human`, `notify_human` and `check_inbox`; see `docs/mcp.md`. It talks only
  to the daemon on 127.0.0.1 with the token and never follows redirects
  (Greptile). It relays `answered` only for the
  ask it created and only with a decision a question can have. Every failure,
  timeout, cancel or doubtful outcome is `no-answer`.
  `@modelcontextprotocol/sdk` is pinned at 1.31.0 (15 days old; its one change
  since 1.30.1 is OAuth-only, and 1.32.x is too new). zod 4.6.5 is now a direct
  dependency of `agents` and `daemon`.
- Daemon routes (minimal, behind the existing token and `Host` checks):
  - Session register and end.
  - Question or notify asks, with text and options redacted before they are
    stored. HL-06 adds `permission` and `stop`.
  - A long-polling outcome route, cancel, and inbox.
  - An `answered` outcome comes only from an answer the store accepted
    through `recordAnswer` after `answerProblem` (the requirement carried over
    on #7 and #10).
  - Open asks are capped at 3 questions and 10 notifications per session, and
    10 and 30 across all sessions (`429`, audited). Due asks are marked
    expired before each count. `urgent` is stored only as the agent's
    request.
  - The store gained `onAskChange`, `listSessionAsks`, `countOpenAsks` and
    `findLiveSession`. There is no migration.
- Defaults chosen:
  - The agent comes from `--agent`, else from `clientInfo.name`. Claude Code's
    `CLAUDE_CODE_SESSION_ID` becomes `agentSessionId`; Codex exposes none.
  - The server registers on initialize and ends the session on close.
  - It long-polls 25 s at a time. After 3 failed polls it returns `failed` and
    cancels the ask, best effort.
  - It sends progress every 60 s, only when the client sent a `progressToken`.
  - `check_inbox` returns `instructions: []` until HL-10.
  - Timeouts, from the docs and the Codex rmcp source (not tested): Claude
    Code's per-server `timeout` is a hard limit, so the snippet sets none. The
    stdio idle timeout of 30 min resets on progress; the snippet suggests 40
    min. Codex's `tool_timeout_sec` (60 s) does not reset on progress, so the
    snippet sets 2100.
- Bug fixed: a client that aborted a long poll could leave a connection that
  `server.close()` never reaped, so shutdown hung until the 10 s timeout.
  Shutdown now releases long polls and closes leftover agent API connections
  after 2 s. With that fix disabled, 9 of 10 runs of the MCP test file failed;
  with it, 12 of 12 passed.
- Evidence (worktree, Node 24.11.0; the pre-merge tree also on 22.23.1):
  - `run.sh setup`, `build` and `test` pass, with 572 tests after merging main.
  - The tests drive the SDK `Client` against a real daemon on 127.0.0.1
    (InMemoryTransport, fake clock), plus `hotline mcp` over stdio framing.
  - Mutation checks fail tests when the `askId` match, ask-text redaction or
    the ask cap is removed.
  - Manual: the built CLI ran as child processes, with the daemon and
    `hotline mcp` driven by the SDK `StdioClientTransport`. `ask_human`
    returned the recorded option with the owner's words, the daemon exited 0,
    and neither process's stderr held the token.
  - Not run: the scenario suite (HL-12); real Claude Code and Codex, because
    driving them calls their model APIs; live call.
- Open issues or follow-ups:
  - HL-09: store specific no-answer reasons, and gate `urgent` on
    `quietHours.allowUrgentCalls` and the rate limits. Before calling, check
    that the ask is still open and its session not ended: an agent that gave
    up while the daemon was unreachable cannot cancel its ask.
  - HL-10: add the instruction queue, and expire stale sessions (a killed
    server never ends its session).
  - HL-11: write the `docs/mcp.md` snippets.
  - A human should confirm the snippets and a Codex wait of more than 60 s with
    real sessions and fake providers.

## 2026-10-14 — HL-06 Hook adapters (#7)

- Decision / change: `hotline hook <claude|codex> <permission|stop>` reads the
  agent's payload on stdin and prints its documented output or nothing
  (`packages/agents/src/hook-adapter.ts`, `apps/cli/src/hook.ts`); see
  `docs/hooks.md`. Outside away mode, or for a payload it cannot parse, it
  prints nothing, so the agent shows its own prompt or stops. In away mode a
  permission is allowed only through core's `permissionVerdict`; every no-answer,
  timeout, unreachable or unset daemon, refused or malformed outcome, approval
  of another ask, unconfirmed high-risk approval, or kill by the agent denies
  with the fixture's message. A Stop continues only with the owner's own `text`
  answer (new core `stopInstruction`). Never `updatedInput`,
  `updatedPermissions`, `interrupt` or a permission suggestion. Exit code is
  always 0 (usage errors 1), never 2, since exit 2 from a Stop hook means
  "keep going".
- Away mode: `hotline away on|off|status` writes `away.json` in the hotline home
  under the private-file rules (0600 in 0700, no symlinks, own user). Anything
  unreadable is off. HL-11 still owns `init`, `install` and `doctor`; it only
  needs to call these.
- Loop guards: `stop_hook_active: false` resets the count; `true` without a
  count of Hotline's own (another hook continued the turn) lets the agent stop;
  at `policy.maxConsecutiveContinuations` the agent stops and a notification is
  queued. Counts are `hook-state/<agent>-<sha256>.json` (0600). A count that
  cannot be read or saved lets the agent stop. `away on|off` clears them.
- Risk classes (plan question 6, recommended default): `classifyPermission` in
  `@hotline/core` (pure). High: deleting files, git push or history rewrites,
  network installs and downloads, writes outside the project, credentials or
  agent settings (`.env`, `.ssh`, `.hotline`, `.claude`, `.codex`,
  `.git/config`, ...). Added as fail-closed cases: `sudo`, nested shell code,
  `WebFetch` (sends data off the machine), every MCP or unknown tool, and input
  it cannot read. Inside the project only the path below the root counts
  (worktrees live under `.claude/`). The hook judges outcomes with the stricter
  of its own class and the stored one.
- Security review fixes (coordinator review of ce62b97):
  - The first version used a denylist, which `/bin/rm`, `$(...)`, backticks,
    `command rm`, `env rm`, `xargs rm`, `git -c alias.x=push x`, `r\m` and
    variable-built commands slipped past.
  - Shell commands now fail closed. `splitShell` splits on `;`, `&&`, `||`, `|`
    and newlines with quotes, and refuses `$`, backticks, backslashes,
    subshells, background jobs, here-documents, comments and unbalanced quotes.
  - A command is low risk only if every simple command is on a read-only
    allowlist (`ls`, `cat`, `grep`, `rg`, `find` without `-delete`/`-exec`/
    `-fprint`, read-only `git`, package-manager `test`/`build`/`lint`/
    `typecheck`) with arguments and redirections inside the project. Otherwise
    the owner hears the denylist reason, or "runs a command Hotline does not
    recognise as read-only".
  - `projectRoot` treats an empty, relative, `/`, top-level or home-directory
    `cwd` as no project, so every path there counts as outside.
  - The owner's line now reads the risk first. A preview cut at 200 characters
    says "command shortened, N more characters" and forces high risk.
  - The agent's description is labelled `The agent says: "..."`, never stands
    in for the command, and is dropped when it has no letters or digits. The
    hook cannot see the daemon's redaction, so "empty after redaction" is
    approximated by that cleaning step.
- Greptile and staff review fixes on PR #34:
  - Text is cut only between words, so a secret is never left as a fragment
    the redactor misses.
  - Unknown and MCP tools show argument names, never values.
  - Each outcome poll ends at the hook's deadline, and a late answer denies.
  - The Stop hook rechecks away mode before continuing.
  - Every non-continuing Stop exit clears the count.
  - `hotline away` and `.hotline/` paths are high risk.
- Second security review (coordinator, of f85b69b):
  - Expansions were not modelled: `cat {/etc/passwd,x}` and `cat .e*` passed.
    The tokenizer now allows only `[A-Za-z0-9_./:@%+,-]` and a non-leading `=`
    outside quotes. Single quotes may hold anything else. Double quotes may not
    hold `!`. `$`, backticks, backslashes and C0/C1 controls are refused
    everywhere. zsh numeric globs (`<1-10>`) are refused.
  - Attached option values (`grep -f/home/u/.ssh/id_rsa`, `head -c1/etc/x`)
    are checked as paths, and are high when they do not split cleanly.
  - Writes to `.git/`, `.gitattributes`, `.gitmodules`, `.husky/`,
    `package.json`, `node_modules/` and package-manager rc files are high even
    inside the project, because git and the allowlisted package scripts honour
    them. Reads stay low.
  - Package scripts stay low. The module comment and `docs/hooks.md` say they
    run project code, and that the owner's explicit "yes" is the protection.
  - Parser-differential tests cover each class: brace, glob, tilde, zsh `=cmd`,
    numeric glob, qualifier, `^` and `#`, ANSI-C `$'..'`, double-quote `$`, `!`
    and backticks, CR, NUL, other C0 and C1 controls, Unicode lookalike
    separators and spaces, and `&!`, `>!`, `|&`, `<>`.
- Daemon: `POST /v1/sessions/:id/asks` accepts `permission` (requires
  `toolName`, identifier characters up to 100, and `risk`) and `stop`; text and
  tool name are redacted before storage. Caps per session / total: permission
  3 / 10, stop 1 / 10, and a new stop cancels the session's stale open stop. A
  session is `waiting-on-human` while it has an open question, permission or
  stop. `HotlinePaths` gained `away` and `hookState`.
- Waiting (plan question 2, recommended default: synchronous wait with a long
  hook timeout): the hook waits up to `--wait-seconds` (default 540, under both
  agents' 600 s default `timeout`, which discards output), then cancels the ask
  and denies or lets the agent stop. `docs/hooks.md` snippets set
  `timeout: 1900` with `--wait-seconds 1830` to cover the 30-minute ask timeout.
  SIGTERM or SIGINT cancels the ask.
- Fixture recheck (carried over on #7), offline, no model calls: the Codex
  0.146.0 binary embeds the four generated hook schemas, identical to
  `codex/schema/`. The Claude Code 2.1.299 bundle's zod schemas match the
  fixtures, plus new optional input fields (`prompt_id`, `agent_id`,
  `agent_type`, `mcp_server`) the loose schemas already allow. Notes in the
  fixtures README.
- Evidence (worktree, Node 24.11.0):
  - `scripts/ci/run.sh setup`, `build` and `test` pass: 682 tests in 34 files
    at ce62b97, 766 at f85b69b, and 824 after the second security review.
  - The security fixes have a bypass test for each case the review listed,
    plus unknown-project, shortened-preview and reassuring-description tests.
    Earlier expectations only moved from low to high. Mutations: treating
    unknown commands as read-only fails 29 risk tests; counting `/` as a
    project fails 2.
  - Golden tests: every HL-02 input fixture for both agents through `runHook`
    against a real daemon on 127.0.0.1 (temporary store, fake clock), with the
    owner's answer written by `recordAnswer`; outputs equal the allow, deny and
    stop-block fixtures. Fake-daemon tests cover every failure path. CLI tests
    run `hotline hook` and `hotline away` against a temporary HOTLINE_HOME.
  - Mutation checks: allowing on any answered outcome fails 6 tests; dropping
    the stricter-risk rule fails 2; dropping the "continuation not ours" guard
    fails 1.
  - Manual: the built CLI as child processes (daemon, `away on`, then hooks)
    with a temporary HOTLINE_HOME: allow with PIN printed the allow output, a
    Codex stop printed the block output, SIGTERM printed a deny and left the ask
    `cancelled`, `--wait-seconds 2` denied, and the daemon exited 0 without the
    token in its stderr.
  - Not run: the scenario suite (HL-12); real Claude Code or Codex sessions
    (that would call their model APIs); live call.
- Open issues or follow-ups:
  - HL-09: read permission asks out with their risk and require the PIN or a
    confirming text for `high`; send the cap notification.
  - HL-10: deliver queued owner instructions at the next Stop hook.
  - HL-11: install the snippets in `docs/hooks.md` and have `doctor` check that
    `--wait-seconds` stays below the hook `timeout`.
  - A human should check one real Claude Code and one real Codex session with
    the hooks installed and fake providers, including Codex's `/hooks` trust step.
