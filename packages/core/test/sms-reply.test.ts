import { describe, expect, it } from "vitest";
import { Answer, Ask, parseSmsReply, type SmsAnswerInput, smsAnswer } from "../src/index.js";

const CREATED = "2026-10-13T21:58:00.000Z";
const EXPIRES = "2026-10-13T22:28:00.000Z";
const RECEIVED = new Date("2026-10-13T22:00:00.000Z");
const SID = `SM${"a".repeat(32)}`;

function ask(overrides: Partial<Ask> = {}): Ask {
  return Ask.parse({
    id: "ask-1",
    sessionId: "session-1",
    kind: "question",
    text: "Which database?",
    createdAt: CREATED,
    expiresAt: EXPIRES,
    status: "in-flight",
    ...overrides,
  });
}

const question = ask({ options: ["Postgres", "SQLite", "Both"] });
const openQuestion = ask();
const permission = ask({ kind: "permission", text: "Run npm test", toolName: "Bash" });
const risky = ask({ kind: "permission", text: "git push", toolName: "Bash", risk: "high" });
const stop = ask({ kind: "stop", text: "Finished the refactor. What next?" });
const notify = ask({ kind: "notify", text: "Tests pass." });

function answer(input: Partial<SmsAnswerInput> & Pick<SmsAnswerInput, "ask" | "body">) {
  return smsAnswer({ messageSid: SID, receivedAt: RECEIVED, ...input });
}

function decision(input: Partial<SmsAnswerInput> & Pick<SmsAnswerInput, "ask" | "body">) {
  const result = answer(input);
  return result.outcome === "answered" ? result.answer.decision : undefined;
}

describe("parseSmsReply", () => {
  it.each([
    ["call me", { type: "command", command: "call-me" }],
    ["Call me!", { type: "command", command: "call-me" }],
    ["CALL", { type: "command", command: "call-me" }],
    ["status", { type: "command", command: "status" }],
    [" Status? ", { type: "command", command: "status" }],
    ["stop", { type: "command", command: "stop" }],
    ["STOP", { type: "command", command: "stop" }],
    ["unsubscribe", { type: "command", command: "stop" }],
    ["cancel", { type: "command", command: "stop" }],
    ["end", { type: "command", command: "stop" }],
    ["quit", { type: "command", command: "stop" }],
    ["start", { type: "carrier-keyword" }],
    ["HELP", { type: "carrier-keyword" }],
    ["2", { type: "option", option: 2 }],
    ["#3", { type: "option", option: 3 }],
    ["1.", { type: "option", option: 1 }],
    ["yes", { type: "yes" }],
    ["Y", { type: "yes" }],
    ["Yes!", { type: "yes" }],
    ["approve", { type: "yes" }],
    ["yes 482913", { type: "yes", code: "482913" }],
    ["no", { type: "no" }],
    ["Nope.", { type: "no" }],
    ["deny", { type: "no" }],
    ["done", { type: "done" }],
    ["That’s it", { type: "done" }],
  ])("reads %j", (body, expected) => {
    expect(parseSmsReply(body)).toEqual(expected);
  });

  it.each([
    "0",
    "10",
    "22",
    "ok",
    "yes please",
    "yes but do not push",
    "not yes",
    "yes no",
    "yes 12",
    "yes 482913 now",
    "no yes",
    "call me later",
    "stop the build",
    "",
    "   ",
  ])("keeps %j as free text, verbatim", (body) => {
    expect(parseSmsReply(body)).toEqual({ type: "text", text: body });
  });
});

