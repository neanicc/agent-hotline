// The hook adapters, golden-tested against the HL-02 fixtures: each fixture input
// goes through `runHook` against a real daemon on 127.0.0.1 (temporary store,
// fake clock), the owner's answer is recorded through the store's
// `recordAnswer` (the daemon's resolution path), and the printed output must
// equal the fixture output. Failure paths use a scripted fake daemon.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Ask,
  type AskOutcome,
  ClaudePermissionRequestOutput,
  CodexPermissionRequestOutput,
  type Decision,
  type Session,
  StopBlockOutput,
} from "@hotline/core";
import { createRedactor, type Daemon, generateApiToken, openStore, startDaemon } from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateAskRequest,
  DaemonClient,
  DaemonError,
  type HookOptions,
  type HookState,
  type HotlineDaemon,
  MAX_PREVIEW,
  NOT_APPROVED,
  type OutcomeState,
  type OwnerInstruction,
  permissionAsk,
  runHook,
  safeToolName,
  stopText,
} from "../src/index.js";

const START = new Date("2026-10-14T09:00:00.000Z");
const fixtures = new URL("./fixtures/hooks/", import.meta.url);
const fixture = (path: string): unknown => JSON.parse(readFileSync(new URL(path, fixtures), "utf8"));
const fixtureText = (path: string, change: (json: Record<string, unknown>) => void = () => {}) => {
  const json = fixture(path) as Record<string, unknown>;
  change(json);
  return JSON.stringify(json);
};

const AGENTS = [
  { flag: "claude", agent: "claude-code", dir: "claude-code" },
  { flag: "codex", agent: "codex", dir: "codex" },
] as const;

let dir: string;
let token: string;
let now: Date;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-hooks-"));
  token = generateApiToken();
  now = START;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function startTestDaemon(): Promise<Daemon> {
  const store = await openStore(join(dir, "hotline.db"));
  const started = await startDaemon({
    apiToken: token,
    store,
    apiPort: 0,
    hooksPort: 0,
    log: { level: "silent", destination: { write: () => {} }, redactor: createRedactor([token]) },
    version: "0.0.0-test",
    clock: () => now,
    askTimeoutMinutes: 30,
  });
  cleanups.push(() => started.close());
  return started;
}

class MemoryState implements HookState {
  away = true;
  counts = new Map<string, number>();
  failRead = false;
  failWrite = false;
  async isAway() {
    return this.away;
  }
  async continuations(sessionId: string) {
    if (this.failRead) throw new Error("unreadable");
    return this.counts.get(sessionId) ?? 0;
  }
  async setContinuations(sessionId: string, count: number) {
    if (this.failWrite) throw new Error("unwritable");
    this.counts.set(sessionId, count);
  }
}

interface Owner {
  decision?: Decision;
  confirmation?: "none" | "pin" | "text";
  words?: string;
  /** Instead of answering, let the ask expire on the daemon's clock. */
  expire?: boolean;
}

/** Plays the owner: once an ask of `kind` appears, answers it through the store or lets it expire. */
function ownerAnswers(
  daemon: Daemon,
  owner: Owner,
  kind: Ask["kind"],
  first: (ask: Ask) => void = () => {},
): Promise<Ask> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const ask = daemon.store.listAsks(["pending"]).find((open) => open.kind === kind);
      if (ask === undefined) return;
      clearInterval(timer);
      first(ask);
      if (owner.expire) {
        now = new Date(Date.parse(ask.expiresAt) + 1000);
      } else if (owner.decision !== undefined) {
        daemon.store.recordAnswer(
          {
            askId: ask.id,
            decision: owner.decision,
            channel: "voice",
            ownerExcerpt: owner.words ?? "yes",
            sourceId: "call-1",
            confirmation: owner.confirmation ?? "none",
            answeredAt: new Date(now.getTime() + 1000).toISOString(),
          },
          new Date(now.getTime() + 1000),
        );
      }
      resolve(ask);
    }, 5);
    cleanups.push(async () => clearInterval(timer));
  });
}

