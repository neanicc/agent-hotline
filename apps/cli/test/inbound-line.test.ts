// The inbound line (HL-10) end to end: the real daemon (`runDaemon`: agent API,
// store, call orchestration, the ElevenLabs and Twilio routes) with a fake
// clock, the fake voice provider playing the owner (or a stranger) calling in
// through the real `/hooks/el/*` routes, FakeSmsProvider, and then the real hook
// adapter and MCP server picking the instruction up through the agent API.
// Nothing leaves 127.0.0.1; fake numbers only.
import { readFileSync } from "node:fs";
import {
  type CreateAskRequest,
  createHotlineMcpServer,
  DaemonClient,
  type HookState,
  runHook,
} from "@hotline/agents";
import { scriptedHuman } from "@hotline/providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Hotline,
  OWNER,
  PIN,
  STRANGER,
  startHotline,
} from "../../../packages/daemon/test/hotline-harness.js";

const fixtures = new URL("../../../packages/agents/test/fixtures/hooks/", import.meta.url);
const stopInput = (agent: "claude-code" | "codex") =>
  JSON.parse(readFileSync(new URL(`${agent}/stop.input.json`, fixtures), "utf8")) as {
    session_id: string;
    cwd: string;
  };
const BATCH_MS = 20_000;

let hotline: Hotline | undefined;
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  await hotline?.stop();
  hotline = undefined;
});

async function start(): Promise<Hotline> {
  // Each tool call moves the clock on a second, so the owner's turns after the PIN are timed after it.
  hotline = await startHotline({ toolStepMs: 1_000 });
  return hotline;
}

const clientFor = (h: Hotline) =>
  new DaemonClient({
    connection: async () => ({ port: h.daemon.apiPort, token: h.token }),
    requestTimeoutMs: 5_000,
  });

class AwayState implements HookState {
  counts = new Map<string, number>();
  async isAway() {
    return true;
  }
  async continuations(id: string) {
    return this.counts.get(id) ?? 0;
  }
  async setContinuations(id: string, count: number) {
    this.counts.set(id, count);
  }
}

function stopHook(h: Hotline, agent: "claude-code" | "codex", waitSeconds = 30) {
  return runHook({
    agent,
    event: "stop",
    input: JSON.stringify(stopInput(agent)),
    state: new AwayState(),
    connect: async () => ({ daemon: clientFor(h), maxConsecutiveContinuations: 3 }),
    clock: () => h.clock.now,
    waitSeconds,
    pollSeconds: 1,
    retryDelaysMs: [0],
  });
}

/** The session the agent's own hooks will use, registered as they register it. */
async function hookSession(h: Hotline, agent: "claude-code" | "codex"): Promise<string> {
  const { session_id: agentSessionId, cwd } = stopInput(agent);
  return (await clientFor(h).registerSession({ agent, cwd, agentSessionId })).id;
}

/** The owner calls in, gives the PIN, hears the status and gives `session` an instruction. */
function ownerInstructs(h: Hotline, session: number, instruction: string, words = instruction) {
  return h.voice.inboundCall(
    scriptedHuman.says(
      { kind: "pin", digits: PIN },
      { kind: "status" },
      { kind: "instruct", session, instruction, words },
    ),
  );
}

