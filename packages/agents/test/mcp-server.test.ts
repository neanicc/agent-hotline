// The MCP server, driven through the MCP SDK's own client against a real daemon
// on 127.0.0.1 (temporary store, fake clock). The owner's answers are recorded
// through the store's `recordAnswer`, the daemon's resolution path, exactly as a
// verified webhook will in HL-09.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Ask, AskOutcome, Session } from "@hotline/core";
import {
  createRedactor,
  type Daemon,
  endSession,
  generateApiToken,
  openStore,
  startDaemon,
} from "@hotline/daemon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AskHumanResult,
  askHumanResult,
  type CreateAskRequest,
  createHotlineMcpServer,
  DaemonClient,
  DaemonError,
  type HotlineDaemon,
  type HotlineMcpOptions,
  type Inbox,
  type OutcomeState,
  type OwnerInstruction,
} from "../src/index.js";

const START = new Date("2026-10-13T21:00:00.000Z");
const TIMEOUT_MINUTES = 30;

let dir: string;
let token: string;
let now: Date;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-mcp-"));
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
    askTimeoutMinutes: TIMEOUT_MINUTES,
  });
  cleanups.push(() => started.close());
  return started;
}

function clientFor(port: number, apiToken = token): DaemonClient {
  return new DaemonClient({ connection: async () => ({ port, token: apiToken }), requestTimeoutMs: 2_000 });
}

interface Connected {
  mcp: Client;
  settled: () => Promise<void>;
  end: () => Promise<void>;
}