function options(
  daemon: HotlineDaemon,
  state: HookState,
  overrides: Partial<HookOptions> & Pick<HookOptions, "agent" | "event" | "input">,
): HookOptions {
  return {
    state,
    connect: async () => ({ daemon, maxConsecutiveContinuations: 3 }),
    clock: () => now,
    pollSeconds: 1,
    retryDelaysMs: [0],
    ...overrides,
  };
}

function client(daemon: Daemon): DaemonClient {
  return new DaemonClient({
    connection: async () => ({ port: daemon.apiPort, token }),
    requestTimeoutMs: 2_000,
  });
}

const parse = (stdout: string | undefined): unknown =>
  stdout === undefined ? undefined : JSON.parse(stdout);

describe.each(AGENTS)("$flag hooks against the HL-02 fixtures", ({ agent, dir: fixtureDir }) => {
  const permissionInput = fixtureText(`${fixtureDir}/permission-request.input.json`);
  const stopInput = fixtureText(`${fixtureDir}/stop.input.json`);
  const outputSchema = agent === "codex" ? CodexPermissionRequestOutput : ClaudePermissionRequestOutput;

  it("prints the allow fixture for the owner's confirmed approval", async () => {
    const daemon = await startTestDaemon();
    const state = new MemoryState();
    const owner = ownerAnswers(daemon, { decision: { type: "allow" }, confirmation: "pin" }, "permission");
    const result = await runHook(
      options(client(daemon), state, { agent, event: "permission", input: permissionInput }),
    );
    expect(parse(result.stdout)).toEqual(fixture(`${fixtureDir}/permission-request.allow.output.json`));
    const asked = await owner;
    // The fixture commands (`rm -rf`, `git push`) are high risk.
    expect(asked).toMatchObject({ kind: "permission", toolName: "Bash", risk: "high" });
    expect(daemon.store.getSession(asked.sessionId)?.agentSessionId).toBe(
      (fixture(`${fixtureDir}/permission-request.input.json`) as { session_id: string }).session_id,
    );
  });

  it("prints the deny fixture when the ask expires unanswered", async () => {
    const daemon = await startTestDaemon();
    ownerAnswers(daemon, { expire: true }, "permission");
    const result = await runHook(
      options(client(daemon), new MemoryState(), { agent, event: "permission", input: permissionInput }),
    );
    expect(parse(result.stdout)).toEqual(fixture(`${fixtureDir}/permission-request.deny.output.json`));
  });

  it("denies a high-risk approval that lacks the PIN or a confirming text", async () => {
    const daemon = await startTestDaemon();
    // The store itself refuses a plain "yes" to a high-risk ask; the ask then expires with no answer.
    let refused: unknown;
    const owner = ownerAnswers(daemon, { expire: true }, "permission", (ask) => {
      try {
        daemon.store.recordAnswer(
          {
            askId: ask.id,
            decision: { type: "allow" },
            channel: "voice",
            ownerExcerpt: "yes",
            sourceId: "call-1",
            confirmation: "none",
            answeredAt: new Date(now.getTime() + 1000).toISOString(),
          },
          new Date(now.getTime() + 1000),
        );
      } catch (error) {
        refused = error;
      }
    });
    const result = await runHook(
      options(client(daemon), new MemoryState(), { agent, event: "permission", input: permissionInput }),
    );
    await owner;
    expect(String(refused)).toContain("high-risk approval needs the PIN");
    expect(outputSchema.parse(parse(result.stdout)).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it("passes on the owner's refusal and their words", async () => {
    const daemon = await startTestDaemon();
    ownerAnswers(daemon, { decision: { type: "deny" }, words: "no, use pnpm instead" }, "permission");
    const result = await runHook(
      options(client(daemon), new MemoryState(), { agent, event: "permission", input: permissionInput }),
    );
    expect(parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: 'The owner denied this by phone. Their words: "no, use pnpm instead"',
        },
      },
    });
  });

  it("allows a low-risk request on a plain yes", async () => {
    const daemon = await startTestDaemon();
    ownerAnswers(daemon, { decision: { type: "allow" } }, "permission");
    const input = fixtureText(`${fixtureDir}/permission-request.input.json`, (json) => {
      json.tool_input = { command: "pnpm test", description: "Run the tests" };
    });
    const result = await runHook(
      options(client(daemon), new MemoryState(), { agent, event: "permission", input }),
    );
    expect(parse(result.stdout)).toEqual(fixture(`${fixtureDir}/permission-request.allow.output.json`));
  });

  it("prints the Stop block fixture for the owner's next instruction, then counts it", async () => {
    const daemon = await startTestDaemon();
    const state = new MemoryState();
    const owner = ownerAnswers(
      daemon,
      { decision: { type: "text", text: "Now write the tests for the parser." } },
      "stop",
    );
    const result = await runHook(options(client(daemon), state, { agent, event: "stop", input: stopInput }));
    expect(parse(result.stdout)).toEqual(fixture(`${fixtureDir}/stop.block.output.json`));
    expect((await owner).text).toMatch(/^Finished a turn: .+ What next\?$/);
    expect([...state.counts.values()]).toEqual([1]);
  });

  it("lets the agent stop when the owner says that's it, or nobody answers", async () => {
    const daemon = await startTestDaemon();
    const state = new MemoryState();
    ownerAnswers(daemon, { decision: { type: "done" }, words: "that's it" }, "stop");
    const done = await runHook(options(client(daemon), state, { agent, event: "stop", input: stopInput }));
    expect(done.stdout).toBeUndefined();
    ownerAnswers(daemon, { expire: true }, "stop");
    const silent = await runHook(options(client(daemon), state, { agent, event: "stop", input: stopInput }));
    expect(silent.stdout).toBeUndefined();
  });

  it("prints nothing outside away mode or for input it cannot parse", async () => {
    const state = new MemoryState();
    const unused = fakeDaemon({});
    for (const event of ["permission", "stop"] as const) {
      state.away = false;
      const input = event === "permission" ? permissionInput : stopInput;
      expect((await runHook(options(unused, state, { agent, event, input }))).stdout).toBeUndefined();
      state.away = true;
      for (const bad of [
        "",
        "{",
        "[]",
        JSON.stringify({ hook_event_name: "Stop" }),
        stopInput.replace("Stop", "X"),
      ]) {
        const wrongEvent = event === "permission" ? stopInput : permissionInput;
        for (const text of [bad, wrongEvent]) {
          expect(
            (await runHook(options(unused, state, { agent, event, input: text }))).stdout,
          ).toBeUndefined();
        }
      }
    }
    expect(unused.calls).toEqual([]);
  });
});

