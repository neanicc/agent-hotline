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
  common key formats and long letter-digit runs are removed. Twilio CA/SM SIDs,
  ElevenLabs ids and UUIDs are kept so logs stay usable. (7) Shutdown: the first
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
  - Not changed: webhook verification still runs after body parsing (256 KiB
    cap), which signatures over form parameters need. HL-07 can refuse a
    missing signature header earlier.
- Open issues or follow-ups: add `daemon.webhookPort` to the config contract
  (lane:core) if the `port + 1` convention gets in the way. HL-07 needs a
  urlencoded body parser on the webhook listener and HL-08 the raw body for
  HMAC; both plug into `WebhookRoute`. HL-13 should extend the redaction corpus
  with `.env` files and real provider payload shapes. Bump Fastify once a fixed
  release is two weeks old.
