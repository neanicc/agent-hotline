import { describe, expect, it } from "vitest";
import { AskOutcome, createQueue, nextWakeAt, permissionVerdict, step } from "../src/index.js";
import {
  Harness,
  HOUR,
  MINUTE,
  makeAnswer,
  makeAsk,
  makeSettings,
  NIGHT,
  NOON,
  ofType,
  SECOND,
} from "./queue-harness.js";

const settings = makeSettings();

describe("batching and priority", () => {
  it("holds the first ask for the batch window, then calls once for every ask, by priority", () => {
    const h = new Harness(settings);
    expect(h.ask({ id: "q1" })).toEqual([]);
    h.now += 5 * SECOND;
    expect(h.ask({ id: "p1", kind: "permission", sessionId: "session-2" })).toEqual([]);
    expect(h.advance(14 * SECOND)).toEqual([]);
    expect(h.advance(1 * SECOND)).toEqual([{ type: "place-call", callId: "test-1", askIds: ["p1", "q1"] }]);
    expect(h.state.open.map((q) => [q.ask.id, q.phase, q.ask.status])).toEqual([
      ["q1", "calling", "in-flight"],
      ["p1", "calling", "in-flight"],
    ]);
  });

  it("calls at once with a zero batch window", () => {
    const h = new Harness(makeSettings({ batchWindowSeconds: 0 }));
    expect(ofType(h.ask({ id: "q1" }), "place-call")).toHaveLength(1);
  });

  it("puts urgent asks first and reads at most maxAsksPerCall per call", () => {
    const h = new Harness(settings);
    for (const id of ["a", "b", "c", "d"]) h.ask({ id, text: `Ask ${id}?` });
    h.ask({ id: "stop", kind: "stop", text: "What next?" });
    h.ask({ id: "urgent", text: "Urgent?", urgent: true });
    const [call] = ofType(h.advance(20 * SECOND), "place-call");
    expect(call?.askIds).toEqual(["urgent", "a", "b", "c"]);
    // A new ask arriving during the call waits for it to end.
    h.ask({ id: "e", text: "Ask e?" });
    expect(h.advance(30 * SECOND)).toEqual([]);
    for (const id of ["urgent", "a", "b", "c"]) {
      h.send({ type: "answer", answer: makeAnswer(id, { type: "option", option: 1 }, h.now) });
    }
    const after = h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    expect(ofType(after, "place-call")).toEqual([
      { type: "place-call", callId: "test-2", askIds: ["d", "e", "stop"] },
    ]);
  });
});