async function connect(
  hotlineDaemon: HotlineDaemon,
  overrides: Partial<HotlineMcpOptions> = {},
  clientName = "test-client",
): Promise<Connected> {
  const hotline = createHotlineMcpServer({
    daemon: hotlineDaemon,
    agent: "claude-code",
    cwd: "/work/demo-app",
    agentSessionId: "cc-session-1",
    version: "0.0.0-test",
    clock: () => now,
    progressIntervalMs: 20,
    pollSeconds: 1,
    retryDelaysMs: [10, 10],
    ...overrides,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await hotline.server.connect(serverSide);
  const mcp = new Client({ name: clientName, version: "1.0.0" });
  await mcp.connect(clientSide);
  cleanups.push(() => mcp.close());
  return { mcp, settled: () => hotline.settled(), end: () => hotline.end() };
}

async function waitFor<T>(probe: () => T | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function resultJson(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

const pendingAsk = (running: Daemon) =>
  waitFor(() => running.store.listAsks(["pending"])[0], "the ask to reach the daemon");

function ownerAnswer(askId: string, overrides: Partial<Answer> = {}): Answer {
  return {
    askId,
    decision: { type: "option", option: 2 },
    channel: "voice",
    ownerExcerpt: "Blue, go with blue",
    sourceId: "conversation-1",
    confirmation: "none",
    answeredAt: new Date(now.getTime() + 1_000).toISOString(),
    ...overrides,
  };
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("hotline MCP server", () => {
  it("lists ask_human, notify_human and check_inbox with bounded input schemas", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["ask_human", "check_inbox", "notify_human"]);
    const askHuman = tools.find((tool) => tool.name === "ask_human");
    expect(askHuman?.inputSchema.required).toEqual(["question"]);
    expect(askHuman?.inputSchema.properties).toMatchObject({
      question: { type: "string", maxLength: 500 },
      options: { type: "array", maxItems: 9 },
    });
    expect(askHuman?.description).toContain("never approval");
  });

  it("registers its session with the daemon once the client is initialized", async () => {
    const running = await startTestDaemon();
    await connect(clientFor(running.apiPort));
    const session = await waitFor(() => running.store.listSessions()[0], "the session");
    expect(session).toMatchObject({
      agent: "claude-code",
      agentSessionId: "cc-session-1",
      cwd: "/work/demo-app",
      nickname: "Claude in demo-app",
      state: "working",
    });
  });

  it.each([
    ["claude-code", "claude-code"],
    ["codex-mcp-client", "codex"],
  ] as const)("guesses the agent from the client name %s", async (clientName, agent) => {
    const running = await startTestDaemon();
    await connect(clientFor(running.apiPort), { agent: undefined }, clientName);
    const session = await waitFor(() => running.store.listSessions()[0], "the session");
    expect(session.agent).toBe(agent);
  });

  it("asks nobody when the agent is unknown, and says there was no answer", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort), { agent: undefined }, "some-editor");
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }));
    expect(result).toMatchObject({ outcome: "no-answer", reason: "failed" });
    expect(running.store.listSessions()).toEqual([]);
    expect(running.store.listAsks()).toEqual([]);
  });

  it("relays the owner's choice with their words, sending progress while it waits", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const progress: Progress[] = [];
    const call = mcp.callTool(
      {
        name: "ask_human",
        arguments: {
          question: "Which color for the button?",
          options: ["Red", "Blue"],
          context: "Styling the signup page.",
        },
      },
      undefined,
      { onprogress: (update) => progress.push(update), resetTimeoutOnProgress: true },
    );
    const ask = await pendingAsk(running);
    expect(ask.text).toBe("Which color for the button?\n\nContext: Styling the signup page.");
    expect(ask.options).toEqual(["Red", "Blue"]);
    expect(running.store.getSession(ask.sessionId)?.state).toBe("waiting-on-human");
    await waitFor(() => progress.length >= 2, "two progress notifications");

    running.store.recordAnswer(ownerAnswer(ask.id), now);
    const result = resultJson(await call);
    expect(result).toEqual({
      outcome: "answered",
      askId: ask.id,
      ownerWords: "Blue, go with blue",
      channel: "voice",
      choice: { option: 2, text: "Blue" },
    });
    expect(progress[1]?.progress).toBeGreaterThan(progress[0]?.progress ?? Number.POSITIVE_INFINITY);
    expect(progress[0]?.message).toContain("Waiting for the human");
  });

  it("relays a free-text answer", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const call = mcp.callTool({
      name: "ask_human",
      arguments: { question: "What should the table be called?" },
    });
    const ask = await pendingAsk(running);
    running.store.recordAnswer(
      ownerAnswer(ask.id, { decision: { type: "text", text: "call it members" }, channel: "sms" }),
      now,
    );
    expect(resultJson(await call)).toMatchObject({
      outcome: "answered",
      answer: "call it members",
      channel: "sms",
    });
  });

  it("returns no answer when the ask times out, and a late answer changes nothing", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const call = mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } });
    const ask = await pendingAsk(running);
    now = new Date(START.getTime() + TIMEOUT_MINUTES * 60_000);
    const result = resultJson(await call);
    expect(result).toMatchObject({ outcome: "no-answer", askId: ask.id, reason: "timeout" });
    expect(result.note).toContain("not approval");
    expect(() => running.store.recordAnswer(ownerAnswer(ask.id), now)).toThrow();
  });

  it("returns no answer at once when the daemon is not running", async () => {
    const port = await closedPort();
    const { mcp } = await connect(clientFor(port));
    const startedAt = Date.now();
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }));
    expect(result).toMatchObject({ outcome: "no-answer", reason: "failed" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("returns no answer when the daemon refuses the token", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort, "not-the-token"));
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }));
    expect(result).toMatchObject({ outcome: "no-answer", reason: "failed" });
    expect(running.store.listAsks()).toEqual([]);
  });

  it("returns no answer when the daemon goes away mid-wait", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const call = mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } });
    const ask = await pendingAsk(running);
    await running.close();
    expect(resultJson(await call)).toMatchObject({ outcome: "no-answer", askId: ask.id, reason: "failed" });
  });

  it("cancels the ask on the daemon when the agent cancels the call", async () => {
    const running = await startTestDaemon();
    const { mcp, settled } = await connect(clientFor(running.apiPort));
    const abort = new AbortController();
    const call = mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }, undefined, {
      signal: abort.signal,
    });
    const ask = await pendingAsk(running);
    abort.abort();
    await expect(call).rejects.toThrow();
    await settled();
    expect(running.store.getAsk(ask.id)?.status).toBe("cancelled");
    expect(running.store.getSession(ask.sessionId)?.state).toBe("working");
  });

  it("cancels a waiting ask when the client disconnects", async () => {
    const running = await startTestDaemon();
    const { mcp, settled } = await connect(clientFor(running.apiPort));
    void mcp.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }).catch(() => {});
    const ask = await pendingAsk(running);
    await mcp.close();
    await settled();
    expect(running.store.getAsk(ask.id)?.status).toBe("cancelled");
  });

  it("marks its session ended once the client has gone", async () => {
    const running = await startTestDaemon();
    const { mcp, end } = await connect(clientFor(running.apiPort));
    await mcp.callTool({ name: "notify_human", arguments: { message: "Done." } });
    const session = await waitFor(() => running.store.listSessions()[0], "the session");
    await mcp.close();
    await end();
    expect(running.store.getSession(session.id)?.state).toBe("ended");
    expect(running.store.listAsks(["pending"])).toEqual([]);
  });

  it("forwards nothing secret: the daemon redacts the question before storing it", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    // Built at runtime, so no secret scanner mistakes the fixture for a real token.
    const secret = `ghp_${"a1".repeat(18)}`;
    void mcp
      .callTool({ name: "ask_human", arguments: { question: `Push with ${secret} to +15555550100?` } })
      .catch(() => {});
    const ask = await pendingAsk(running);
    expect(ask.text).not.toContain(secret);
    expect(ask.text).not.toContain("5555550100");
    expect(ask.text).toContain("[REDACTED]");
  });

  it("rejects too many options, duplicate options and blank questions without asking", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const tooMany = await mcp.callTool({
      name: "ask_human",
      arguments: { question: "Pick", options: Array.from({ length: 10 }, (_, i) => `o${i}`) },
    });
    expect(tooMany.isError).toBe(true);
    const duplicate = await mcp.callTool({
      name: "ask_human",
      arguments: { question: "Pick", options: ["a", "a"] },
    });
    expect(duplicate.isError).toBe(true);
    const blank = await mcp.callTool({ name: "ask_human", arguments: { question: "\u0007 \u0000" } });
    expect(blank.isError).toBe(true);
    expect(running.store.listAsks()).toEqual([]);
  });

  it("queues a notification without waiting for a reply", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const result = await mcp.callTool({
      name: "notify_human",
      arguments: { message: "The migration finished." },
    });
    expect(result.isError).toBeUndefined();
    const body = resultJson(result);
    expect(body).toMatchObject({ queued: true });
    expect(running.store.getAsk(String(body.askId))).toMatchObject({
      kind: "notify",
      text: "The migration finished.",
    });
  });

  it("returns no answer once the session has too many open questions", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    for (let i = 0; i < 3; i++) {
      void mcp.callTool({ name: "ask_human", arguments: { question: `Question ${i}?` } }).catch(() => {});
    }
    await waitFor(() => running.store.listAsks(["pending"]).length === 3, "three open questions");
    const result = resultJson(
      await mcp.callTool({ name: "ask_human", arguments: { question: "One more?" } }),
    );
    expect(result).toMatchObject({ outcome: "no-answer", reason: "failed" });
    expect(running.store.listAsks()).toHaveLength(3);
  });

  it("reports a notification it could not deliver to the daemon as an error", async () => {
    const { mcp } = await connect(clientFor(await closedPort()));
    const result = await mcp.callTool({ name: "notify_human", arguments: { message: "Done." } });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ queued: false });
  });

  it("shows instructions and recent asks with their results in the inbox", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const call = mcp.callTool({
      name: "ask_human",
      arguments: { question: "Color?", options: ["Red", "Blue"] },
    });
    const ask = await pendingAsk(running);
    running.store.recordAnswer(ownerAnswer(ask.id), now);
    await call;
    const inbox = resultJson(await mcp.callTool({ name: "check_inbox", arguments: {} }));
    expect(inbox).toMatchObject({
      session: { nickname: "Claude in demo-app", state: "working" },
      instructions: [],
      asks: [{ askId: ask.id, kind: "question", status: "answered", result: { outcome: "answered" } }],
    });
  });

  it("hands the owner's queued instructions to the next ask_human result, and only once", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const session = await waitFor(() => running.store.listSessions()[0], "the session");
    // What the inbound line stores once the post-call transcript confirmed it.
    running.store.addInstruction({
      id: "instruction-1",
      sessionId: session.id,
      text: "use the blue theme everywhere",
      ownerExcerpt: "session one, use the blue theme everywhere",
      sourceId: "conversation-9",
      channel: "voice",
      receivedAt: now.toISOString(),
      status: "queued",
    });
    const call = mcp.callTool({
      name: "ask_human",
      arguments: { question: "Color?", options: ["Red", "Blue"] },
    });
    const ask = await pendingAsk(running);
    running.store.recordAnswer(ownerAnswer(ask.id), now);
    const result = resultJson(await call);
    expect(result).toMatchObject({
      outcome: "answered",
      choice: { option: 2, text: "Blue" },
      instructions: [{ text: "use the blue theme everywhere", receivedAt: now.toISOString() }],
    });
    expect(running.store.listInstructions()[0]).toMatchObject({ status: "delivered", deliveredVia: "ask" });
    const inbox = resultJson(await mcp.callTool({ name: "check_inbox", arguments: {} }));
    expect(inbox.instructions).toEqual([]);
  });

  it("still returns the answer when the instructions cannot be fetched", async () => {
    // ScriptedDaemon's takeInstructions always fails.
    const scripted = new ScriptedDaemon((ask) => answered(ask.id, { type: "text", text: "ship it" }));
    const { mcp } = await connect(scripted);
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Go?" } }));
    expect(result).toMatchObject({ outcome: "answered", answer: "ship it" });
    expect(result).not.toHaveProperty("instructions");
  });

  it("registers again when the daemon ended its idle session, so check_inbox keeps working", async () => {
    const running = await startTestDaemon();
    const { mcp } = await connect(clientFor(running.apiPort));
    const first = await waitFor(() => running.store.listSessions()[0], "the session");
    // What the daemon does to a session nobody heard from for six hours.
    endSession(running.store, first.id, now, "idle");
    const inbox = await mcp.callTool({ name: "check_inbox", arguments: {} });
    expect(inbox.isError).toBeUndefined();
    const live = running.store.listSessions().filter((s) => s.state !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(first.id);
  });

  it("reports an unreachable inbox as an error", async () => {
    const { mcp } = await connect(clientFor(await closedPort()));
    const result = await mcp.callTool({ name: "check_inbox", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

// A scripted daemon, for responses the real one never gives.
class ScriptedDaemon implements HotlineDaemon {
  registrations = 0;
  asks: Ask[] = [];
  cancelled: string[] = [];
  createFailures: DaemonError[] = [];
  constructor(private readonly final: (ask: Ask) => AskOutcome) {}

  async registerSession(): Promise<Session> {
    this.registrations += 1;
    return {
      id: `session-${this.registrations}`,
      agent: "claude-code",
      cwd: "/work",
      nickname: "Claude in work",
      state: "working",
      registeredAt: START.toISOString(),
      lastSeenAt: START.toISOString(),
    };
  }

  async createAsk(sessionId: string, request: CreateAskRequest): Promise<Ask> {
    const failure = this.createFailures.shift();
    if (failure !== undefined) throw failure;
    const ask: Ask = {
      id: `ask-${this.asks.length + 1}`,
      sessionId,
      kind: request.kind,
      text: request.text,
      options: request.options ?? [],
      risk: "low",
      urgent: false,
      createdAt: START.toISOString(),
      expiresAt: new Date(START.getTime() + 60_000).toISOString(),
      status: "pending",
    };
    this.asks.push(ask);
    return ask;
  }

  async outcome(askId: string): Promise<OutcomeState> {
    const ask = this.asks.find((candidate) => candidate.id === askId);
    if (ask === undefined) throw new DaemonError("not-found", "unknown");
    return { state: "final", ask, outcome: this.final(ask) };
  }

  async cancelAsk(askId: string): Promise<boolean> {
    this.cancelled.push(askId);
    return true;
  }

  async inbox(): Promise<Inbox> {
    throw new DaemonError("unreachable", "down");
  }

  async takeInstructions(): Promise<OwnerInstruction[]> {
    throw new DaemonError("unreachable", "down");
  }

  async endSession(): Promise<boolean> {
    return true;
  }
}

function answered(askId: string, decision: Answer["decision"]): AskOutcome {
  return { outcome: "answered", answer: { ...ownerAnswer(askId), decision } };
}

describe("relaying outcomes", () => {
  it.each([
    ["an answer for another ask", (ask: Ask) => answered(`${ask.id}-other`, { type: "option", option: 1 })],
    ["an approval", (ask: Ask) => answered(ask.id, { type: "allow" })],
    ["an option the question did not offer", (ask: Ask) => answered(ask.id, { type: "option", option: 3 })],
    ["a stop decision", (ask: Ask) => answered(ask.id, { type: "done" })],
    [
      "a no-answer for another ask",
      (ask: Ask): AskOutcome => ({ outcome: "no-answer", askId: `${ask.id}-other`, reason: "timeout" }),
    ],
  ])("turns %s into 'unclear', never an answer", async (_name, final) => {
    const scripted = new ScriptedDaemon(final);
    const { mcp } = await connect(scripted);
    const result = resultJson(
      await mcp.callTool({ name: "ask_human", arguments: { question: "Color?", options: ["Red", "Blue"] } }),
    ) as AskHumanResult;
    expect(result).toMatchObject({ outcome: "no-answer", askId: "ask-1", reason: "unclear" });
  });

  it("cancels the ask, best effort, when it gives up on an unreachable daemon", async () => {
    const scripted = new ScriptedDaemon(() => {
      throw new DaemonError("unreachable", "down");
    });
    const { mcp } = await connect(scripted);
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Go?" } }));
    expect(result).toMatchObject({ outcome: "no-answer", askId: "ask-1", reason: "failed" });
    expect(scripted.cancelled).toEqual(["ask-1"]);
  });

  it("registers again once when the daemon has forgotten the session", async () => {
    const scripted = new ScriptedDaemon((ask) => answered(ask.id, { type: "text", text: "yes" }));
    scripted.createFailures.push(new DaemonError("not-found", "unknown session"));
    const { mcp } = await connect(scripted);
    const result = resultJson(await mcp.callTool({ name: "ask_human", arguments: { question: "Go?" } }));
    expect(result).toMatchObject({ outcome: "answered", answer: "yes" });
    expect(scripted.asks[0]?.sessionId).toBe(`session-${scripted.registrations}`);
    expect(scripted.registrations).toBeGreaterThanOrEqual(2);
  });

  it("maps every decision a question can have", () => {
    const ask: Ask = {
      id: "a1",
      sessionId: "s1",
      kind: "question",
      text: "Color?",
      options: ["Red", "Blue"],
      risk: "low",
      urgent: false,
      createdAt: START.toISOString(),
      expiresAt: new Date(START.getTime() + 60_000).toISOString(),
      status: "answered",
    };
    expect(askHumanResult(ask, answered("a1", { type: "option", option: 1 }))).toMatchObject({
      outcome: "answered",
      choice: { option: 1, text: "Red" },
    });
    expect(askHumanResult(ask, { outcome: "no-answer", askId: "a1", reason: "no-pickup" })).toMatchObject({
      outcome: "no-answer",
      reason: "no-pickup",
    });
  });
});