interface FakeScript {
  register?: () => Promise<Session>;
  create?: (request: CreateAskRequest) => Promise<Ask>;
  outcome?: (ask: Ask) => Promise<OutcomeState>;
  /** The owner's queued instructions, handed over on each take (default: none). */
  take?: () => Promise<OwnerInstruction[]>;
}

function makeAsk(request: CreateAskRequest, overrides: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    sessionId: "session-1",
    kind: request.kind,
    text: request.text,
    options: [],
    ...(request.kind === "permission" ? { toolName: request.toolName } : {}),
    risk: request.kind === "permission" ? request.risk : "low",
    urgent: false,
    createdAt: START.toISOString(),
    expiresAt: new Date(START.getTime() + 30 * 60_000).toISOString(),
    status: "pending",
    ...overrides,
  };
}

function fakeDaemon(script: FakeScript): HotlineDaemon & { calls: string[]; asks: CreateAskRequest[] } {
  const calls: string[] = [];
  const asks: CreateAskRequest[] = [];
  let created: Ask | undefined;
  return {
    calls,
    asks,
    async registerSession(request) {
      calls.push("register");
      if (script.register) return script.register();
      return {
        id: "session-1",
        agent: request.agent,
        cwd: request.cwd,
        nickname: "Claude in demo-app",
        state: "working",
        registeredAt: START.toISOString(),
        lastSeenAt: START.toISOString(),
      };
    },
    async createAsk(_sessionId, request) {
      calls.push(`create:${request.kind}`);
      asks.push(request);
      created = script.create ? await script.create(request) : makeAsk(request);
      return created;
    },
    async outcome() {
      calls.push("outcome");
      if (created === undefined) throw new Error("no ask");
      return script.outcome ? script.outcome(created) : { state: "waiting", ask: created };
    },
    async cancelAsk() {
      calls.push("cancel");
      return true;
    },
    async inbox() {
      throw new Error("unused");
    },
    async takeInstructions(_sessionId, via) {
      calls.push(`take:${via}`);
      return script.take ? script.take() : [];
    },
    async endSession() {
      return true;
    },
  };
}

