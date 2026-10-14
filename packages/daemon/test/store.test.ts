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
});