describe("dedupe", () => {
  it("joins an identical question from the same session to the first and answers both", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", text: "Pin the older version?" });
    h.ask({ id: "q2", text: "Pin the older version?" });
    expect(h.state.open.find((q) => q.ask.id === "q2")?.duplicateOf).toBe("q1");
    expect(ofType(h.advance(20 * SECOND), "place-call")[0]?.askIds).toEqual(["q1"]);
    const given = makeAnswer("q1", { type: "option", option: 2 }, h.now, { confirmation: "pin" });
    const resolved = ofType(h.send({ type: "answer", answer: given }), "resolve");
    expect(resolved.map((r) => [r.askId, r.outcome.outcome, r.status])).toEqual([
      ["q1", "answered", "answered"],
      ["q2", "answered", "answered"],
    ]);
    // The shared answer is the owner's decision for q2, but never carries q1's confirmation.
    expect(resolved[1]?.outcome).toEqual({
      outcome: "answered",
      answer: { ...given, askId: "q2", confirmation: "none" },
    });
  });

  it("never joins permission requests: each needs its own answer", () => {
    const h = new Harness(settings);
    const spec = { kind: "permission", text: "Run: rm -rf [redacted]", risk: "high" } as const;
    const p1 = makeAsk({ id: "p1", ...spec, createdAt: h.now });
    const p2 = makeAsk({ id: "p2", ...spec, createdAt: h.now });
    h.send({ type: "ask", ask: p1 });
    h.send({ type: "ask", ask: p2 });
    expect(h.state.open.every((q) => q.duplicateOf === undefined)).toBe(true);
    // Batched into one call, but read out and decided separately.
    expect(ofType(h.advance(20 * SECOND), "place-call")[0]?.askIds).toEqual(["p1", "p2"]);
    const allow = makeAnswer("p1", { type: "allow" }, h.now, { confirmation: "pin" });
    const resolved = ofType(h.send({ type: "answer", answer: allow }), "resolve");
    expect(resolved.map((r) => r.askId)).toEqual(["p1"]);
    expect(resolved[0] && permissionVerdict(p1, resolved[0].outcome)).toBe("allow");
    expect(h.state.open.map((q) => q.ask.id)).toEqual(["p2"]);
    h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    const [p2End] = ofType(h.advance(30 * MINUTE), "resolve");
    expect(p2End?.outcome).toEqual({ outcome: "no-answer", askId: "p2", reason: "timeout" });
    expect(p2End && permissionVerdict(p2, p2End.outcome)).toBe("deny");
  });

  it("never joins stop prompts", () => {
    const h = new Harness(settings);
    h.ask({ id: "s1", kind: "stop", text: "Done. What next?" });
    h.ask({ id: "s2", kind: "stop", text: "Done. What next?" });
    expect(h.state.open.every((q) => q.duplicateOf === undefined)).toBe(true);
  });

  it("does not join asks from different sessions or with different text", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", text: "Same?" });
    h.ask({ id: "q2", text: "Same?", sessionId: "session-2" });
    h.ask({ id: "q3", text: "Different?" });
    expect(h.state.open.every((q) => q.duplicateOf === undefined)).toBe(true);
  });

  it("refuses an answer addressed to the duplicate", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", text: "Same?" });
    h.ask({ id: "q2", text: "Same?" });
    h.advance(20 * SECOND);
    const actions = h.send({
      type: "answer",
      answer: makeAnswer("q2", { type: "option", option: 1 }, h.now),
    });
    expect(actions).toEqual([
      { type: "ignored", event: "answer", askId: "q2", reason: "the ask shares q1's answer" },
    ]);
  });

  it("promotes the duplicate when the first ask is cancelled", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", text: "Same?" });
    h.ask({ id: "q2", text: "Same?" });
    h.ask({ id: "q3", text: "Same?" });
    h.advance(20 * SECOND);
    const cancelled = h.send({ type: "cancel", askId: "q1" });
    expect(ofType(cancelled, "resolve")).toEqual([
      {
        type: "resolve",
        askId: "q1",
        outcome: { outcome: "no-answer", askId: "q1", reason: "cancelled" },
        status: "cancelled",
      },
    ]);
    expect(h.state.open.find((q) => q.ask.id === "q3")?.duplicateOf).toBe("q2");
    h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    expect(ofType(h.allActions, "place-call").at(-1)?.askIds).toEqual(["q2"]);
  });

  it("shares an unclear result with duplicates", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", text: "Same?" });
    h.ask({ id: "q2", text: "Same?" });
    h.advance(20 * SECOND);
    const actions = h.send({ type: "unclear", askId: "q1" });
    expect(ofType(actions, "resolve").map((r) => r.outcome)).toEqual([
      { outcome: "no-answer", askId: "q1", reason: "unclear" },
      { outcome: "no-answer", askId: "q2", reason: "unclear" },
    ]);
  });
});

describe("quiet hours", () => {
  it("texts instead of calling", () => {
    const h = new Harness(settings, NIGHT);
    h.ask({ id: "q1" });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q1", reason: "quiet-hours" }]);
    expect(h.state.open[0]?.phase).toBe("texted");
  });

  it("calls for an urgent ask only when urgent calls are allowed, and only for urgent asks", () => {
    const strict = new Harness(settings, NIGHT);
    strict.ask({ id: "u1", urgent: true });
    expect(strict.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "u1", reason: "quiet-hours" }]);

    const relaxed = new Harness(makeSettings({ allowUrgentCalls: true }), NIGHT);
    relaxed.ask({ id: "u1", urgent: true });
    relaxed.ask({ id: "q1" });
    expect(relaxed.advance(20 * SECOND)).toEqual([
      { type: "place-call", callId: "test-1", askIds: ["u1"] },
      { type: "send-text", askId: "q1", reason: "quiet-hours" },
    ]);
  });
});