describe("smsAnswer", () => {
  it("answers a question with an offered option number", () => {
    const result = answer({ ask: question, body: "2" });
    expect(result.outcome).toBe("answered");
    if (result.outcome !== "answered") return;
    expect(Answer.parse(result.answer)).toEqual({
      askId: "ask-1",
      decision: { type: "option", option: 2 },
      channel: "sms",
      ownerExcerpt: "2",
      sourceId: SID,
      confirmation: "none",
      answeredAt: RECEIVED.toISOString(),
    });
  });

  it("refuses an option the question did not offer", () => {
    expect(answer({ ask: question, body: "4" })).toEqual({
      outcome: "no-answer",
      reason: "option is not one the ask offered",
    });
  });

  it("answers a question with the owner's exact words", () => {
    const body = "  Use SQLite for now, Postgres later. ";
    expect(decision({ ask: question, body })).toEqual({ type: "text", text: body });
    expect(decision({ ask: openQuestion, body: "yes" })).toEqual({ type: "text", text: "yes" });
    expect(decision({ ask: openQuestion, body: "3" })).toEqual({ type: "text", text: "3" });
  });

  it("allows a low-risk permission only on a clear yes", () => {
    expect(decision({ ask: permission, body: "Yes" })).toEqual({ type: "allow" });
    expect(decision({ ask: permission, body: "no" })).toEqual({ type: "deny" });
  });

  it.each([
    "ok",
    "sure, go ahead",
    "yes but not on main",
    "not yes",
    "1",
    "done",
    "y e s",
    "yes 12",
    "",
    "call me",
    "status",
    "stop",
    "help",
  ])("never approves a permission on %j", (body) => {
    const result = answer({ ask: permission, body });
    expect(result.outcome === "answered" && result.answer.decision.type === "allow").toBe(false);
  });

  it("needs the confirmation code for a high-risk approval", () => {
    expect(answer({ ask: risky, body: "yes", confirmationCode: "482913" })).toEqual({
      outcome: "no-answer",
      reason: "a high-risk approval needs the confirmation code from the text",
    });
    expect(answer({ ask: risky, body: "yes 482914", confirmationCode: "482913" }).outcome).toBe("no-answer");
    expect(answer({ ask: risky, body: "yes 4829130", confirmationCode: "482913" }).outcome).toBe("no-answer");
    // A code without one on record is never a match.
    expect(answer({ ask: risky, body: "yes 482913" }).outcome).toBe("no-answer");

    const result = answer({ ask: risky, body: "YES 482913", confirmationCode: "482913" });
    expect(result.outcome).toBe("answered");
    if (result.outcome !== "answered") return;
    expect(result.answer.decision).toEqual({ type: "allow" });
    expect(result.answer.confirmation).toBe("text");
    expect(result.answer.ownerExcerpt).toBe("YES 482913");
  });

  it("denies a high-risk permission without a code", () => {
    expect(decision({ ask: risky, body: "no" })).toEqual({ type: "deny" });
  });

  it("refuses a wrong code on a low-risk ask rather than ignoring it", () => {
    expect(answer({ ask: permission, body: "yes 111111", confirmationCode: "482913" }).outcome).toBe(
      "no-answer",
    );
  });

  it("turns a stop reply into the next instruction or done", () => {
    expect(decision({ ask: stop, body: "Now write the docs" })).toEqual({
      type: "text",
      text: "Now write the docs",
    });
    expect(decision({ ask: stop, body: "that's it" })).toEqual({ type: "done" });
    expect(decision({ ask: stop, body: "no" })).toEqual({ type: "done" });
    expect(answer({ ask: stop, body: "yes" }).outcome).toBe("no-answer");
  });

  it("takes no answer for a notification", () => {
    expect(answer({ ask: notify, body: "thanks" }).outcome).toBe("no-answer");
  });

  it("treats commands and carrier keywords as no answer", () => {
    for (const body of ["call me", "status", "STOP", "start", "help"]) {
      expect(answer({ ask: question, body }).outcome).toBe("no-answer");
      expect(answer({ ask: stop, body }).outcome).toBe("no-answer");
    }
  });

  it("refuses empty, oversized and late messages, and closed asks", () => {
    expect(answer({ ask: question, body: "   " }).outcome).toBe("no-answer");
    expect(answer({ ask: question, body: "x".repeat(2001) }).outcome).toBe("no-answer");
    expect(answer({ ask: question, body: "1", receivedAt: new Date(EXPIRES) }).outcome).toBe("no-answer");
    expect(answer({ ask: question, body: "1", receivedAt: new Date(Number.NaN) }).outcome).toBe("no-answer");
    expect(answer({ ask: ask({ status: "answered" }), body: "fine" }).outcome).toBe("no-answer");
  });

  it("never yields an approval from anything but a yes word, over many generated replies", () => {
    const pieces = [
      "yes",
      "no",
      "ok",
      "1",
      "2",
      "please",
      "not",
      "y",
      "approve",
      "482913",
      "!",
      " ",
      "?",
      "stop",
    ];
    let approvals = 0;
    for (const a of pieces) {
      for (const b of pieces) {
        for (const c of ["", " ", "."]) {
          const body = `${a}${c}${b}`;
          for (const target of [permission, risky]) {
            const result = answer({ ask: target, body, confirmationCode: "482913" });
            if (result.outcome !== "answered" || result.answer.decision.type !== "allow") continue;
            approvals++;
            const reply = parseSmsReply(body);
            expect(reply.type).toBe("yes");
            if (target.risk === "high") expect(result.answer.confirmation).toBe("text");
          }
        }
      }
    }
    expect(approvals).toBeGreaterThan(0);
  });
});
