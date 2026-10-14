import { describe, expect, it } from "vitest";
import { Answer, Ask, AskOutcome, answerProblem, CallRecord, Decision, Session } from "../src/index.js";

const T0 = "2026-10-13T21:58:00.000Z";
const T1 = "2026-10-13T22:28:00.000Z";

const question = Ask.parse({
  id: "ask-1",
  sessionId: "session-1",
  kind: "question",
  text: "Pin the older ONNX version, or skip Windows for now?",
  options: ["Pin the older version", "Skip Windows"],
  createdAt: T0,
  expiresAt: T1,
  status: "pending",
});

const permission = (risk: "low" | "high") =>
  Ask.parse({
    id: "ask-2",
    sessionId: "session-1",
    kind: "permission",
    text: "Run: git push origin agent/demo",
    toolName: "Bash",
    risk,
    createdAt: T0,
    expiresAt: T1,
    status: "in-flight",
  });

const answer = (askId: string, decision: Decision, confirmation: "none" | "pin" | "text" = "none") =>
  Answer.parse({
    askId,
    decision,
    channel: "voice",
    ownerExcerpt: "yeah go with the second one",
    sourceId: "conv-fake-1",
    confirmation,
    answeredAt: T0,
  });

/** A clock reading between T0 and T1, while the asks are open. */
const DURING = new Date("2026-10-13T22:00:00.000Z");

const problem = (ask: Ask, given: Answer, receivedAt: Date = DURING) => answerProblem(ask, given, receivedAt);

describe("Session", () => {
  it("accepts a registered session and rejects unknown agents or relative paths", () => {
    const session = {
      id: "session-1",
      agent: "codex",
      cwd: "/Users/example/src/demo-app",
      nickname: "Codex in demo-app",
      state: "working",
      registeredAt: T0,
      lastSeenAt: T1,
    };
    expect(Session.parse(session)).toEqual(session);
    expect(Session.safeParse({ ...session, agent: "cursor" }).success).toBe(false);
    expect(Session.safeParse({ ...session, cwd: "src/demo-app" }).success).toBe(false);
    expect(Session.safeParse({ ...session, lastSeenAt: "yesterday" }).success).toBe(false);
  });
});

describe("Ask", () => {
  it("fills defaults", () => {
    expect(question.risk).toBe("low");
    expect(question.urgent).toBe(false);
    expect(permission("high").options).toEqual([]);
  });

  it("enforces its invariants", () => {
    const base = {
      id: "a",
      sessionId: "s",
      kind: "question",
      text: "?",
      createdAt: T0,
      expiresAt: T1,
      status: "pending",
    };
    expect(Ask.safeParse({ ...base, expiresAt: T0 }).success).toBe(false);
    expect(Ask.safeParse({ ...base, options: ["a", "a"] }).success).toBe(false);
    expect(
      Ask.safeParse({ ...base, options: Array.from({ length: 10 }, (_, i) => `option ${i}`) }).success,
    ).toBe(false);
    expect(Ask.safeParse({ ...base, kind: "permission" }).success).toBe(false);
    expect(Ask.safeParse({ ...base, kind: "stop", options: ["a"] }).success).toBe(false);
    expect(Ask.safeParse({ ...base, approved: true }).success).toBe(false);
  });
});

describe("Answer", () => {
  it("requires the owner's verbatim words", () => {
    expect(
      Answer.safeParse({ ...answer("ask-1", { type: "option", option: 2 }), ownerExcerpt: "" }).success,
    ).toBe(false);
  });

  it("rejects a blank excerpt or free-text decision but stores real text untrimmed", () => {
    const base = answer("ask-1", { type: "option", option: 2 });
    for (const blank of [" ", "   ", "\t", "\n", " \t\r\n "]) {
      expect(Answer.safeParse({ ...base, ownerExcerpt: blank }).success, JSON.stringify(blank)).toBe(false);
      expect(Decision.safeParse({ type: "text", text: blank }).success, JSON.stringify(blank)).toBe(false);
    }
    expect(Answer.parse({ ...base, ownerExcerpt: "  two \n" }).ownerExcerpt).toBe("  two \n");
    expect(Decision.parse({ type: "text", text: " skip it " })).toEqual({ type: "text", text: " skip it " });
  });

  it("has no decision that stands for silence or an assumption", () => {
    for (const type of ["approve-by-default", "timeout", "assumed", "no-answer"]) {
      expect(Decision.safeParse({ type }).success, type).toBe(false);
    }
  });
});