describe("notifications", () => {
  it("go out by text once, duplicates included, and are delivered when the text is sent", () => {
    const h = new Harness(settings);
    h.ask({ id: "n1", kind: "notify", text: "Tests pass." });
    h.ask({ id: "n2", kind: "notify", text: "Tests pass." });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "n1", reason: "notify" }]);
    expect(h.state.open).toHaveLength(2);
    expect(h.send({ type: "text-sent", askId: "n1" })).toEqual([
      { type: "delivered", askId: "n1" },
      { type: "delivered", askId: "n2" },
    ]);
    expect(h.state.open).toEqual([]);
  });

  it("are not delivered when the text fails; the duplicate is tried next", () => {
    const h = new Harness(settings);
    h.ask({ id: "n1", kind: "notify", text: "Tests pass." });
    h.ask({ id: "n2", kind: "notify", text: "Tests pass." });
    h.advance(20 * SECOND);
    expect(h.send({ type: "text-failed", askId: "n1" })).toEqual([
      {
        type: "resolve",
        askId: "n1",
        outcome: { outcome: "no-answer", askId: "n1", reason: "failed" },
        status: "expired",
      },
      { type: "send-text", askId: "n2", reason: "notify" },
    ]);
    expect(ofType(h.allActions, "delivered")).toEqual([]);
  });
});

describe("rate limits", () => {
  it("texts once the hourly call limit is used up, and calls again an hour later", () => {
    const h = new Harness(makeSettings({ rateLimits: { callsPerHour: 1 } }));
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.send({ type: "answer", answer: makeAnswer("q1", { type: "option", option: 2 }, h.now) });
    h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    h.ask({ id: "q2" });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q2", reason: "call-limit" }]);
    h.now = NOON + HOUR + 20 * SECOND;
    h.ask({ id: "q3" });
    expect(ofType(h.advance(20 * SECOND), "place-call")).toHaveLength(1);
  });

  it("holds asks when texts run out too, wakes when a slot frees, and times out unanswered", () => {
    const h = new Harness(makeSettings({ rateLimits: { textsPerHour: 1 } }), NIGHT);
    h.ask({ id: "q1", ttlMs: 2 * HOUR });
    h.ask({ id: "q2", ttlMs: 30 * MINUTE });
    h.ask({ id: "q3", ttlMs: 2 * HOUR });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q1", reason: "quiet-hours" }]);
    expect(nextWakeAt(h.state, new Date(h.now), h.settings)?.getTime()).toBe(NIGHT + 30 * MINUTE);
    const expired = h.advance(30 * MINUTE - 20 * SECOND);
    expect(ofType(expired, "resolve").map((r) => r.outcome)).toEqual([
      { outcome: "no-answer", askId: "q2", reason: "timeout" },
    ]);
    expect(nextWakeAt(h.state, new Date(h.now), h.settings)?.getTime()).toBe(NIGHT + 20 * SECOND + HOUR);
    h.now = NIGHT + 20 * SECOND + HOUR;
    expect(h.send({ type: "tick" })).toEqual([{ type: "send-text", askId: "q3", reason: "quiet-hours" }]);
  });

  it("counts calls over a rolling day", () => {
    const h = new Harness(makeSettings({ rateLimits: { callsPerHour: 5, callsPerDay: 2 } }));
    for (const id of ["q1", "q2"]) {
      h.ask({ id });
      h.advance(20 * SECOND);
      h.send({ type: "call-ended", callId: h.callId, result: "answered" });
      h.advance(2 * HOUR);
    }
    h.ask({ id: "q3" });
    expect(ofType(h.advance(20 * SECOND), "send-text")).toEqual([
      { type: "send-text", askId: "q3", reason: "call-limit" },
    ]);
  });
});