async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function resultJson(result: unknown): Record<string, unknown> {
  const first = (result as CallToolResult).content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function mcpFor(h: Hotline, agent: "claude-code" | "codex", cwd: string) {
  const server = createHotlineMcpServer({
    daemon: clientFor(h),
    agent,
    cwd,
    version: "0.0.0-test",
    clock: () => h.clock.now,
    progressIntervalMs: 60_000,
    pollSeconds: 1,
    retryDelaysMs: [10],
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const mcp = new Client({ name: "test-client", version: "1.0.0" });
  await mcp.connect(clientSide);
  cleanups.push(() => mcp.close());
  return mcp;
}

describe("the owner calls in", () => {
  it("PIN, then status, then an instruction delivered at the session's Stop hook without a call", async () => {
    const h = await start();
    const claude = await hookSession(h, "claude-code");
    const played = await ownerInstructs(h, 1, "run the tests", "Session one, run the tests");
    await h.settle();
    expect(played.tools.map((t) => [t.tool, t.response.result ?? t.response.verified])).toEqual([
      ["verify_pin", true],
      ["get_status", "ok"],
      ["send_instruction", "queued"],
    ]);
    const status = String(played.tools[1]?.response.status);
    expect(status).toContain("1 live session.");
    expect(status).toContain("Session 1, <agent_text>Claude in demo-app</agent_text>: working");
    // Confirmed against the owner's own turns after the PIN, and stored with them.
    const [queued] = h.daemon.store.listInstructions({ sessionId: claude });
    expect(queued).toMatchObject({
      status: "queued",
      text: "run the tests",
      ownerExcerpt: "Session one, run the tests",
      channel: "voice",
    });
    expect(h.daemon.store.listCalls()).toEqual([
      expect.objectContaining({ direction: "inbound", outcome: "answered", askIds: [] }),
    ]);

    const result = await stopHook(h, "claude-code");
    expect(JSON.parse(result.stdout ?? "{}")).toEqual({ decision: "block", reason: "run the tests" });
    // Nobody was phoned about the stop: the instruction was already there.
    expect(h.daemon.store.listAsks().filter((ask) => ask.kind === "stop")).toEqual([]);
    expect(h.voice.placed).toEqual([]);
    expect(h.daemon.store.listInstructions({ sessionId: claude })[0]).toMatchObject({
      status: "delivered",
      deliveredVia: "stop",
    });
    // Delivered once: the next stop finds nothing queued and asks the owner.
    const second = stopHook(h, "claude-code", 2);
    await waitFor(() => h.daemon.store.listAsks(["pending"]).find((a) => a.kind === "stop"), "a stop ask");
    // Nobody answers before the hook's wait (on the fake clock) runs out.
    h.clock.now = new Date(h.clock.now.getTime() + 3_000);
    expect((await second).stdout).toBeUndefined();
  });

  it("an instruction for a stop already waiting on the owner ends that stop and continues the agent", async () => {
    const h = await start();
    const claude = await hookSession(h, "claude-code");
    const waiting = stopHook(h, "claude-code");
    const stop = await waitFor(
      () => h.daemon.store.listAsks(["pending"]).find((ask) => ask.kind === "stop"),
      "the stop ask",
    );
    expect(stop.sessionId).toBe(claude);
    await ownerInstructs(h, 1, "now write the docs", "Tell session 1 to now write the docs");
    await h.settle();
    const result = await waiting;
    expect(JSON.parse(result.stdout ?? "{}")).toEqual({ decision: "block", reason: "now write the docs" });
    expect(h.daemon.store.getAsk(stop.id)?.status).toBe("cancelled");
    expect(h.voice.placed).toEqual([]);
  });

  it("delivers an instruction with the session's next ask_human result, and in check_inbox once", async () => {
    const h = await start();
    const mcp = await mcpFor(h, "codex", "/work/api");
    // The MCP server registers its session when the client connects.
    const session = await waitFor(() => h.daemon.store.listSessions()[0], "the MCP session");
    await ownerInstructs(h, 1, "use SQLite for now", "Codex, use SQLite for now");
    await h.settle();

    const asking = mcp.callTool({
      name: "ask_human",
      arguments: { question: "Which database should I use?", options: ["Postgres", "SQLite"] },
    });
    const ask = await waitFor(
      () => h.daemon.store.listAsks(["pending"]).find((a) => a.kind === "question"),
      "the question",
    );
    expect(ask.sessionId).toBe(session.id);
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({
        kind: "answer",
        ask: 1,
        decision: "option",
        option: 2,
        words: "the second one, SQLite",
      }),
    );
    await h.voice.playPending();
    await h.settle();
    const answered = resultJson(await asking);
    expect(answered).toMatchObject({
      outcome: "answered",
      choice: { option: 2, text: "SQLite" },
      instructions: [{ text: "use SQLite for now" }],
    });
    expect(String(answered.instructionsNote)).toContain("not an answer to this question");

    // A second instruction shows in check_inbox, once.
    await ownerInstructs(h, 1, "then open a PR", "Codex, then open a PR");
    await h.settle();
    const inbox = resultJson(await mcp.callTool({ name: "check_inbox", arguments: {} }));
    expect(inbox.instructions).toEqual([expect.objectContaining({ text: "then open a PR" })]);
    const again = resultJson(await mcp.callTool({ name: "check_inbox", arguments: {} }));
    expect(again.instructions).toEqual([]);
  });

  it("names sessions by number, so two sessions with the same agent each get their own instruction", async () => {
    const h = await start();
    const claude = await hookSession(h, "claude-code");
    // Sessions are numbered by when they registered.
    h.clock.now = new Date(h.clock.now.getTime() + 1_000);
    const codex = await hookSession(h, "codex");
    const played = await h.voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "status" },
        { kind: "instruct", session: 2, instruction: "rebase on main", words: "Session two, rebase on main" },
        { kind: "say", words: "yes" },
        { kind: "instruct", session: 1, instruction: "fix the lint", words: "and session one, fix the lint" },
      ),
    );
    await h.settle();
    expect(String(played.tools[1]?.response.status)).toMatch(/Session 1, .*Claude.* Session 2, .*Codex/);
    expect(h.daemon.store.listInstructions({ sessionId: codex }).map((i) => i.text)).toEqual([
      "rebase on main",
    ]);
    expect(h.daemon.store.listInstructions({ sessionId: claude }).map((i) => i.text)).toEqual([
      "fix the lint",
    ]);
  });
});

