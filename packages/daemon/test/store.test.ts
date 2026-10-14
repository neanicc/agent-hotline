import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Answer, Ask, CallRecord, Session } from "@hotline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRedactor,
  type HotlineStore,
  MIGRATIONS,
  openStore,
  REDACTED,
  StoreError,
} from "../src/index.js";

const T0 = "2026-10-13T21:58:00.000Z";
const T1 = "2026-10-13T21:59:00.000Z";
const LATER = "2026-10-13T22:28:00.000Z";

const session: Session = {
  id: "s1",
  agent: "claude-code",
  agentSessionId: "agent-session-1",
  cwd: "/Users/example/demo-app",
  nickname: "Claude in demo-app",
  state: "working",
  registeredAt: T0,
  lastSeenAt: T0,
};

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "a1",
    sessionId: "s1",
    kind: "question",
    text: "Use Postgres or SQLite?",
    options: ["Postgres", "SQLite"],
    risk: "low",
    urgent: false,
    createdAt: T0,
    expiresAt: LATER,
    status: "pending",
    ...overrides,
  };
}

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    askId: "a1",
    decision: { type: "option", option: 2 },
    channel: "voice",
    ownerExcerpt: "the second one, SQLite",
    sourceId: "conv_1",
    confirmation: "none",
    answeredAt: T1,
    ...overrides,
  };
}

const call: CallRecord = {
  id: "c1",
  provider: "fake",
  direction: "outbound",
  providerIds: { conversationId: "conv_1" },
  askIds: ["a1"],
  outcome: "answered",
  startedAt: T0,
  endedAt: T1,
  durationSeconds: 60,
  costEstimateCents: 12,
};

let dir: string;
let store: HotlineStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-store-"));
});

afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function open(path = join(dir, "home", "hotline.db")): Promise<HotlineStore> {
  store = await openStore(path);
  return store;
}

describe("openStore", () => {
  it("creates a 0600 database in a 0700 directory at the latest schema", async () => {
    const path = join(dir, "home", "hotline.db");
    const db = await open(path);
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "home"))).mode & 0o777).toBe(0o700);
  });

  it("keeps data and does not re-run migrations when reopened", async () => {
    const path = join(dir, "hotline.db");
    (await open(path)).putSession(session);
    store?.close();
    const again = await open(path);
    expect(again.schemaVersion).toBe(MIGRATIONS.length);
    expect(again.getSession("s1")).toEqual(session);
  });

  it("applies only the migrations a database has not seen", async () => {
    const path = join(dir, "hotline.db");
    (await openStore(path, { migrations: ["CREATE TABLE one (x INTEGER) STRICT;"] })).close();
    store = await openStore(path, {
      migrations: ["CREATE TABLE one (x INTEGER) STRICT;", "CREATE TABLE two (y INTEGER) STRICT;"],
    });
    expect(store.schemaVersion).toBe(2);
  });

  it("rolls back a failing migration and leaves the version unchanged", async () => {
    const path = join(dir, "hotline.db");
    await expect(
      openStore(path, {
        migrations: ["CREATE TABLE ok (x INTEGER) STRICT;", "CREATE TABLE ok (x INTEGER);"],
      }),
    ).rejects.toThrow(/migration 2 failed/);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    raw.close();
  });

  it("refuses a database from a newer hotline", async () => {
    const path = join(dir, "hotline.db");
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    await chmod(path, 0o600);
    await expect(openStore(path)).rejects.toThrow(/newer than this hotline/);
  });

  it.skipIf(process.platform === "win32")("refuses a database other users can read", async () => {
    const path = join(dir, "hotline.db");
    await writeFile(path, "");
    await chmod(path, 0o644);
    await expect(openStore(path)).rejects.toThrow(StoreError);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked database", async () => {
    const real = join(dir, "real.db");
    await writeFile(real, "", { mode: 0o600 });
    await symlink(real, join(dir, "hotline.db"));
    await expect(openStore(join(dir, "hotline.db"))).rejects.toThrow(/symbolic link/);
  });

  it.skipIf(process.platform === "win32")("refuses a directory other users can enter", async () => {
    const home = join(dir, "shared");
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    await expect(openStore(join(home, "hotline.db"))).rejects.toThrow(/chmod 700/);
  });

  it("closes once and refuses use afterwards", async () => {
    const db = await open();
    db.close();
    db.close();
    expect(db.isOpen).toBe(false);
    expect(() => db.listSessions()).toThrow();
  });
});