describe("no pickup, dropped and stuck calls", () => {
  it("retries once after the delay, then texts, and a text reply resolves the ask", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    expect(h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" })).toEqual([]);
    expect(nextWakeAt(h.state, new Date(h.now), settings)?.getTime()).toBe(h.now + 2 * MINUTE);
    expect(h.advance(2 * MINUTE)).toEqual([{ type: "place-call", callId: "test-2", askIds: ["q1"] }]);
    expect(h.send({ type: "call-ended", callId: "test-2", result: "no-pickup" })).toEqual([
      { type: "send-text", askId: "q1", reason: "after-call" },
    ]);
    const answered = h.send({
      type: "answer",
      answer: makeAnswer("q1", { type: "option", option: 2 }, h.now, { channel: "sms" }),
    });
    expect(ofType(answered, "resolve")[0]?.outcome.outcome).toBe("answered");
  });

  it("reports no pickup when the texted ask then expires", () => {
    const h = new Harness(makeSettings({}, { maxCallAttempts: 1 }));
    h.ask({ id: "p1", kind: "permission" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: h.callId, result: "no-pickup" });
    const [resolved] = ofType(h.advance(30 * MINUTE), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "no-answer", askId: "p1", reason: "no-pickup" });
    expect(resolved?.status).toBe("expired");
  });

  it("texts at once after a dropped call", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    expect(h.send({ type: "call-ended", callId: h.callId, result: "dropped" })).toEqual([
      { type: "send-text", askId: "q1", reason: "after-call" },
    ]);
    const [resolved] = ofType(h.advance(30 * MINUTE), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "no-answer", askId: "q1", reason: "dropped" });
  });

  it("treats a call never reported as ended as dropped", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", ttlMs: HOUR });
    h.advance(20 * SECOND);
    expect(nextWakeAt(h.state, new Date(h.now), settings)?.getTime()).toBe(h.now + 15 * MINUTE);
    expect(h.advance(15 * MINUTE)).toEqual([
      { type: "end-call", callId: "test-1" },
      { type: "send-text", askId: "q1", reason: "after-call" },
    ]);
    expect(h.state.call).toBeUndefined();
  });

  it("keeps a retry waiting out its delay when another ask starts a call", () => {
    const h = new Harness(settings);
    h.ask({ id: "a", kind: "permission", text: "Run: make" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" });
    h.ask({ id: "b" });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "place-call", callId: "test-2", askIds: ["b"] }]);
    h.send({ type: "call-ended", callId: "test-2", result: "answered" });
    h.now = NOON + 20 * SECOND + 2 * MINUTE;
    expect(ofType(h.send({ type: "tick" }), "place-call")).toEqual([
      { type: "place-call", callId: "test-3", askIds: ["a"] },
    ]);
  });

  it("ignores the end of a call that is not in progress", () => {
    const h = new Harness(settings);
    expect(h.send({ type: "call-ended", callId: "test-9", result: "answered" })).toEqual([
      { type: "ignored", event: "call-ended", callId: "test-9", reason: "not the call in progress" },
    ]);
  });

  it("fails a texted ask whose text could not be sent", () => {
    const h = new Harness(settings, NIGHT);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    const [resolved] = ofType(h.send({ type: "text-failed", askId: "q1" }), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "no-answer", askId: "q1", reason: "failed" });
  });
});

