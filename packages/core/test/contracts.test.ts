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

  it("has no decision that stands for silence or an assumption", () => {
    for (const type of ["approve-by-default", "timeout", "assumed", "no-answer"]) {
      expect(Decision.safeParse({ type }).success, type).toBe(false);
    }
  });
});

describe("answerProblem", () => {
  it("accepts a decision that fits the ask", () => {
    expect(answerProblem(question, answer("ask-1", { type: "option", option: 2 }))).toBeUndefined();
    expect(answerProblem(question, answer("ask-1", { type: "text", text: "neither" }))).toBeUndefined();
    expect(answerProblem(permission("low"), answer("ask-2", { type: "allow" }))).toBeUndefined();
    expect(answerProblem(permission("high"), answer("ask-2", { type: "deny" }))).toBeUndefined();
  });

  it("rejects an option the ask did not offer or a decision of the wrong kind", () => {
    expect(answerProblem(question, answer("ask-1", { type: "option", option: 3 }))).toMatch(
      /not one the ask offered/,
    );
    expect(answerProblem(question, answer("ask-1", { type: "allow" }))).toMatch(/cannot be answered/);
    expect(answerProblem(permission("low"), answer("ask-2", { type: "text", text: "sure" }))).toMatch(
      /cannot be answered/,
    );
    expect(answerProblem(question, answer("ask-2", { type: "option", option: 1 }))).toMatch(/different ask/);
  });

  it("needs the PIN or a confirming text for a high-risk approval", () => {
    expect(answerProblem(permission("high"), answer("ask-2", { type: "allow" }))).toMatch(/PIN/);
    expect(answerProblem(permission("high"), answer("ask-2", { type: "allow" }, "pin"))).toBeUndefined();
    expect(answerProblem(permission("high"), answer("ask-2", { type: "allow" }, "text"))).toBeUndefined();
  });

  it("lets a stop continue with an instruction or finish, and takes no answer for a notification", () => {
    const stop = Ask.parse({ ...question, id: "ask-3", kind: "stop", options: [] });
    expect(
      answerProblem(stop, answer("ask-3", { type: "text", text: "now write the tests" })),
    ).toBeUndefined();
    expect(answerProblem(stop, answer("ask-3", { type: "done" }))).toBeUndefined();
    expect(answerProblem(stop, answer("ask-3", { type: "allow" }))).toMatch(/cannot be answered/);
    const notify = Ask.parse({ ...question, id: "ask-4", kind: "notify", options: [] });
    expect(answerProblem(notify, answer("ask-4", { type: "done" }))).toMatch(/no answer/);
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
