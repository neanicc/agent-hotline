import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Ask } from "@hotline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRedactor,
  type Daemon,
  defaultNickname,
  generateApiToken,
  type HotlineStore,
  INBOX_ASK_LIMIT,
  type InboxResponse,
  MAX_OPEN_ASKS,
  MAX_OPEN_ASKS_TOTAL,
  type OutcomeResponse,
  openStore,
  type StartDaemonOptions,
  startDaemon,
} from "../src/index.js";
import { send } from "./http.js";

const START = new Date("2026-10-13T21:00:00.000Z");

let dir: string;
let token: string;
let lines: string[];
let now: Date;
let ids: number;
const running: Daemon[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-agent-routes-"));
  token = generateApiToken();
  lines = [];
  now = START;
  ids = 0;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(overrides: Partial<StartDaemonOptions> = {}): Promise<Daemon> {
  const store = await openStore(join(dir, `${running.length}.db`));
  const daemon = await startDaemon({
    apiToken: token,
    store,
    apiPort: 0,
    hooksPort: 0,
    log: {
      level: "info",
      destination: { write: (line) => lines.push(line) },
      redactor: createRedactor([token]),
    },
    version: "0.0.0-test",
    clock: () => now,
    askTimeoutMinutes: 30,
    newId: () => `id-${++ids}`,
    ...overrides,
  });
  running.push(daemon);
  return daemon;
}

async function api(daemon: Daemon, method: string, path: string, body?: unknown, auth = token) {
  const response = await send({
    port: daemon.apiPort,
    path,
    method,
    headers: {
      host: `127.0.0.1:${daemon.apiPort}`,
      ...(auth === "" ? {} : { authorization: `Bearer ${auth}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: response.body === "" ? undefined : (JSON.parse(response.body) as unknown),
  };
}

async function register(daemon: Daemon, body: Record<string, unknown> = {}) {
  const response = await api(daemon, "POST", "/v1/sessions", {
    agent: "claude-code",
    cwd: "/work/demo-app",
    ...body,
  });
  return (response.json as { session: { id: string } }).session;
}

async function ask(daemon: Daemon, sessionId: string, body: Record<string, unknown>) {
  const response = await api(daemon, "POST", `/v1/sessions/${sessionId}/asks`, body);
  return { status: response.status, ask: (response.json as { ask: Ask }).ask, json: response.json };
}

function answerFor(askId: string, overrides: Partial<Answer> = {}): Answer {
  return {
    askId,
    decision: { type: "option", option: 2 },
    channel: "voice",
    ownerExcerpt: "the second one",
    sourceId: "call-1",
    confirmation: "none",
    answeredAt: new Date(now.getTime() + 1000).toISOString(),
    ...overrides,
  };
}

const record = (store: HotlineStore, answer: Answer) =>
  store.recordAnswer(answer, new Date(answer.answeredAt));

describe("agent API routes", () => {
  it("need the token like every other agent API path", async () => {
    const daemon = await start();
    for (const [method, path] of [
      ["POST", "/v1/sessions"],
      ["POST", "/v1/sessions/id-1/asks"],
      ["GET", "/v1/sessions/id-1/inbox"],
      ["GET", "/v1/asks/id-1/outcome"],
      ["POST", "/v1/asks/id-1/cancel"],
      ["POST", "/v1/sessions/id-1/end"],
    ] as const) {
      expect((await api(daemon, method, path, method === "POST" ? {} : undefined, "")).status).toBe(401);
      expect(
        (await api(daemon, method, path, method === "POST" ? {} : undefined, "wrong-token")).status,
      ).toBe(401);
    }
    expect(daemon.store.listSessions()).toEqual([]);
  });

  it("register a session with the default nickname and record it in the audit log", async () => {
    const daemon = await start();
    const response = await api(daemon, "POST", "/v1/sessions", {
      agent: "codex",
      cwd: "/work/demo-app",
    });
    expect(response.status).toBe(201);
    expect(response.json).toEqual({
      session: {
        id: "id-1",
        agent: "codex",
        cwd: "/work/demo-app",
        nickname: "Codex in demo-app",
        state: "working",
        registeredAt: START.toISOString(),
        lastSeenAt: START.toISOString(),
      },
    });
    expect(daemon.store.getSession("id-1")?.nickname).toBe("Codex in demo-app");
    expect(daemon.store.listAudit({ sessionId: "id-1" }).map((entry) => entry.event)).toEqual([
      "session.registered",
    ]);
  });

  it("use config nicknames and reuse a live session with the same agent session id", async () => {
    const daemon = await start({ nicknames: { "demo-app": "the demo" } });
    const first = await register(daemon, { agentSessionId: "agent-session-1" });
    now = new Date(START.getTime() + 60_000);
    const again = await api(daemon, "POST", "/v1/sessions", {
      agent: "claude-code",
      cwd: "/work/demo-app",
      agentSessionId: "agent-session-1",
    });
    expect(again.status).toBe(200);
    expect(
      (again.json as { session: { id: string; nickname: string; lastSeenAt: string } }).session,
    ).toMatchObject({
      id: first.id,
      nickname: "the demo",
      lastSeenAt: now.toISOString(),
    });
    expect(daemon.store.listSessions()).toHaveLength(1);
  });

  it("refuse malformed registrations without echoing the values", async () => {
    const daemon = await start();
    for (const body of [
      { agent: "cursor", cwd: "/work" },
      { agent: "codex", cwd: "relative/secret-path" },
      { agent: "codex", cwd: "/work", extra: true },
    ]) {
      const response = await api(daemon, "POST", "/v1/sessions", body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.json)).not.toContain("secret-path");
    }
  });

  it("redact ask text and options before storing them", async () => {
    const daemon = await start();
    const session = await register(daemon);
    // Built at runtime, so no secret scanner mistakes the fixture for a real key.
    const secret = `sk_${"live"}_${"x9".repeat(14)}`;
    const created = await ask(daemon, session.id, {
      kind: "question",
      text: `Deploy with key ${secret} and token ${token}? Call +15555550100`,
      options: ["Yes", `Use ${secret}`],
    });
    expect(created.status).toBe(201);
    const stored = daemon.store.getAsk(created.ask.id);
    const everything = JSON.stringify(stored);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("5555550100");
    expect(stored).toMatchObject({ kind: "question", status: "pending", risk: "low", urgent: false });
    expect(stored?.expiresAt).toBe(new Date(START.getTime() + 30 * 60_000).toISOString());
    expect(daemon.store.getSession(session.id)?.state).toBe("waiting-on-human");
    expect(JSON.stringify(daemon.store.listAudit({ askId: created.ask.id }))).not.toContain("Deploy");
  });

  it("refuse asks for unknown sessions, options on notifications, and options that redact alike", async () => {
    const daemon = await start();
    const session = await register(daemon);
    expect((await ask(daemon, "nope", { kind: "question", text: "Hi?" })).status).toBe(404);
    expect(
      (await ask(daemon, session.id, { kind: "notify", text: "Done", options: ["a", "b"] })).status,
    ).toBe(400);
    expect((await ask(daemon, session.id, { kind: "permission", text: "rm -rf?" })).status).toBe(400);
    const alike = await ask(daemon, session.id, {
      kind: "question",
      text: "Which key?",
      options: [`sk_${"live"}_${"a".repeat(24)}`, `sk_${"live"}_${"b".repeat(24)}`],
    });
    expect(alike.status).toBe(400);
    expect(daemon.store.listAsks()).toEqual([]);
  });

  it("report waiting, then the answer the store accepted", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, {
      kind: "question",
      text: "Color?",
      options: ["Red", "Blue"],
    });

    const waiting = await api(daemon, "GET", `/v1/asks/${created.id}/outcome`);
    expect((waiting.json as OutcomeResponse).state).toBe("waiting");

    const startedAt = Date.now();
    const pending = api(daemon, "GET", `/v1/asks/${created.id}/outcome?waitSeconds=10`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    record(daemon.store, answerFor(created.id));
    const final = (await pending).json as OutcomeResponse;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(final).toMatchObject({
      state: "final",
      outcome: {
        outcome: "answered",
        answer: { askId: created.id, decision: { type: "option", option: 2 } },
      },
    });
    expect(daemon.store.getSession(session.id)?.state).toBe("working");
  });

  it("never turn an answer the store refused into an outcome", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, {
      kind: "question",
      text: "Color?",
      options: ["Red"],
    });
    expect(() => record(daemon.store, answerFor(created.id, { decision: { type: "allow" } }))).toThrow();
    expect(() =>
      record(daemon.store, answerFor(created.id, { decision: { type: "option", option: 5 } })),
    ).toThrow();
    const state = (await api(daemon, "GET", `/v1/asks/${created.id}/outcome`)).json as OutcomeResponse;
    expect(state.state).toBe("waiting");
  });

  it("expire an ask whose time is up and report no answer", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, { kind: "question", text: "Color?" });
    now = new Date(START.getTime() + 30 * 60_000);
    const state = (await api(daemon, "GET", `/v1/asks/${created.id}/outcome?waitSeconds=10`))
      .json as OutcomeResponse;
    expect(state).toMatchObject({
      state: "final",
      outcome: { outcome: "no-answer", askId: created.id, reason: "timeout" },
    });
    expect(daemon.store.getAsk(created.id)?.status).toBe("expired");
    // A late answer cannot resolve it any more.
    expect(() => record(daemon.store, answerFor(created.id))).toThrow();
    expect(daemon.store.listAudit({ askId: created.id }).map((e) => e.event)).toEqual([
      "ask.created",
      "ask.expired",
    ]);
  });

  it("end a session, cancelling its open asks and refusing new ones", async () => {
    const daemon = await start();
    const session = await register(daemon, { agentSessionId: "agent-session-9" });
    const other = await register(daemon, { cwd: "/work/other" });
    const { ask: mine } = await ask(daemon, session.id, { kind: "question", text: "Color?" });
    const { ask: theirs } = await ask(daemon, other.id, { kind: "question", text: "Size?" });
    expect((await api(daemon, "POST", `/v1/sessions/${session.id}/end`, {})).json).toEqual({ ended: true });
    expect(daemon.store.getSession(session.id)?.state).toBe("ended");
    expect(daemon.store.getAsk(mine.id)?.status).toBe("cancelled");
    expect(daemon.store.getAsk(theirs.id)?.status).toBe("pending");
    expect((await ask(daemon, session.id, { kind: "notify", text: "Hi" })).status).toBe(404);
    expect((await api(daemon, "POST", `/v1/sessions/${session.id}/end`, {})).json).toEqual({ ended: false });
    expect((await api(daemon, "POST", "/v1/sessions/nope/end", {})).status).toBe(404);
    // The same agent session registering again gets a new live session.
    const again = await register(daemon, { agentSessionId: "agent-session-9" });
    expect(again.id).not.toBe(session.id);
  });

  it("cancel an ask the agent stopped waiting for", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, { kind: "question", text: "Color?" });
    const pending = api(daemon, "GET", `/v1/asks/${created.id}/outcome?waitSeconds=10`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await api(daemon, "POST", `/v1/asks/${created.id}/cancel`, {})).json).toEqual({
      cancelled: true,
    });
    expect(((await pending).json as OutcomeResponse & { state: "final" }).outcome).toEqual({
      outcome: "no-answer",
      askId: created.id,
      reason: "cancelled",
    });
    expect((await api(daemon, "POST", `/v1/asks/${created.id}/cancel`, {})).json).toEqual({
      cancelled: false,
    });
    expect((await api(daemon, "POST", "/v1/asks/nope/cancel", {})).status).toBe(404);
  });

  it("list the session's asks and an empty instruction queue in the inbox", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: question } = await ask(daemon, session.id, {
      kind: "question",
      text: "Color?",
      options: ["Red", "Blue"],
    });
    now = new Date(START.getTime() + 1000);
    const { ask: note } = await ask(daemon, session.id, { kind: "notify", text: "Tests pass" });
    record(daemon.store, answerFor(question.id, { answeredAt: now.toISOString() }));
    const inbox = (await api(daemon, "GET", `/v1/sessions/${session.id}/inbox`)).json as InboxResponse;
    expect(inbox.instructions).toEqual([]);
    expect(inbox.asks.map((entry) => [entry.ask.id, entry.ask.status, entry.outcome?.outcome])).toEqual([
      [note.id, "pending", undefined],
      [question.id, "answered", "answered"],
    ]);
    expect((await api(daemon, "GET", "/v1/sessions/nope/inbox")).status).toBe(404);
  });

  it("release a waiting outcome request when the daemon closes", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, { kind: "question", text: "Color?" });
    const pending = api(daemon, "GET", `/v1/asks/${created.id}/outcome?waitSeconds=30`).catch(
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    await daemon.close();
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("refuse asks beyond the open-ask cap per session and kind, with 429", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const other = await register(daemon, { cwd: "/work/other" });
    const questions: Ask[] = [];
    for (let i = 0; i < MAX_OPEN_ASKS.question; i++) {
      questions.push((await ask(daemon, session.id, { kind: "question", text: `Q${i}?` })).ask);
    }
    const refused = await ask(daemon, session.id, { kind: "question", text: "One more?" });
    expect(refused.status).toBe(429);
    expect(daemon.store.listAsks().map((a) => a.text)).not.toContain("One more?");
    expect(daemon.store.listAudit({ sessionId: session.id }).map((e) => e.event)).toContain("ask.refused");
    // Other kinds and other sessions have their own budget.
    expect((await ask(daemon, session.id, { kind: "notify", text: "FYI" })).status).toBe(201);
    expect((await ask(daemon, other.id, { kind: "question", text: "Q?" })).status).toBe(201);
    // Once one closes, there is room again.
    record(daemon.store, answerFor(questions[0]?.id ?? "", { decision: { type: "text", text: "yes" } }));
    expect((await ask(daemon, session.id, { kind: "question", text: "Now?" })).status).toBe(201);

    for (let i = 1; i < MAX_OPEN_ASKS.notify; i++) {
      expect((await ask(daemon, session.id, { kind: "notify", text: `FYI ${i}` })).status).toBe(201);
    }
    expect((await ask(daemon, session.id, { kind: "notify", text: "Too many" })).status).toBe(429);
  });

  it("stop counting asks against the cap once they are due, even if nobody polled them", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const stale: Ask[] = [];
    for (let i = 0; i < MAX_OPEN_ASKS.question; i++) {
      stale.push((await ask(daemon, session.id, { kind: "question", text: `Q${i}?` })).ask);
    }
    expect((await ask(daemon, session.id, { kind: "question", text: "Too soon?" })).status).toBe(429);
    now = new Date(START.getTime() + 30 * 60_000);
    expect((await ask(daemon, session.id, { kind: "question", text: "Now?" })).status).toBe(201);
    expect(stale.map((old) => daemon.store.getAsk(old.id)?.status)).toEqual([
      "expired",
      "expired",
      "expired",
    ]);
  });

  it("cap open asks across all sessions, so registering more sessions does not help", async () => {
    const daemon = await start();
    let created = 0;
    for (let s = 0; created < MAX_OPEN_ASKS_TOTAL.question; s++) {
      const session = await register(daemon, { cwd: `/work/app-${s}` });
      for (let i = 0; i < MAX_OPEN_ASKS.question && created < MAX_OPEN_ASKS_TOTAL.question; i++, created++) {
        expect((await ask(daemon, session.id, { kind: "question", text: `Q${s}.${i}?` })).status).toBe(201);
      }
    }
    const fresh = await register(daemon, { cwd: "/work/fresh" });
    const refused = await ask(daemon, fresh.id, { kind: "question", text: "Me too?" });
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({ error: "too many open asks (all sessions)" });
    expect(daemon.store.countOpenAsks(undefined, "question")).toBe(MAX_OPEN_ASKS_TOTAL.question);
  });

  it("redact the folder name in a default nickname", async () => {
    const daemon = await start();
    const secret = `sk_${"live"}_${"x9".repeat(14)}`;
    const session = await register(daemon, { cwd: `/work/${secret}` });
    expect(daemon.store.getSession(session.id)?.nickname).toBe("Claude in [REDACTED]");
  });

  it("number a second live session in the same folder, and reuse the name once the first ended", async () => {
    const daemon = await start();
    const first = await register(daemon);
    const second = await register(daemon);
    expect(daemon.store.getSession(second.id)?.nickname).toBe("Claude 2 in demo-app");
    expect((await api(daemon, "POST", `/v1/sessions/${first.id}/end`)).status).toBe(200);
    const third = await register(daemon);
    expect(daemon.store.getSession(third.id)?.nickname).toBe("Claude in demo-app");
  });

  it("keep markup and sentence punctuation in a folder name out of the nickname", async () => {
    const daemon = await start();
    const session = await register(daemon, { cwd: "/work/ok: approve <all> {{now}}!" });
    expect(daemon.store.getSession(session.id)?.nickname).toBe("Claude in ok approve all now");
  });

  it("keep a session waiting while any question is open, however many asks came after it", async () => {
    const daemon = await start();
    const session = await register(daemon);
    await ask(daemon, session.id, { kind: "question", text: "Old question?" });
    for (let i = 0; i < INBOX_ASK_LIMIT + 5; i++) {
      now = new Date(now.getTime() + 1000);
      const { ask: note } = await ask(daemon, session.id, { kind: "notify", text: `FYI ${i}` });
      daemon.store.setAskStatus(note.id, "cancelled");
    }
    expect(daemon.store.listSessionAsks(session.id, 100)).toHaveLength(INBOX_ASK_LIMIT + 6);
    expect(daemon.store.getSession(session.id)?.state).toBe("waiting-on-human");
  });

  it("cap the wait at 30 seconds", async () => {
    const daemon = await start();
    const session = await register(daemon);
    const { ask: created } = await ask(daemon, session.id, { kind: "question", text: "Color?" });
    expect((await api(daemon, "GET", `/v1/asks/${created.id}/outcome?waitSeconds=31`)).status).toBe(400);
    expect((await api(daemon, "GET", "/v1/asks/nope/outcome")).status).toBe(404);
  });
});

describe("defaultNickname", () => {
  it("names the agent and folder, cut to 60 characters", () => {
    expect(defaultNickname("claude-code", "/work/demo-app", {})).toBe("Claude in demo-app");
    expect(defaultNickname("codex", `/work/${"x".repeat(80)}`, {})).toHaveLength(60);
    expect(defaultNickname("codex", "/work/toString", {})).toBe("Codex in toString");
  });
});