describe("answers", () => {
  it("records an unclear answer as no answer, which denies a permission request", () => {
    const h = new Harness(settings);
    const ask = makeAsk({ id: "p1", kind: "permission", createdAt: h.now });
    h.send({ type: "ask", ask });
    h.advance(20 * SECOND);
    const [resolved] = ofType(h.send({ type: "unclear", askId: "p1" }), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "no-answer", askId: "p1", reason: "unclear" });
    expect(resolved && permissionVerdict(ask, resolved.outcome)).toBe("deny");
  });

  it("ignores an unclear report for an ask never put to the owner", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    expect(h.send({ type: "unclear", askId: "q1" })).toEqual([
      {
        type: "ignored",
        event: "unclear",
        askId: "q1",
        reason: "the ask is not on a call or awaiting a text reply",
      },
    ]);
  });

  it("keeps a high-risk ask open on an unconfirmed yes and allows it with the PIN", () => {
    const h = new Harness(settings);
    const ask = makeAsk({ id: "p1", kind: "permission", risk: "high", createdAt: h.now });
    h.send({ type: "ask", ask });
    h.advance(20 * SECOND);
    expect(h.send({ type: "answer", answer: makeAnswer("p1", { type: "allow" }, h.now) })).toEqual([
      {
        type: "ignored",
        event: "answer",
        askId: "p1",
        reason: "a high-risk approval needs the PIN or a confirming text",
      },
    ]);
    expect(h.state.open).toHaveLength(1);
    const withPin = makeAnswer("p1", { type: "allow" }, h.now, { confirmation: "pin" });
    const [resolved] = ofType(h.send({ type: "answer", answer: withPin }), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "answered", answer: withPin });
    expect(resolved && permissionVerdict(ask, resolved.outcome)).toBe("allow");
  });

  it("accepts answers only on the channel the ask went out on", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    expect(
      h.send({ type: "answer", answer: makeAnswer("q1", { type: "option", option: 1 }, h.now) }),
    ).toEqual([
      { type: "ignored", event: "answer", askId: "q1", reason: "the ask is not on the call in progress" },
    ]);
    h.advance(20 * SECOND);
    const sms = makeAnswer("q1", { type: "option", option: 1 }, h.now, { channel: "sms" });
    expect(h.send({ type: "answer", answer: sms })).toEqual([
      { type: "ignored", event: "answer", askId: "q1", reason: "the ask was never texted" },
    ]);
  });

  it("rejects a malformed answer and an answer for an unknown ask", () => {
    const h = new Harness(settings);
    const bogus = { ...makeAnswer("q1", { type: "allow" }, h.now), ownerExcerpt: "   " };
    expect(h.send({ type: "answer", answer: bogus })).toEqual([
      { type: "ignored", event: "answer", askId: "q1", reason: "not a valid answer" },
    ]);
    expect(h.send({ type: "answer", answer: makeAnswer("nope", { type: "deny" }, h.now) })).toEqual([
      { type: "ignored", event: "answer", askId: "nope", reason: "no open ask with this id" },
    ]);
  });
});

describe("expiry and cancellation", () => {
  it("returns timeout at expiresAt and refuses a later answer", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", ttlMs: 10 * MINUTE });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    const [resolved] = ofType(h.advance(10 * MINUTE - 20 * SECOND), "resolve");
    expect(resolved).toEqual({
      type: "resolve",
      askId: "q1",
      outcome: { outcome: "no-answer", askId: "q1", reason: "timeout" },
      status: "expired",
    });
    expect(
      ofType(
        h.send({ type: "answer", answer: makeAnswer("q1", { type: "option", option: 1 }, h.now) }),
        "resolve",
      ),
    ).toEqual([]);
  });

  it("expires an ask that arrives already expired", () => {
    const h = new Harness(settings);
    const ask = makeAsk({ id: "q1", createdAt: h.now - HOUR, ttlMs: MINUTE });
    expect(ofType(h.send({ type: "ask", ask }), "resolve")[0]?.outcome).toEqual({
      outcome: "no-answer",
      askId: "q1",
      reason: "timeout",
    });
  });

  it("resolves an ask that expires mid-call, keeps the call for the rest, and ignores a late answer", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1", ttlMs: 2 * MINUTE });
    h.ask({ id: "q2", text: "Other?", ttlMs: HOUR });
    h.advance(20 * SECOND);
    const callId = h.callId;
    const [expired] = ofType(h.advance(2 * MINUTE), "resolve");
    expect(expired).toMatchObject({ askId: "q1", outcome: { outcome: "no-answer", reason: "timeout" } });
    expect(h.state.call?.id).toBe(callId);
    const late = makeAnswer("q1", { type: "option", option: 1 }, h.now);
    expect(h.send({ type: "answer", answer: late })).toEqual([
      { type: "ignored", event: "answer", askId: "q1", reason: "no open ask with this id" },
    ]);
    const answered = h.send({
      type: "answer",
      answer: makeAnswer("q2", { type: "option", option: 2 }, h.now),
    });
    expect(ofType(answered, "resolve")[0]?.outcome.outcome).toBe("answered");
  });

  it("cancels an ask in a call and ignores it when the call ends", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    expect(ofType(h.send({ type: "cancel", askId: "q1" }), "resolve")[0]?.status).toBe("cancelled");
    expect(h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" })).toEqual([]);
    expect(h.state).toEqual({ ...createQueue("test"), callSeq: 1, callTimes: [NOON + 20 * SECOND] });
  });
});