describe("sessions", () => {
  it("inserts, updates and lists sessions", async () => {
    const db = await open();
    db.putSession(session);
    db.putSession({ ...session, state: "waiting-on-human", lastSeenAt: T1 });
    db.putSession({ ...session, id: "s2", agent: "codex", nickname: "Codex in api" });
    expect(db.getSession("s1")?.state).toBe("waiting-on-human");
    expect(db.listSessions().map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(db.getSession("missing")).toBeUndefined();
  });

  it("rejects an invalid session before writing", async () => {
    const db = await open();
    expect(() => db.putSession({ ...session, cwd: "relative/path" })).toThrow();
    expect(db.listSessions()).toEqual([]);
  });
});

describe("asks and answers", () => {
  it("stores an ask for a known session only", async () => {
    const db = await open();
    expect(() => db.addAsk(ask())).toThrow(StoreError);
    db.putSession(session);
    db.addAsk(ask());
    expect(db.getAsk("a1")).toEqual(ask());
    expect(() => db.addAsk(ask())).toThrow(StoreError);
  });

  it("filters asks by status", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.addAsk(ask({ id: "a2", createdAt: T1, status: "in-flight" }));
    db.addAsk(ask({ id: "a3", createdAt: T1, status: "cancelled" }));
    expect(db.listAsks(["pending", "in-flight"]).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(db.listAsks().map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(db.listAsks([])).toEqual([]);
  });

  it("records an answer and marks the ask answered in one step", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.recordAnswer(answer(), new Date(T1));
    expect(db.getAnswer("a1")).toEqual(answer());
    expect(db.getAsk("a1")?.status).toBe("answered");
  });

  it("never records a second answer for the same ask", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.recordAnswer(answer(), new Date(T1));
    expect(() => db.recordAnswer(answer({ decision: { type: "option", option: 1 } }), new Date(T1))).toThrow(
      /refused/,
    );
    expect(db.getAnswer("a1")?.decision).toEqual({ type: "option", option: 2 });
  });

  it("refuses answers core rejects and stores nothing", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.addAsk(ask({ id: "p1", kind: "permission", options: [], toolName: "Bash", risk: "high" }));
    db.addAsk(ask({ id: "n1", kind: "notify", options: [] }));

    // Arrived after expiry.
    expect(() => db.recordAnswer(answer(), new Date(LATER))).toThrow(/expired/);
    // High-risk approval without PIN or confirming text.
    expect(() => db.recordAnswer(answer({ askId: "p1", decision: { type: "allow" } }), new Date(T1))).toThrow(
      /PIN/,
    );
    // Notifications take no answer.
    expect(() => db.recordAnswer(answer({ askId: "n1", decision: { type: "done" } }), new Date(T1))).toThrow(
      /refused/,
    );
    // Unknown ask.
    expect(() => db.recordAnswer(answer({ askId: "nope" }), new Date(T1))).toThrow(/No ask/);

    for (const id of ["a1", "p1", "n1"]) {
      expect(db.getAnswer(id)).toBeUndefined();
      expect(db.getAsk(id)?.status).toBe("pending");
    }
  });

  it("moves only open asks to a final status, and never to answered", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    expect(db.setAskStatus("a1", "in-flight")).toBe(true);
    expect(db.setAskStatus("a1", "expired")).toBe(true);
    expect(db.setAskStatus("a1", "pending")).toBe(false);
    expect(db.getAsk("a1")?.status).toBe("expired");
    expect(db.setAskStatus("missing", "expired")).toBe(false);
    // An expired ask can no longer be answered.
    expect(() => db.recordAnswer(answer(), new Date(T1))).toThrow(/expired/);
    expect(() => db.setAskStatus("a1", "answered" as "expired")).toThrow(/recordAnswer/);
    expect(() => db.addAsk(ask({ id: "a9", status: "answered" }))).toThrow(/recordAnswer/);
  });
});