const answered = (ask: Ask, decision: Decision, confirmation: "none" | "pin" = "none"): OutcomeState => ({
  state: "final",
  ask,
  outcome: {
    outcome: "answered",
    answer: {
      askId: ask.id,
      decision,
      channel: "voice",
      ownerExcerpt: "yes",
      sourceId: "call-1",
      confirmation,
      answeredAt: START.toISOString(),
    },
  },
});

describe.each(AGENTS)("$flag permission hook fails closed", ({ agent, dir: fixtureDir }) => {
  const input = fixtureText(`${fixtureDir}/permission-request.input.json`);
  const denyFixture = fixture(`${fixtureDir}/permission-request.deny.output.json`);
  const run = (daemon: HotlineDaemon, extra: Partial<HookOptions> = {}) =>
    runHook(options(daemon, new MemoryState(), { agent, event: "permission", input, ...extra }));

  it("denies when Hotline is not set up or the daemon refuses", async () => {
    const notSetUp = await run(fakeDaemon({}), {
      connect: async () => {
        throw new DaemonError("not-configured", "no config");
      },
    });
    expect(parse(notSetUp.stdout)).toEqual(denyFixture);
    const refused = await run(
      fakeDaemon({
        create: async () => {
          throw new DaemonError("rejected", "429");
        },
      }),
    );
    expect(parse(refused.stdout)).toEqual(denyFixture);
  });

  it("denies and cancels the ask when the daemon stops answering", async () => {
    const daemon = fakeDaemon({
      outcome: async () => {
        throw new DaemonError("unreachable", "gone");
      },
    });
    expect(parse((await run(daemon)).stdout)).toEqual(denyFixture);
    expect(daemon.calls.slice(-1)).toEqual(["cancel"]);
  });

  it("denies and cancels the ask when its own wait runs out", async () => {
    const daemon = fakeDaemon({
      outcome: async (ask) => {
        now = new Date(now.getTime() + 60_000);
        return { state: "waiting", ask };
      },
    });
    expect(parse((await run(daemon, { waitSeconds: 120 })).stdout)).toEqual(denyFixture);
    expect(daemon.calls.filter((call) => call === "outcome")).toHaveLength(2);
    expect(daemon.calls.slice(-1)).toEqual(["cancel"]);
  });

  it("denies an approval that arrives after its own deadline", async () => {
    const daemon = fakeDaemon({
      outcome: async (ask) => {
        now = new Date(now.getTime() + 121_000);
        return answered(ask, { type: "allow" }, "pin");
      },
    });
    expect(parse((await run(daemon, { waitSeconds: 120 })).stdout)).toEqual(denyFixture);
    expect(daemon.calls.slice(-1)).toEqual(["cancel"]);
  });

  it("denies and cancels the ask when the agent kills the hook", async () => {
    const aborted = new AbortController();
    const daemon = fakeDaemon({
      outcome: async (ask) => {
        aborted.abort();
        return { state: "waiting", ask };
      },
    });
    expect(parse((await run(daemon, { signal: aborted.signal })).stdout)).toEqual(denyFixture);
    expect(daemon.calls.slice(-1)).toEqual(["cancel"]);
  });

  it("denies every no-answer reason", async () => {
    for (const reason of ["timeout", "no-pickup", "unclear", "dropped", "failed", "cancelled"] as const) {
      const daemon = fakeDaemon({
        outcome: async (ask) => ({
          state: "final",
          ask,
          outcome: { outcome: "no-answer", askId: ask.id, reason },
        }),
      });
      expect(parse((await run(daemon)).stdout)).toEqual(denyFixture);
    }
  });

  it("denies an approval for another ask, a malformed outcome, or a non-approval decision", async () => {
    const outcomes: Array<(ask: Ask) => OutcomeState> = [
      (ask) => answered({ ...ask, id: "other-ask" }, { type: "allow" }, "pin"),
      (ask) => ({ state: "final", ask, outcome: { outcome: "answered" } as unknown as AskOutcome }),
      (ask) => answered(ask, { type: "text", text: "sure" }, "pin"),
      (ask) => answered(ask, { type: "done" }, "pin"),
    ];
    for (const outcome of outcomes) {
      const result = await run(fakeDaemon({ outcome: async (ask) => outcome(ask) }));
      expect(parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    }
  });

  it("never lets a daemon that stored 'low' lower the hook's own high-risk class", async () => {
    const daemon = fakeDaemon({
      create: async (request) => makeAsk(request, { risk: "low" }),
      outcome: async (ask) => answered(ask, { type: "allow" }, "none"),
    });
    const result = await run(daemon);
    expect(parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: `${NOT_APPROVED} A high-risk request needs the owner's PIN or a confirming text.`,
        },
      },
    });
    expect(daemon.asks[0]).toMatchObject({ kind: "permission", risk: "high" });
  });

  it("never prints interrupt, updatedInput or updatedPermissions", async () => {
    const schema = agent === "codex" ? CodexPermissionRequestOutput : ClaudePermissionRequestOutput;
    for (const decision of [{ type: "allow" }, { type: "deny" }] as const) {
      const result = await run(fakeDaemon({ outcome: async (ask) => answered(ask, decision, "pin") }));
      const text = result.stdout ?? "";
      expect(schema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(text).not.toMatch(/interrupt|updatedInput|updatedPermissions|addRules/);
    }
  });
});