describe("enqueue checks", () => {
  it("ignores an ask that is not pending, already queued or invalid", () => {
    const h = new Harness(settings);
    const ask = makeAsk({ id: "q1", createdAt: h.now });
    expect(h.send({ type: "ask", ask: { ...ask, status: "answered" } })).toEqual([
      { type: "ignored", event: "ask", askId: "q1", reason: "a new ask must be pending, not answered" },
    ]);
    h.send({ type: "ask", ask });
    expect(h.send({ type: "ask", ask })).toEqual([
      { type: "ignored", event: "ask", askId: "q1", reason: "already queued" },
    ]);
    expect(h.send({ type: "ask", ask: { ...ask, id: "q2", options: ["same", "same"] } })).toEqual([
      { type: "ignored", event: "ask", askId: "q2", reason: "not a valid ask" },
    ]);
  });
});

describe("call me", () => {
  const callMe = { type: "call-me" } as const;

  it("calls at once about the open asks, by priority, without waiting out the batch window", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.ask({ id: "p1", kind: "permission", sessionId: "session-2" });
    h.ask({ id: "n1", kind: "notify", text: "Tests pass." });
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-1", askIds: ["p1", "q1"] }]);
    expect(h.state.open.map((q) => [q.ask.id, q.phase, q.ask.status, q.callAttempts])).toEqual([
      ["q1", "calling", "in-flight", 1],
      ["p1", "calling", "in-flight", 1],
      ["n1", "waiting", "pending", 0],
    ]);
    // The notification still goes by text once its batch window ends.
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "n1", reason: "notify" }]);
  });

  it("calls about an ask already texted; the owner can answer on the call or still by text", () => {
    const h = new Harness(makeSettings({}, { maxCallAttempts: 1 }));
    h.ask({ id: "q1" });
    h.ask({ id: "q2", text: "Second question?" });
    h.advance(20 * SECOND);
    expect(h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" })).toEqual([
      { type: "send-text", askId: "q1", reason: "after-call" },
      { type: "send-text", askId: "q2", reason: "after-call" },
    ]);
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-2", askIds: ["q1", "q2"] }]);
    const voice = h.send({
      type: "answer",
      answer: makeAnswer("q1", { type: "option", option: 1 }, h.now, { channel: "voice" }),
    });
    expect(ofType(voice, "resolve").map((r) => [r.askId, r.outcome.outcome])).toEqual([["q1", "answered"]]);
    // The call ends with q2 open: it goes back to awaiting the text it already has, with no new text.
    expect(h.send({ type: "call-ended", callId: "test-2", result: "answered" })).toEqual([]);
    expect(h.state.open.map((q) => [q.ask.id, q.phase])).toEqual([["q2", "texted"]]);
    const sms = h.send({
      type: "answer",
      answer: makeAnswer("q2", { type: "option", option: 2 }, h.now, { channel: "sms" }),
    });
    expect(ofType(sms, "resolve").map((r) => [r.askId, r.outcome.outcome])).toEqual([["q2", "answered"]]);
  });

  it("calls about an ask waiting out its retry delay", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" });
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-2", askIds: ["q1"] }]);
  });

  it("is ignored while a call is in progress", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.ask({ id: "q2", text: "Second question?" });
    expect(h.send(callMe)).toEqual([
      { type: "ignored", event: "call-me", reason: "a call is already in progress" },
    ]);
    expect(h.state.call?.askIds).toEqual(["q1"]);
    expect(h.state.callTimes).toHaveLength(1);

    // The reason is the live call even when every open ask is already on it.
    const busy = new Harness(settings);
    busy.ask({ id: "q1" });
    busy.advance(20 * SECOND);
    expect(busy.send(callMe)).toEqual([
      { type: "ignored", event: "call-me", reason: "a call is already in progress" },
    ]);
  });

  it("hangs up a call already given up on as stuck, then calls", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.now += 15 * MINUTE;
    expect(h.send(callMe)).toEqual([
      { type: "end-call", callId: "test-1" },
      { type: "place-call", callId: "test-2", askIds: ["q1"] },
    ]);
  });

  it("overrides quiet hours for that one call only", () => {
    const h = new Harness(settings, NIGHT);
    h.ask({ id: "q1" });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q1", reason: "quiet-hours" }]);
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-1", askIds: ["q1"] }]);
    // Not picked up: no retry call in quiet hours; the ask keeps waiting on its text.
    expect(h.send({ type: "call-ended", callId: "test-1", result: "no-pickup" })).toEqual([]);
    expect(h.advance(10 * MINUTE)).toEqual([]);
    // A new ask is texted, not called: the override covered one call.
    h.ask({ id: "q2", text: "Second question?" });
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q2", reason: "quiet-hours" }]);
    expect(ofType(h.allActions, "place-call")).toHaveLength(1);
  });

  it("keeps texting over the call limit, and says why", () => {
    const h = new Harness(makeSettings({ rateLimits: { callsPerHour: 1 } }));
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: h.callId, result: "answered" });
    h.ask({ id: "q2", text: "Second question?" });
    expect(h.send(callMe)).toEqual([
      { type: "ignored", event: "call-me", reason: "over the call limit; open asks keep going by text" },
    ]);
    expect(h.advance(20 * SECOND)).toEqual([{ type: "send-text", askId: "q2", reason: "call-limit" }]);
    expect(h.state.callTimes).toHaveLength(1);
  });

  it("is ignored with nothing open to call about", () => {
    const empty = new Harness(settings);
    const ignored = { type: "ignored", event: "call-me", reason: "no open asks to call about" };
    expect(empty.send(callMe)).toEqual([ignored]);
    expect(empty.state).toEqual(createQueue("test"));

    // A notification needs no answer, so it is not worth a call.
    const notified = new Harness(settings);
    notified.ask({ id: "n1", kind: "notify", text: "Tests pass." });
    expect(notified.send(callMe)).toEqual([ignored]);

    // An ask past its expiry (no tick since) is ended, not called about.
    const late = new Harness(settings);
    late.ask({ id: "q1", ttlMs: 5 * MINUTE });
    late.now += 5 * MINUTE;
    expect(late.send(callMe)).toEqual([
      ignored,
      {
        type: "resolve",
        askId: "q1",
        outcome: { outcome: "no-answer", askId: "q1", reason: "timeout" },
        status: "expired",
      },
    ]);
  });

  it("is never an answer: a call-me call that ends without one still denies", () => {
    const h = new Harness(settings);
    const p1 = makeAsk({ id: "p1", kind: "permission", risk: "high", createdAt: h.now });
    h.send({ type: "ask", ask: p1 });
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-1", askIds: ["p1"] }]);
    expect(ofType(h.send(callMe), "ignored")).toHaveLength(1);
    expect(h.send({ type: "call-ended", callId: "test-1", result: "answered" })).toEqual([
      { type: "send-text", askId: "p1", reason: "after-call" },
    ]);
    // Asked again after the text: a second call, not picked up. Still no decision.
    expect(h.send(callMe)).toEqual([{ type: "place-call", callId: "test-2", askIds: ["p1"] }]);
    expect(h.send({ type: "call-ended", callId: "test-2", result: "no-pickup" })).toEqual([]);
    const [resolved] = ofType(h.advance(30 * MINUTE), "resolve");
    expect(resolved?.outcome).toEqual({ outcome: "no-answer", askId: "p1", reason: "no-pickup" });
    expect(resolved && permissionVerdict(p1, resolved.outcome)).toBe("deny");
  });
});