describe("calls", () => {
  it("inserts and updates call records", async () => {
    const db = await open();
    db.putCall({ ...call, outcome: "no-answer", endedAt: undefined });
    db.putCall(call);
    expect(db.getCall("c1")).toEqual(call);
    expect(db.listCalls()).toEqual([call]);
    expect(() => db.putCall({ ...call, askIds: [] })).toThrow();
  });
});

describe("audit", () => {
  it("appends redacted entries in order", async () => {
    store = await openStore(join(dir, "hotline.db"), {
      redactor: createRedactor(["the-daemon-token-value"]),
    });
    const db = store;
    db.appendAudit("call.placed", { to: "+15555550100", note: "token the-daemon-token-value" }, new Date(T0));
    db.appendAudit("webhook.rejected", { path: "/hooks/twilio/sms", signature: "abc" }, new Date(T1));
    expect(db.listAudit()).toEqual([
      { seq: 1, at: T0, event: "call.placed", detail: { to: "***0100", note: `token ${REDACTED}` } },
      {
        seq: 2,
        at: T1,
        event: "webhook.rejected",
        detail: { path: "/hooks/twilio/sms", signature: REDACTED },
      },
    ]);
  });

  it("cannot be changed or deleted", async () => {
    const path = join(dir, "hotline.db");
    const db = await open(path);
    db.appendAudit("daemon.started", {}, new Date(T0));
    db.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE audit SET event = 'x'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM audit")).toThrow(/append-only/);
    raw.close();
  });

  it("rejects malformed event names and invalid times", async () => {
    const db = await open();
    expect(() => db.appendAudit("Bad Event", {}, new Date(T0))).toThrow(StoreError);
    expect(() => db.appendAudit("daemon.started", {}, new Date(Number.NaN))).toThrow(StoreError);
  });

  it("keeps UUID ids queryable in their own columns while detail is still redacted", async () => {
    const db = await open();
    const askId = "0b7e7c1a-3f4d-4e8a-9c2b-5d6f7a8b9c0d";
    const sessionId = "1c8f8d2b-4a5e-4f9b-8d3c-6e7a8b9c0d1e";
    const callId = "2d9a9e3c-5b6f-4a0c-9e4d-7f8b9c0d1e2f";
    // A UUID-shaped secret that ends up in free text.
    const uuidSecret = "9f1c2d3e-4b5a-6789-abcd-ef0123456789";
    db.appendAudit("ask.answered", { note: `key ${uuidSecret}`, mentions: askId }, new Date(T0), {
      askId,
      sessionId,
      callId,
    });
    db.appendAudit("ask.created", {}, new Date(T1), { askId: "a2", sessionId });
    db.appendAudit("daemon.started", {}, new Date(T1));

    const [first] = db.listAudit({ askId });
    expect(first).toEqual({
      seq: 1,
      at: T0,
      event: "ask.answered",
      askId,
      sessionId,
      callId,
      // The ids are kept in their columns, but detail stays fail-closed: a UUID
      // there is removed whether it is an id or a secret.
      detail: { note: `key ${REDACTED}`, mentions: REDACTED },
    });
    expect(JSON.stringify(db.listAudit())).not.toContain(uuidSecret);
    expect(db.listAudit({ askId })).toHaveLength(1);
    expect(db.listAudit({ sessionId }).map((entry) => entry.seq)).toEqual([1, 2]);
    expect(db.listAudit({ callId }).map((entry) => entry.seq)).toEqual([1]);
    expect(db.listAudit({ sessionId, askId: "a2" }).map((entry) => entry.seq)).toEqual([2]);
    expect(db.listAudit({ askId: "missing" })).toEqual([]);
    expect(db.listAudit().map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(db.listAudit()[2]).toEqual({ seq: 3, at: T1, event: "daemon.started", detail: {} });
  });

  it("validates audit ids against the core Id schema and refuses unknown ones", async () => {
    const db = await open();
    expect(() => db.appendAudit("ask.created", {}, new Date(T0), { askId: "" })).toThrow(/not a valid id/);
    expect(() => db.appendAudit("ask.created", {}, new Date(T0), { callId: "x".repeat(129) })).toThrow(
      /not a valid id/,
    );
    expect(() =>
      db.appendAudit("ask.created", {}, new Date(T0), { askID: "a1" } as unknown as { askId: string }),
    ).toThrow(/Unknown audit id/);
    expect(() => db.listAudit({ sessionId: "" })).toThrow(/not a valid id/);
    expect(db.listAudit()).toEqual([]);
  });

  it("adds the id columns to an existing audit log and keeps it append-only", async () => {
    const path = join(dir, "hotline.db");
    (await openStore(path, { migrations: MIGRATIONS.slice(0, 1) })).close();
    const v1 = new DatabaseSync(path);
    v1.prepare("INSERT INTO audit (at, event, detail) VALUES (?, ?, ?)").run(
      T0,
      "daemon.started",
      JSON.stringify({ version: "0.0.0" }),
    );
    v1.close();
    const db = await open(path);
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    db.appendAudit("ask.created", {}, new Date(T1), { askId: "a1" });
    expect(db.listAudit()).toEqual([
      { seq: 1, at: T0, event: "daemon.started", detail: { version: "0.0.0" } },
      { seq: 2, at: T1, event: "ask.created", askId: "a1", detail: {} },
    ]);
    db.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE audit SET ask_id = 'other'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM audit WHERE seq = 1")).toThrow(/append-only/);
    raw.close();
  });
});

describe("ask change listeners", () => {
  it("hear committed status changes and answers, not refused ones", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.addAsk(ask({ id: "a2", createdAt: T1 }));
    const heard: string[] = [];
    const stop = db.onAskChange((id) => heard.push(id));
    db.onAskChange(() => {
      throw new Error("a broken listener");
    });

    expect(() => db.recordAnswer(answer({ decision: { type: "allow" } }), new Date(T1))).toThrow(StoreError);
    db.recordAnswer(answer(), new Date(T1));
    expect(db.setAskStatus("a1", "cancelled")).toBe(false);
    expect(db.setAskStatus("a2", "cancelled")).toBe(true);
    expect(heard).toEqual(["a1", "a2"]);
    expect(db.getAsk("a2")?.status).toBe("cancelled");

    stop();
    db.addAsk(ask({ id: "a3" }));
    db.setAskStatus("a3", "expired");
    expect(heard).toEqual(["a1", "a2"]);
  });

  it("count a session's open asks of one kind", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.addAsk(ask({ id: "a2", status: "in-flight" }));
    db.addAsk(ask({ id: "a3", status: "expired" }));
    db.addAsk(ask({ id: "a4", kind: "notify", options: [] }));
    expect(db.countOpenAsks("s1", "question")).toBe(2);
    expect(db.countOpenAsks("s1", "notify")).toBe(1);
    expect(db.countOpenAsks("s2", "question")).toBe(0);
    db.putSession({ ...session, id: "s2", agentSessionId: "agent-session-2" });
    db.addAsk(ask({ id: "a5", sessionId: "s2" }));
    expect(db.countOpenAsks(undefined, "question")).toBe(3);
    expect(db.countOpenAsks(undefined, "notify")).toBe(1);
  });

  it("find a live session by agent and agent session id", async () => {
    const db = await open();
    db.putSession(session);
    db.putSession({ ...session, id: "s2", agent: "codex" });
    db.putSession({ ...session, id: "s3", agentSessionId: "agent-session-3", state: "ended" });
    expect(db.findLiveSession("claude-code", "agent-session-1")?.id).toBe("s1");
    expect(db.findLiveSession("codex", "agent-session-1")?.id).toBe("s2");
    expect(db.findLiveSession("claude-code", "agent-session-3")).toBeUndefined();
    expect(db.findLiveSession("claude-code", "unknown")).toBeUndefined();
  });

  it("list one session's newest asks first", async () => {
    const db = await open();
    db.putSession(session);
    db.putSession({ ...session, id: "s2", agentSessionId: "agent-session-2" });
    db.addAsk(ask());
    db.addAsk(ask({ id: "a2", createdAt: T1 }));
    db.addAsk(ask({ id: "a3", sessionId: "s2" }));
    expect(db.listSessionAsks("s1", 10).map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(db.listSessionAsks("s1", 1).map((a) => a.id)).toEqual(["a2"]);
  });
});