describe("answerProblem", () => {
  it("accepts a decision that fits the ask", () => {
    expect(problem(question, answer("ask-1", { type: "option", option: 2 }))).toBeUndefined();
    expect(problem(question, answer("ask-1", { type: "text", text: "neither" }))).toBeUndefined();
    expect(problem(permission("low"), answer("ask-2", { type: "allow" }))).toBeUndefined();
    expect(problem(permission("high"), answer("ask-2", { type: "deny" }))).toBeUndefined();
  });

  it("rejects an option the ask did not offer or a decision of the wrong kind", () => {
    expect(problem(question, answer("ask-1", { type: "option", option: 3 }))).toMatch(
      /not one the ask offered/,
    );
    expect(problem(question, answer("ask-1", { type: "allow" }))).toMatch(/cannot be answered/);
    expect(problem(permission("low"), answer("ask-2", { type: "text", text: "sure" }))).toMatch(
      /cannot be answered/,
    );
    expect(problem(question, answer("ask-2", { type: "option", option: 1 }))).toMatch(/different ask/);
  });

  it("needs the PIN or a confirming text for a high-risk approval", () => {
    expect(problem(permission("high"), answer("ask-2", { type: "allow" }))).toMatch(/PIN/);
    expect(problem(permission("high"), answer("ask-2", { type: "allow" }, "pin"))).toBeUndefined();
    expect(problem(permission("high"), answer("ask-2", { type: "allow" }, "text"))).toBeUndefined();
  });

  it("lets a stop continue with an instruction or finish, and takes no answer for a notification", () => {
    const stop = Ask.parse({ ...question, id: "ask-3", kind: "stop", options: [] });
    expect(problem(stop, answer("ask-3", { type: "text", text: "now write the tests" }))).toBeUndefined();
    expect(problem(stop, answer("ask-3", { type: "done" }))).toBeUndefined();
    expect(problem(stop, answer("ask-3", { type: "allow" }))).toMatch(/cannot be answered/);
    const notify = Ask.parse({ ...question, id: "ask-4", kind: "notify", options: [] });
    expect(problem(notify, answer("ask-4", { type: "done" }))).toMatch(/no answer/);
  });

  it("accepts an answer for a pending or in-flight ask given and received before it expires", () => {
    const allow = answer("ask-2", { type: "allow" });
    const justBefore = new Date(Date.parse(T1) - 1);
    for (const status of ["pending", "in-flight"] as const) {
      const ask = { ...permission("low"), status };
      expect(problem(ask, allow), status).toBeUndefined();
      expect(problem(ask, allow, justBefore), status).toBeUndefined();
      expect(
        problem(ask, { ...allow, answeredAt: justBefore.toISOString() }, justBefore),
        status,
      ).toBeUndefined();
    }
  });

  it("rejects an answer for an ask that is no longer waiting", () => {
    for (const status of ["answered", "expired", "cancelled"] as const) {
      const ask = { ...permission("low"), status };
      expect(problem(ask, answer("ask-2", { type: "allow" })), status).toMatch(/not waiting for an answer/);
      expect(problem(ask, answer("ask-2", { type: "deny" })), status).toMatch(/not waiting for an answer/);
      const stale = { ...question, status };
      expect(problem(stale, answer("ask-1", { type: "option", option: 1 })), status).toMatch(
        /not waiting for an answer/,
      );
    }
  });

  it("rejects an answer received at or after the ask expired, even if the ask still looks open", () => {
    const allow = answer("ask-2", { type: "allow" });
    const ask = permission("low");
    expect(problem(ask, allow, new Date(T1))).toMatch(/arrived after the ask expired/);
    expect(problem(ask, allow, new Date(Date.parse(T1) + 60_000))).toMatch(/arrived after the ask expired/);
    expect(problem(question, answer("ask-1", { type: "text", text: "late" }), new Date(T1))).toMatch(
      /arrived after the ask expired/,
    );
  });

  it("rejects an answer given at or after the ask expired", () => {
    const ask = permission("low");
    for (const answeredAt of [T1, "2026-10-13T23:00:00.000Z"]) {
      expect(problem(ask, { ...answer("ask-2", { type: "allow" }), answeredAt }), answeredAt).toMatch(
        /given after the ask expired/,
      );
    }
  });

  it("fails closed on an invalid clock reading", () => {
    expect(problem(permission("low"), answer("ask-2", { type: "allow" }), new Date(Number.NaN))).toMatch(
      /arrived is unknown/,
    );
  });
});

describe("AskOutcome", () => {
  it("is either an answer or a reason nobody decided", () => {
    expect(AskOutcome.parse({ outcome: "no-answer", askId: "ask-1", reason: "no-pickup" }).outcome).toBe(
      "no-answer",
    );
    expect(AskOutcome.safeParse({ outcome: "no-answer", askId: "ask-1", reason: "approved" }).success).toBe(
      false,
    );
  });
});

describe("CallRecord", () => {
  const call = {
    id: "call-1",
    provider: "fake",
    direction: "outbound",
    providerIds: { conversationId: "conv-fake-1", callSid: "CA00000000000000000000000000000000" },
    askIds: ["ask-1", "ask-2"],
    outcome: "answered",
    startedAt: T0,
    endedAt: T1,
    durationSeconds: 95,
    costEstimateCents: 14,
  };

  it("records a batched outbound call", () => {
    expect(CallRecord.parse(call)).toEqual(call);
  });

  it("requires an ask for outbound calls and a sane time range", () => {
    expect(CallRecord.safeParse({ ...call, askIds: [] }).success).toBe(false);
    expect(CallRecord.safeParse({ ...call, direction: "inbound", askIds: [] }).success).toBe(true);
    expect(CallRecord.safeParse({ ...call, endedAt: "2026-10-13T21:00:00.000Z" }).success).toBe(false);
    expect(CallRecord.safeParse({ ...call, outcome: "voicemail" }).success).toBe(false);
  });
});