describe("purity", () => {
  it("does not modify the state it is given and returns the same result for the same input", () => {
    const state = Object.freeze(createQueue("test"));
    const event = { type: "ask", ask: makeAsk({ id: "q1", createdAt: NOON }) } as const;
    const first = step(state, event, new Date(NOON), makeSettings({ batchWindowSeconds: 0 }));
    const second = step(state, event, new Date(NOON), makeSettings({ batchWindowSeconds: 0 }));
    expect(first).toEqual(second);
    expect(state).toEqual(createQueue("test"));
  });

  it("refuses an invalid clock reading", () => {
    expect(() => step(createQueue(), { type: "tick" }, new Date(Number.NaN), settings)).toThrow(RangeError);
  });

  it("has nothing to wake for when empty", () => {
    expect(nextWakeAt(createQueue(), new Date(NOON), settings)).toBeUndefined();
  });
});

describe("permissionVerdict", () => {
  const low = makeAsk({ id: "p1", kind: "permission", createdAt: NOON });
  const high = makeAsk({ id: "p1", kind: "permission", risk: "high", createdAt: NOON });
  const allow = (confirmation: "none" | "pin" | "text") =>
    AskOutcome.parse({
      outcome: "answered",
      answer: makeAnswer("p1", { type: "allow" }, NOON, { confirmation }),
    });

  it("allows only an owner approval of this ask, confirmed when high risk", () => {
    expect(permissionVerdict(low, allow("none"))).toBe("allow");
    expect(permissionVerdict(high, allow("none"))).toBe("deny");
    expect(permissionVerdict(high, allow("pin"))).toBe("allow");
    expect(permissionVerdict(high, allow("text"))).toBe("allow");
    expect(permissionVerdict({ ...low, id: "p2" }, allow("pin"))).toBe("deny");
    expect(permissionVerdict(makeAsk({ id: "p1", createdAt: NOON }), allow("pin"))).toBe("deny");
    expect(
      permissionVerdict(
        low,
        AskOutcome.parse({ outcome: "answered", answer: makeAnswer("p1", { type: "deny" }, NOON) }),
      ),
    ).toBe("deny");
    for (const reason of ["timeout", "no-pickup", "unclear", "dropped", "failed", "cancelled"] as const) {
      expect(permissionVerdict(low, { outcome: "no-answer", askId: "p1", reason })).toBe("deny");
    }
  });

  it("denies a malformed outcome, such as one missing its confirmation", () => {
    const { confirmation: _dropped, ...answer } = makeAnswer("p1", { type: "allow" }, NOON);
    expect(permissionVerdict(high, { outcome: "answered", answer } as unknown as AskOutcome)).toBe("deny");
    expect(permissionVerdict(low, { outcome: "answered" } as unknown as AskOutcome)).toBe("deny");
  });
});