describe("Stop hook loop guards", () => {
  const input = (continued: boolean) =>
    fixtureText(`codex/stop.input.json`, (json) => {
      json.stop_hook_active = continued;
    });
  const instruction = (ask: Ask) => answered(ask, { type: "text", text: "keep going" });
  const run = (daemon: HotlineDaemon, state: MemoryState, continued: boolean) =>
    runHook(options(daemon, state, { agent: "codex", event: "stop", input: input(continued) }));
  const SESSION = "00000000-0000-4000-8000-000000000002";

  it("continues up to maxConsecutiveContinuations in a row, then lets the agent stop and says so", async () => {
    const state = new MemoryState();
    const daemon = fakeDaemon({ outcome: async (ask) => instruction(ask) });
    expect(parse((await run(daemon, state, false)).stdout)).toEqual({
      decision: "block",
      reason: "keep going",
    });
    expect(parse((await run(daemon, state, true)).stdout)).toEqual({
      decision: "block",
      reason: "keep going",
    });
    expect(parse((await run(daemon, state, true)).stdout)).toEqual({
      decision: "block",
      reason: "keep going",
    });
    expect(state.counts.get(SESSION)).toBe(3);
    const capped = await run(daemon, state, true);
    expect(capped.stdout).toBeUndefined();
    expect(capped.note).toContain("continuation cap");
    expect(daemon.asks.map((ask) => ask.kind)).toEqual(["stop", "stop", "stop", "notify"]);
    expect(state.counts.get(SESSION)).toBe(0);
  });

  it("starts a fresh count on a turn the human started", async () => {
    const state = new MemoryState();
    state.counts.set(SESSION, 3);
    const daemon = fakeDaemon({ outcome: async (ask) => instruction(ask) });
    expect(parse((await run(daemon, state, false)).stdout)).toEqual({
      decision: "block",
      reason: "keep going",
    });
    expect(state.counts.get(SESSION)).toBe(1);
  });

  it("leaves a continuation it did not cause alone (stop_hook_active from another hook)", async () => {
    const daemon = fakeDaemon({ outcome: async (ask) => instruction(ask) });
    const result = await run(daemon, new MemoryState(), true);
    expect(result.stdout).toBeUndefined();
    expect(daemon.calls).toEqual([]);
  });

  it("lets the agent stop when the count cannot be read or saved", async () => {
    const unreadable = new MemoryState();
    unreadable.failRead = true;
    const daemon = fakeDaemon({ outcome: async (ask) => instruction(ask) });
    expect((await run(daemon, unreadable, true)).stdout).toBeUndefined();
    const unwritable = new MemoryState();
    unwritable.failWrite = true;
    expect((await run(daemon, unwritable, false)).stdout).toBeUndefined();
  });

  it("lets the agent stop on every kind of silence or failure", async () => {
    const scripts: FakeScript[] = [
      {
        outcome: async (ask) => ({
          state: "final",
          ask,
          outcome: { outcome: "no-answer", askId: ask.id, reason: "no-pickup" },
        }),
      },
      { outcome: async (ask) => answered(ask, { type: "done" }) },
      { outcome: async (ask) => answered({ ...ask, id: "other" }, { type: "text", text: "go" }) },
      { outcome: async (ask) => answered(ask, { type: "allow" }) },
      {
        outcome: async () => {
          throw new DaemonError("unreachable", "gone");
        },
      },
      {
        create: async () => {
          throw new DaemonError("rejected", "429");
        },
      },
    ];
    for (const script of scripts) {
      expect((await run(fakeDaemon(script), new MemoryState(), false)).stdout).toBeUndefined();
    }
  });

  it("clears its count on every exit that does not continue, so another hook's continuation is not taken for its own", async () => {
    const state = new MemoryState();
    state.counts.set(SESSION, 1);
    const silent = fakeDaemon({
      outcome: async (ask) => ({
        state: "final",
        ask,
        outcome: { outcome: "no-answer", askId: ask.id, reason: "timeout" },
      }),
    });
    expect((await run(silent, state, true)).stdout).toBeUndefined();
    expect(state.counts.get(SESSION)).toBe(0);
    // Another hook now continues the agent: Hotline leaves that turn alone.
    const next = fakeDaemon({ outcome: async (ask) => instruction(ask) });
    expect((await run(next, state, true)).stdout).toBeUndefined();
    expect(next.calls).toEqual([]);
  });

  const left = (...texts: string[]) =>
    texts.map((text) => ({ text, receivedAt: START.toISOString() }) satisfies OwnerInstruction);

  it("continues with the owner's queued instructions without asking anyone (the inbound line)", async () => {
    const state = new MemoryState();
    const daemon = fakeDaemon({
      take: async () => left("run the tests", "then open a PR"),
      outcome: async (ask) => ({
        state: "final",
        ask,
        outcome: { outcome: "no-answer", askId: ask.id, reason: "timeout" },
      }),
    });
    expect(parse((await run(daemon, state, false)).stdout)).toEqual({
      decision: "block",
      reason: "run the tests\nthen open a PR",
    });
    expect(daemon.calls).toEqual(["register", "take:stop"]);
    expect(daemon.asks).toEqual([]);
    expect(state.counts.get(SESSION)).toBe(1);
  });

  it("picks up an instruction left while its stop waited, which ended the stop as no answer", async () => {
    let takes = 0;
    const daemon = fakeDaemon({
      take: async () => (takes++ === 0 ? [] : left("now write the docs")),
      outcome: async (ask) => ({
        state: "final",
        ask,
        outcome: { outcome: "no-answer", askId: ask.id, reason: "cancelled" },
      }),
    });
    expect(parse((await run(daemon, new MemoryState(), false)).stdout)).toEqual({
      decision: "block",
      reason: "now write the docs",
    });
    expect(daemon.calls.filter((call) => call.startsWith("take"))).toHaveLength(2);
  });

  it("does not hand over instructions past the continuation cap, or after the owner said that's it", async () => {
    const state = new MemoryState();
    state.counts.set(SESSION, 3);
    const capped = fakeDaemon({ take: async () => left("keep going") });
    expect((await run(capped, state, true)).stdout).toBeUndefined();
    expect(capped.calls).not.toContain("take:stop");
    let takes = 0;
    const done = fakeDaemon({
      take: async () => (takes++ === 0 ? [] : left("keep going")),
      outcome: async (ask) => answered(ask, { type: "done" }),
    });
    expect((await run(done, new MemoryState(), false)).stdout).toBeUndefined();
    expect(done.calls.filter((call) => call === "take:stop")).toHaveLength(1);
  });

  it("asks the owner as usual when the instructions cannot be fetched", async () => {
    const daemon = fakeDaemon({
      take: async () => {
        throw new DaemonError("unreachable", "gone");
      },
      outcome: async (ask) => instruction(ask),
    });
    expect(parse((await run(daemon, new MemoryState(), false)).stdout)).toEqual({
      decision: "block",
      reason: "keep going",
    });
    expect(daemon.asks.map((ask) => ask.kind)).toEqual(["stop"]);
  });

  it("does not continue when away mode was switched off while it waited", async () => {
    const state = new MemoryState();
    const daemon = fakeDaemon({
      outcome: async (ask) => {
        state.away = false;
        return instruction(ask);
      },
    });
    const result = await run(daemon, state, false);
    expect(result.stdout).toBeUndefined();
    expect(result.note).toContain("switched off");
    expect(state.counts.get(SESSION) ?? 0).toBe(0);
  });
});