describe("call orchestration support", () => {
  it("closes an open ask with its reason, and fills a missing reason without reopening", async () => {
    const db = await open();
    db.putSession(session);
    db.addAsk(ask());
    db.addAsk(ask({ id: "a2" }));
    db.addAsk(ask({ id: "a3" }));
    const changed: string[] = [];
    db.onAskChange((id) => changed.push(id));
    expect(db.closeAsk("a1", "expired", "no-pickup")).toBe(true);
    expect(db.getAsk("a1")?.status).toBe("expired");
    expect(db.askEndReason("a1")).toBe("no-pickup");
    // Already final: the status and the recorded reason stay.
    expect(db.closeAsk("a1", "cancelled", "cancelled")).toBe(false);
    expect([db.getAsk("a1")?.status, db.askEndReason("a1")]).toEqual(["expired", "no-pickup"]);
    // The agent API expired a2 a moment earlier, without a reason: the reason is filled in.
    db.setAskStatus("a2", "expired");
    expect(db.closeAsk("a2", "expired", "dropped")).toBe(false);
    expect(db.askEndReason("a2")).toBe("dropped");
    // An answered ask never gets a reason.
    db.recordAnswer(answer({ askId: "a3" }), new Date(T1));
    expect(db.closeAsk("a3", "expired", "timeout")).toBe(false);
    expect(db.askEndReason("a3")).toBeUndefined();
    expect(changed).toEqual(["a1", "a2", "a3"]);
    expect(() => db.closeAsk("a1", "expired", "approved" as never)).toThrow();
  });

  it("tells listeners about each added ask", async () => {
    const db = await open();
    db.putSession(session);
    const added: string[] = [];
    const stop = db.onAskAdded((a) => added.push(a.id));
    db.onAskAdded(() => {
      throw new Error("a broken listener changes nothing");
    });
    db.addAsk(ask());
    stop();
    db.addAsk(ask({ id: "a2" }));
    expect(added).toEqual(["a1"]);
    expect(db.getAsk("a2")).toBeDefined();
  });

  it("saves state as JSON and remembers handled inbound messages across a reopen", async () => {
    const path = join(dir, "home", "hotline.db");
    const db = await open(path);
    expect(db.getState("orchestrator")).toBeUndefined();
    db.putState("orchestrator", { version: 1, calls: [] });
    db.putState("orchestrator", { version: 1, calls: ["c1"] });
    const sid = `SM${"1".repeat(32)}`;
    expect(db.inboundMessageHandled(sid)).toBe(false);
    db.markInboundMessage(sid, new Date(T0));
    db.markInboundMessage(sid, new Date(T1));
    db.close();
    const again = await open(path);
    expect(again.getState("orchestrator")).toEqual({ version: 1, calls: ["c1"] });
    expect(again.inboundMessageHandled(sid)).toBe(true);
    expect(again.inboundMessageHandled(`SM${"2".repeat(32)}`)).toBe(false);
  });

  it("forgets finished inbound messages after a week, never unfinished ones", async () => {
    const db = await open();
    const [old, unfinished, fresh] = ["1", "2", "3"].map((d) => `SM${d.repeat(32)}`) as [
      string,
      string,
      string,
    ];
    db.markInboundMessage(old, new Date(T0));
    db.finishInboundMessage(old);
    db.markInboundMessage(unfinished, new Date(T0));
    db.markInboundMessage(fresh, new Date(Date.parse(T0) + 8 * 24 * 60 * 60 * 1000));
    expect(db.inboundMessageHandled(old)).toBe(false);
    expect(db.inboundMessageHandled(unfinished)).toBe(true);
    expect(db.inboundMessageHandled(fresh)).toBe(true);
  });
});