describe("review fixes", () => {
  it("ignores a voice answer that arrives after its call ended", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: h.callId, result: "dropped" });
    const late = makeAnswer("q1", { type: "option", option: 1 }, h.now);
    expect(h.send({ type: "answer", answer: late })).toEqual([
      { type: "ignored", event: "answer", askId: "q1", reason: "the ask is not on the call in progress" },
    ]);
  });

  it("ignores a stray unclear report while the ask waits out a retry", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.send({ type: "call-ended", callId: h.callId, result: "no-pickup" });
    expect(h.send({ type: "unclear", askId: "q1" })).toEqual([
      {
        type: "ignored",
        event: "unclear",
        askId: "q1",
        reason: "the ask is not on a call or awaiting a text reply",
      },
    ]);
    expect(ofType(h.advance(2 * MINUTE), "place-call")).toHaveLength(1);
  });

  it("wakes at once for overdue work, and never earlier than now", () => {
    const h = new Harness(settings);
    h.ask({ id: "q1" });
    // The daemon asks 21 s later instead of right after the step: the batch window is over.
    const late = new Date(h.now + 21 * SECOND);
    expect(nextWakeAt(h.state, late, settings)).toEqual(late);
    expect(nextWakeAt(h.state, new Date(h.now), settings)?.getTime()).toBe(h.now + 20 * SECOND);
  });

  it("keeps counting a send stamped in the future after the clock moves back", () => {
    const h = new Harness(makeSettings({ rateLimits: { textsPerHour: 1 } }), NIGHT);
    h.ask({ id: "q1" });
    h.advance(20 * SECOND);
    h.now = NIGHT - MINUTE; // the Mac's clock moved back
    h.ask({ id: "q2" });
    expect(ofType(h.advance(20 * SECOND), "send-text")).toEqual([]);
    expect(nextWakeAt(h.state, new Date(h.now), h.settings)?.getTime()).toBe(NIGHT + 29 * MINUTE); // q2 expires before a text slot frees
  });
});