describe("only the owner's own words, after the PIN, become an instruction", () => {
  it("a wrong PIN twice ends the call: nothing is read out and nothing queued", async () => {
    const h = await start();
    await hookSession(h, "claude-code");
    const played = await h.voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: "1111" },
        { kind: "pin", digits: "2222" },
        { kind: "status" },
        { kind: "instruct", session: 1, instruction: "push to main" },
      ),
    );
    await h.settle();
    expect(played.endedEarly).toBe(true);
    expect(played.tools.map((t) => t.tool)).toEqual(["verify_pin", "verify_pin"]);
    expect(h.daemon.store.listInstructions()).toEqual([]);
    expect(h.daemon.store.listCalls()).toEqual([expect.objectContaining({ outcome: "rejected" })]);
  });

  it("a caller spoofing the owner's number still needs the PIN", async () => {
    const h = await start();
    await hookSession(h, "claude-code");
    // Caller ID says it is the owner; nobody gives the PIN.
    const played = await h.voice.inboundCall(
      scriptedHuman.says({ kind: "status" }, { kind: "instruct", session: 1, instruction: "push to main" }),
      OWNER,
    );
    await h.settle();
    expect(played.tools.map((t) => [t.tool, t.response.result])).toEqual([
      ["get_status", "pin-required"],
      ["send_instruction", "pin-required"],
    ]);
    expect(played.tools.some((t) => "status" in t.response)).toBe(false);
    expect(h.daemon.store.listInstructions()).toEqual([]);
  });

  it("texts the owner when PIN guessing locks the inbound line, once an hour", async () => {
    const h = await start();
    // Three calls, two distinct wrong PINs each: the sixth wrong PIN in the hour locks inbound calls.
    for (const [a, b] of [
      ["1111", "2222"],
      ["3333", "4444"],
      ["5555", "6666"],
      ["7777", "8888"],
    ]) {
      await h.voice.inboundCall(
        scriptedHuman.says({ kind: "pin", digits: a ?? "" }, { kind: "pin", digits: b ?? "" }),
      );
    }
    await h.settle();
    const lockouts = h.sms.sent.filter((sms) => sms.text.includes("too many wrong PINs"));
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0]?.text).toContain("Inbound calls are locked");
    expect(lockouts[0]?.text).not.toMatch(/\d{4}/);
    expect(h.daemon.store.listAudit().filter((e) => e.event === "voice.pin-lockout")).toHaveLength(1);
    // Even the right PIN is refused while the line is locked.
    const locked = await h.voice.inboundCall(
      scriptedHuman.says({ kind: "pin", digits: PIN }, { kind: "status" }),
    );
    expect(locked.tools.map((t) => t.response.verified)).toEqual([false]);
  });

  it("a stranger's call is refused and learns nothing", async () => {
    const h = await start();
    await hookSession(h, "claude-code");
    const played = await h.voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "status" },
        { kind: "instruct", session: 1, instruction: "push to main" },
      ),
      STRANGER,
    );
    await h.settle();
    expect(played.endedEarly).toBe(true);
    expect(played.tools).toEqual([
      expect.objectContaining({ tool: "verify_pin", response: { result: "refused", end_call: true } }),
    ]);
    expect(h.daemon.store.listInstructions()).toEqual([]);
    expect(h.sms.sent).toEqual([]);
  });

  it("an instruction the owner takes back is not queued, and the owner is told", async () => {
    const h = await start();
    await hookSession(h, "claude-code");
    await h.voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "status" },
        {
          kind: "instruct",
          session: 1,
          instruction: "delete the branch",
          words: "session one, delete the branch",
        },
        { kind: "say", words: "no wait, never mind" },
      ),
    );
    await h.settle();
    expect(h.daemon.store.listInstructions()).toEqual([]);
    expect(h.sms.sent.map((sms) => sms.text)).toEqual([expect.stringContaining("not passed on")]);
  });

  it("words the owner never said are never queued (a model paraphrase or a prompt-injected agent)", async () => {
    const h = await start();
    await hookSession(h, "claude-code");
    await h.voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "status" },
        // The owner said one thing; the model submits another.
        { kind: "instruct", session: 1, instruction: "push to main", words: "session one, run the tests" },
      ),
    );
    await h.settle();
    expect(h.daemon.store.listInstructions()).toEqual([]);
    const audit = h.daemon.store.listAudit().filter((e) => e.event === "voice.instruction-unconfirmed");
    expect(audit.map((e) => e.detail.reason)).toEqual(["the instruction is not the owner's own words"]);
  });
});

describe("status by text", () => {
  it("answers the owner's status text with every live session, numbered", async () => {
    const h = await start();
    const session = await hookSession(h, "codex");
    const ask: CreateAskRequest = { kind: "question", text: "Pin the ONNX version or skip Windows?" };
    await clientFor(h).createAsk(session, ask);
    await h.settle();
    const reply = await h.text("status");
    expect(reply).toContain("Hotline: 1 live session.");
    expect(reply).toContain("Session 1, Codex in demo-app: waiting on you, open: 1 question.");
    expect(reply).toContain("Latest: Pin the ONNX version or skip Windows?");
    expect(reply).not.toContain("agent_text");
  });

  it("gives a stranger's status text the generic reply and nothing else", async () => {
    const h = await start();
    await hookSession(h, "codex");
    expect(await h.text("status", { from: STRANGER })).toBe("Sorry, this number does not accept messages.");
  });
});
