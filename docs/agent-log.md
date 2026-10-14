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

## 2026-10-13 — HL-03 Ask queue and call policy

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
  progress, not after that call ended.
- Dependency: fast-check 4.10.2 (released 2026-09-19; its one dependency
  pure-rand 8.4.2 is from 2026-07-10) as a core dev dependency for property tests.
- Evidence (automated, worktree, Node 24.11.0 locally; CI covers Node 22):
  `pnpm --filter @hotline/core test` passes 105 tests in 8 files. Three
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