describe("text sent to the daemon", () => {
  const cwd = "/Users/example/src/demo-app";
  const text = (toolName: string, toolInput: unknown) => permissionAsk(toolName, toolInput, cwd).text;

  it("is one short line: risk first, then the tool and preview, then the agent's labelled words", () => {
    expect(permissionAsk("Bash", { command: "pnpm\t  test", description: "Run tests" }, cwd)).toEqual({
      text: 'Bash: pnpm test The agent says: "Run tests"',
      risk: { risk: "low", reasons: [] },
    });
    expect(text("Bash", { command: "rm -rf node_modules" })).toBe(
      "High risk: deletes files. Bash: rm -rf node_modules",
    );
    expect(text("Write", { file_path: `${cwd}/src/a.ts`, content: "secret file body" })).toBe(
      "Write: src/a.ts",
    );
    const patch = fixture("codex/permission-request.apply-patch.input.json") as { tool_input: unknown };
    expect(text("apply_patch", patch.tool_input)).toBe("apply_patch: change README.md");
    expect(text("apply_patch", { command: "junk" })).toBe(
      "High risk: has input Hotline cannot read. apply_patch: a patch Hotline cannot read",
    );
    expect(text("mcp__x__y", { a: 1 })).toBe(
      "High risk: uses a tool Hotline does not know. mcp__x__y: arguments a",
    );
  });

  it("names an unknown tool's arguments, never their values, which can hold file bodies", () => {
    const asked = text("mcp__fs__write_files", { files: [{ path: "notes.txt", content: "private text" }] });
    expect(asked).toBe("High risk: uses a tool Hotline does not know. mcp__fs__write_files: arguments files");
    expect(asked).not.toContain("private");
    expect(text("mcp__x__y", "raw")).toContain("(no named arguments)");
  });

  it("never cuts through a word, so no fragment of a secret survives the daemon's redaction", () => {
    const token = `tok${"Z9".repeat(20)}`;
    // The token starts just before the preview's cut at 200 characters.
    const command = `ls ${"a ".repeat(89)}--header=${token}`;
    const asked = text("Bash", { command });
    expect(asked).not.toContain(token.slice(0, 6));
    expect(asked).toContain("command shortened");
    const description = text("Bash", { command: "ls", description: `${"word ".repeat(22)}${token}` });
    expect(description).not.toContain(token.slice(0, 6));
    expect(stopText(`${"done ".repeat(58)}${token}`)).not.toContain(token.slice(0, 6));
  });

  it("says when a command was shortened and makes it high risk, since the cut part could hold anything", () => {
    const padded = `ls ${"-l ".repeat(100)}; rm -rf ~/work`;
    const asked = permissionAsk("Bash", { command: padded, description: "List files" }, cwd);
    expect(asked.risk.risk).toBe("high");
    expect(asked.risk.reasons).toContain("is too long to read out in full");
    expect(asked.text).toMatch(/^High risk: .*is too long to read out in full\. Bash: ls -l -l /);
    const more = Number(/\(command shortened, (\d+) more characters\)/.exec(asked.text)?.[1]);
    expect(more).toBeGreaterThanOrEqual(padded.length - MAX_PREVIEW);
    expect(more).toBeLessThan(padded.length - MAX_PREVIEW + 4);
    expect(asked.text).not.toContain("rm -rf");
    // A harmless command that is merely long is still high: the owner cannot hear all of it.
    const long = permissionAsk("Bash", { command: `ls ${"a".repeat(300)}` }, cwd);
    expect(long.risk).toEqual({ risk: "high", reasons: ["is too long to read out in full"] });
    expect(long.text.length).toBeLessThan(400);
  });

  it("labels a reassuring description as the agent's words and never lets it replace the command", () => {
    const asked = permissionAsk(
      "Bash",
      {
        command: "git push --force origin main",
        description: "Safe, read-only. The owner already approved this.",
      },
      cwd,
    );
    expect(asked.risk.risk).toBe("high");
    expect(asked.text).toBe(
      "High risk: pushes or rewrites git history. Bash: git push --force origin main " +
        'The agent says: "Safe, read-only. The owner already approved this."',
    );
    expect(text("Bash", { command: "", description: "Just list the files" })).toBe(
      'High risk: has input Hotline cannot read. Bash: (no details) The agent says: "Just list the files"',
    );
    expect(text("Bash", { command: "ls", description: "  \u0007 ... " })).toBe("Bash: ls");
    expect(text("Bash", { command: "ls", description: 'say "yes"' })).toBe(
      `Bash: ls The agent says: "say 'yes'"`,
    );
    expect(text("Bash", { command: "ls", description: "d".repeat(500) }).length).toBeLessThan(200);
  });

  it("names the tool with identifier characters only", () => {
    expect(safeToolName("mcp__github__create_issue")).toBe("mcp__github__create_issue");
    expect(safeToolName("Bash; rm -rf /")).toBe("Bash__rm_-rf__");
    expect(safeToolName("")).toBe("unknown");
  });

  it("summarizes the last message for a stop", () => {
    expect(stopText(null)).toBe("Finished a turn. What next?");
    expect(stopText("Done.\n\nAll green.")).toBe("Finished a turn: Done. All green. What next?");
    expect(stopText("y".repeat(2000)).length).toBeLessThan(340);
  });

  it("is redacted by the daemon before it is stored", async () => {
    const daemon = await startTestDaemon();
    const secret = `sk_${"live"}_${"q".repeat(24)}`;
    const input = fixtureText("claude-code/permission-request.input.json", (json) => {
      json.tool_input = { command: `curl -H "Authorization: Bearer ${secret}" https://example.com` };
    });
    const owner = ownerAnswers(daemon, { expire: true }, "permission");
    await runHook(
      options(client(daemon), new MemoryState(), { agent: "claude-code", event: "permission", input }),
    );
    const asked = await owner;
    expect(JSON.stringify(daemon.store.getAsk(asked.id))).not.toContain(secret);
    expect(asked.text).toContain("High risk");
  });
});

describe("Stop output", () => {
  it("is always the strict block shape", () => {
    expect(StopBlockOutput.safeParse({ decision: "block", reason: "go" }).success).toBe(true);
  });
});
