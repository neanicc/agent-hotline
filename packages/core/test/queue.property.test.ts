// Property tests for the ask queue: random asks, clocks, settings and provider events.
// The core claim: silence (no pickup, dropped or failed calls, unclear answers, failed
// texts, cancellation, timeouts) never yields an approval, and an `answered` outcome
// only ever carries an owner answer that passed `answerProblem` when it arrived. A
// `call me` text is part of the silent mix: it can place a call but never answers.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Ask,
  type AskKind,
  AskOutcome,
  answerProblem,
  type CallEnd,
  comparePriority,
  type Decision,
  inQuietHours,
  nextWakeAt,
  type PolicySettings,
  permissionVerdict,
} from "../src/index.js";
import { Harness, HOUR, MINUTE, makeAnswer, makeAsk, ofType } from "./queue-harness.js";

const DAY = 24 * HOUR;

const clock = fc.constantFrom("00:00", "06:30", "08:00", "12:00", "17:45", "22:00", "23:59");

const settingsArb: fc.Arbitrary<PolicySettings> = fc.record({
  quietHours: fc.record({
    start: clock,
    end: clock,
    timeZone: fc.constantFrom("America/Toronto", "UTC", "Asia/Kolkata", "Pacific/Auckland"),
    allowUrgentCalls: fc.boolean(),
  }),
  rateLimits: fc.record({
    callsPerHour: fc.integer({ min: 1, max: 3 }),
    callsPerDay: fc.integer({ min: 1, max: 5 }),
    textsPerHour: fc.integer({ min: 1, max: 3 }),
    textsPerDay: fc.integer({ min: 1, max: 6 }),
  }),
  batchWindowMs: fc.integer({ min: 0, max: 60_000 }),
  maxCallAttempts: fc.integer({ min: 1, max: 3 }),
  retryDelayMs: fc.integer({ min: 0, max: 10 * MINUTE }),
  maxAsksPerCall: fc.integer({ min: 1, max: 4 }),
  callStuckAfterMs: fc.constantFrom(5 * MINUTE, 15 * MINUTE),
});

type Command =
  | { kind: "advance"; ms: number }
  | {
      kind: "ask";
      session: number;
      askKind: AskKind;
      text: number;
      risk: "low" | "high";
      urgent: boolean;
      ttlMinutes: number;
    }
  | { kind: "call-ended"; result: CallEnd; current: boolean }
  | { kind: "unclear" | "text-sent" | "text-failed" | "cancel"; pick: number }
  | { kind: "call-me" }
  | {
      kind: "answer";
      pick: number;
      channel: "voice" | "sms";
      decision: Decision;
      confirmation: "none" | "pin" | "text";
      answeredOffsetMs: number;
      /** Aim at an ask the owner was actually asked, on its channel, with a decision of the right kind. */
      aimed: boolean;
    };

const silentCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      ms: fc.integer({ min: 0, max: 20 * MINUTE }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("ask" as const),
      session: fc.integer({ min: 0, max: 1 }),
      askKind: fc.constantFrom<AskKind>("question", "permission", "stop", "notify"),
      text: fc.integer({ min: 0, max: 2 }),
      risk: fc.constantFrom("low" as const, "high" as const),
      urgent: fc.boolean(),
      ttlMinutes: fc.integer({ min: 1, max: 120 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("call-ended" as const),
      result: fc.constantFrom<CallEnd>("answered", "no-pickup", "dropped", "failed"),
      current: fc.boolean(),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "unclear" as const,
        "text-sent" as const,
        "text-failed" as const,
        "cancel" as const,
      ),
      pick: fc.nat(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.constant({ kind: "call-me" as const }),
    weight: 1,
  },
);

const decisionArb: fc.Arbitrary<Decision> = fc.oneof(
  fc.record({ type: fc.constant("option" as const), option: fc.integer({ min: 1, max: 4 }) }),
  fc.constant({ type: "allow" as const }),
  fc.constant({ type: "deny" as const }),
  fc.constant({ type: "text" as const, text: "write the tests next" }),
  fc.constant({ type: "done" as const }),
);

const answerCommand: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant("answer" as const),
  pick: fc.nat(),
  channel: fc.constantFrom("voice" as const, "sms" as const),
  decision: decisionArb,
  confirmation: fc.constantFrom("none" as const, "pin" as const, "text" as const),
  answeredOffsetMs: fc.integer({ min: -10 * MINUTE, max: 0 }),
  aimed: fc.boolean(),
});

/** A decision of the kind `ask` accepts, chosen by `seed`. Confirmation still varies. */
function fittingDecision(ask: Ask, seed: number): Decision {
  switch (ask.kind) {
    case "permission":
      return seed % 2 === 0 ? { type: "allow" } : { type: "deny" };
    case "question":
      return seed % 4 === 3
        ? { type: "text", text: "neither, wait" }
        : { type: "option", option: (seed % 3) + 1 };
    default:
      return seed % 2 === 0 ? { type: "text", text: "write the tests next" } : { type: "done" };
  }
}

const START = fc.integer({
  min: Date.parse("2026-01-01T00:00:00Z"),
  max: Date.parse("2027-01-01T00:00:00Z"),
});

interface Run {
  h: Harness;
  asks: Map<string, Ask>;
}

function run(settings: PolicySettings, start: number, commands: Command[]): Run {
  const h = new Harness(settings, start);
  const asks = new Map<string, Ask>();
  const pick = (n: number) => `a${asks.size === 0 ? 0 : n % asks.size}`;
  for (const command of commands) {
    switch (command.kind) {
      case "advance":
        h.advance(command.ms);
        break;
      case "ask": {
        const id = `a${asks.size}`;
        const ask = makeAsk({
          id,
          kind: command.askKind,
          sessionId: `session-${command.session}`,
          text: `Ask number ${command.text}?`,
          options: ["One", "Two", "Three"],
          risk: command.risk,
          urgent: command.urgent,
          createdAt: h.now,
          ttlMs: command.ttlMinutes * MINUTE,
        });
        asks.set(id, ask);
        h.send({ type: "ask", ask });
        break;
      }
      case "call-ended":
        h.send({
          type: "call-ended",
          callId: command.current ? (h.state.call?.id ?? "test-0") : "test-0",
          result: command.result,
        });
        break;
      case "unclear":
      case "text-sent":
      case "text-failed":
      case "cancel":
        h.send({ type: command.kind, askId: pick(command.pick) });
        break;
      case "call-me":
        h.send({ type: "call-me" });
        break;
      case "answer": {
        const contacted = h.state.open.filter(
          (q) => q.duplicateOf === undefined && (q.callAttempts > 0 || q.texted),
        );
        const target = command.aimed ? contacted[command.pick % Math.max(contacted.length, 1)] : undefined;
        const askId = target?.ask.id ?? pick(command.pick);
        const channel = target === undefined ? command.channel : target.phase === "calling" ? "voice" : "sms";
        const decision = target === undefined ? command.decision : fittingDecision(target.ask, command.pick);
        h.send({
          type: "answer",
          answer: makeAnswer(askId, decision, h.now + command.answeredOffsetMs, {
            channel,
            confirmation: command.confirmation,
          }),
        });
        break;
      }
    }
  }
  // Run out the clock: every ask must end by its expiry.
  const lastExpiry = Math.max(h.now, ...[...asks.values()].map((ask) => Date.parse(ask.expiresAt)));
  h.advance(lastExpiry - h.now + 1);
  return { h, asks };
}

/** Invariants that hold for every run, answered or silent. */
function checkInvariants({ h, asks }: Run): void {
  const { settings } = h;
  const finals = new Map<string, number>();
  const callTimes: number[] = [];
  const textTimes: number[] = [];

  const within = (times: number[], at: number, window: number) =>
    times.filter((t) => t > at - window && t <= at).length;
  // How each ask's latest call ended and when, tracked from the events alone so the
  // retry-delay check does not rely on the queue's own `readyAt` bookkeeping.
  const lastCallEnd = new Map<string, { at: number; result: CallEnd }>();

  for (const entry of h.log) {
    const calls = ofType(entry.actions, "place-call");
    // A call that ends in this step ends before the step dispatches anything: by its
    // `call-ended` event, or hung up as stuck (`end-call`), which counts as dropped.
    const endingCall = entry.before.call;
    let endedNow: string[] = [];
    if (endingCall !== undefined) {
      const reported = entry.event.type === "call-ended" && entry.event.callId === endingCall.id;
      const hungUp = ofType(entry.actions, "end-call").some((action) => action.callId === endingCall.id);
      if (reported || hungUp) {
        const result = entry.event.type === "call-ended" && reported ? entry.event.result : "dropped";
        endedNow = endingCall.askIds;
        for (const askId of endedNow) lastCallEnd.set(askId, { at: entry.at, result });
      }
    }
    expect(calls.length).toBeLessThanOrEqual(1);
    // The owner texted `call me`: the calls that may happen now, by priority.
    const ownerAsked = entry.event.type === "call-me";
    const callMeAsks = entry.before.open
      .filter(
        (q) =>
          q.duplicateOf === undefined &&
          q.ask.kind !== "notify" &&
          (q.phase === "waiting" || q.phase === "texted") &&
          Date.parse(q.ask.expiresAt) > entry.at,
      )
      .sort((a, b) => comparePriority(a.ask, b.ask));
    if (
      ownerAsked &&
      callMeAsks.length > 0 &&
      entry.before.call === undefined &&
      within(callTimes, entry.at, HOUR) < settings.rateLimits.callsPerHour &&
      within(callTimes, entry.at, DAY) < settings.rateLimits.callsPerDay
    ) {
      // With an open ask, no call in progress and a call left, `call me` always calls now.
      expect(calls.map((call) => call.askIds)).toEqual([
        callMeAsks.slice(0, settings.maxAsksPerCall).map((q) => q.ask.id),
      ]);
    }
    for (const call of calls) {
      // Every action is fixed in shape: a call names asks, never a number to dial.
      expect(Object.keys(call).sort()).toEqual(["askIds", "callId", "type"]);
      // One call at a time: a new call only after the previous one ended or was given up on.
      const previous = entry.before.call;
      if (previous !== undefined) {
        const ended = entry.event.type === "call-ended" && entry.event.callId === previous.id;
        expect(ended || entry.at - previous.placedAt >= settings.callStuckAfterMs).toBe(true);
      }
      expect(call.askIds.length).toBeGreaterThan(0);
      expect(call.askIds.length).toBeLessThanOrEqual(settings.maxAsksPerCall);
      // A retry is never called before its delay is over; only new asks join early. The one
      // exception is a call the owner asked for, which may also call during quiet hours.
      for (const askId of call.askIds) {
        const q = entry.before.open.find((open) => open.ask.id === askId);
        if (ownerAsked || q === undefined || q.callAttempts === 0) continue;
        // Only a call that went unanswered (no pickup, failed) is retried by call, and not
        // before `retryDelayMs` has passed since it ended.
        const end = lastCallEnd.get(askId);
        expect(end?.result === "no-pickup" || end?.result === "failed").toBe(true);
        if (end !== undefined) expect(entry.at).toBeGreaterThanOrEqual(end.at + settings.retryDelayMs);
        // `before` is the state ahead of this step's event. When that event ended the ask's
        // last call, the queue set the retry's `readyAt` during this step, so the earlier
        // value (say, the end of a batch window the ask had joined the call inside) no
        // longer applies; the check above covers that case (issue #50).
        if (!endedNow.includes(askId)) expect(q.readyAt).toBeLessThanOrEqual(entry.at);
      }
      const quiet = inQuietHours(settings.quietHours, new Date(entry.at));
      for (const askId of call.askIds) {
        const ask = asks.get(askId);
        expect(ask?.kind).not.toBe("notify");
        if (quiet && !ownerAsked) expect(ask?.urgent && settings.quietHours.allowUrgentCalls).toBe(true);
      }
      if (ownerAsked) {
        // `call me` never interrupts a call in progress; one given up on as stuck is hung up first.
        const previous = entry.before.call;
        if (previous !== undefined) {
          expect(entry.at - previous.placedAt).toBeGreaterThanOrEqual(settings.callStuckAfterMs);
          expect(ofType(entry.actions, "end-call")).toEqual([{ type: "end-call", callId: previous.id }]);
        }
        for (const askId of call.askIds) expect(callMeAsks.map((q) => q.ask.id)).toContain(askId);
      }
      callTimes.push(entry.at);
    }
    for (const _text of ofType(entry.actions, "send-text")) textTimes.push(entry.at);

    for (const action of entry.actions) {
      if (action.type !== "resolve" && action.type !== "delivered") continue;
      finals.set(action.askId, (finals.get(action.askId) ?? 0) + 1);
      if (action.type === "delivered") {
        expect(asks.get(action.askId)?.kind).toBe("notify");
        // Delivered only once the daemon reported the text sent (for this ask or the one it duplicates).
        expect(entry.event.type).toBe("text-sent");
        const delivered = entry.before.open.find((q) => q.ask.id === action.askId);
        if (entry.event.type === "text-sent") {
          expect([action.askId, delivered?.duplicateOf]).toContain(entry.event.askId);
        }
        continue;
      }
      const outcome = AskOutcome.parse(action.outcome);
      if (outcome.outcome === "no-answer") {
        expect(outcome.askId).toBe(action.askId);
        expect(action.status).toBe(outcome.reason === "cancelled" ? "cancelled" : "expired");
        continue;
      }
      // An answer exists only because the owner's answer event arrived and checked out.
      expect(entry.event.type).toBe("answer");
      if (entry.event.type !== "answer") continue;
      expect(outcome.answer.askId).toBe(action.askId);
      expect(action.status).toBe("answered");
      const given = entry.event.answer;
      const sharedFromAnother = outcome.answer.askId !== given.askId;
      // The owner's own answer, unchanged, except that a shared copy never carries a confirmation.
      expect({ ...outcome.answer, askId: given.askId, confirmation: given.confirmation }).toEqual(given);
      if (sharedFromAnother) expect(outcome.answer.confirmation).toBe("none");
      // A permission request is only ever decided by an answer the owner addressed to it.
      if (asks.get(action.askId)?.kind === "permission") {
        expect(sharedFromAnother).toBe(false);
      }
      const before = entry.before.open.find((q) => q.ask.id === action.askId);
      expect(before).toBeDefined();
      if (before === undefined) continue;
      expect(answerProblem(before.ask, outcome.answer, new Date(entry.at))).toBeUndefined();
      // The owner answered on a channel this ask (or the one it duplicates) actually went out on.
      const contacted = entry.before.open.find((q) => q.ask.id === (before.duplicateOf ?? before.ask.id));
      if (given.channel === "voice") expect(contacted?.phase).toBe("calling");
      else expect(contacted?.texted).toBe(true);
      if (
        before.ask.kind === "permission" &&
        before.ask.risk === "high" &&
        outcome.answer.decision.type === "allow"
      ) {
        expect(outcome.answer.confirmation).not.toBe("none");
      }
    }

    // The next wake-up is always in the future: no busy loop, and nothing overdue left behind.
    const wake = nextWakeAt(entry.after, new Date(entry.at), settings);
    if (wake !== undefined) expect(wake.getTime()).toBeGreaterThan(entry.at);

    // Nothing stays open past its expiry.
    for (const q of entry.after.open) expect(Date.parse(q.ask.expiresAt)).toBeGreaterThan(entry.at);
  }

  // Every accepted ask ended exactly once; ignored ones never did.
  for (const id of asks.keys()) {
    const ignored = h.log.some(
      (entry) =>
        entry.event.type === "ask" &&
        entry.event.ask.id === id &&
        entry.actions.some((action) => action.type === "ignored"),
    );
    expect(finals.get(id) ?? 0).toBe(ignored ? 0 : 1);
  }
  expect(h.state.open).toEqual([]);

  // Rate limits hold over every rolling hour and day, `call me` calls included.
  for (const at of callTimes) {
    expect(within(callTimes, at, HOUR)).toBeLessThanOrEqual(settings.rateLimits.callsPerHour);
    expect(within(callTimes, at, DAY)).toBeLessThanOrEqual(settings.rateLimits.callsPerDay);
  }
  for (const at of textTimes) {
    expect(within(textTimes, at, HOUR)).toBeLessThanOrEqual(settings.rateLimits.textsPerHour);
    expect(within(textTimes, at, DAY)).toBeLessThanOrEqual(settings.rateLimits.textsPerDay);
  }
}

/** A silent run: every invariant holds, and every ask ends unanswered (a permission, denied). */
function checkSilentRun(settings: PolicySettings, start: number, commands: Command[]): void {
  const result = run(settings, start, commands);
  checkInvariants(result);
  for (const action of ofType(result.h.allActions, "resolve")) {
    expect(action.outcome.outcome).toBe("no-answer");
    const ask = result.asks.get(action.askId);
    if (ask?.kind === "permission") expect(permissionVerdict(ask, action.outcome)).toBe("deny");
  }
}

const silentProperty = fc.property(
  settingsArb,
  START,
  fc.array(silentCommand, { minLength: 5, maxLength: 80, size: "medium" }),
  checkSilentRun,
);

describe("ask queue properties", () => {
  it("silence never yields approval: no pickup, drops, unclear answers, failures and timeouts all end unanswered", () => {
    fc.assert(silentProperty, { numRuns: 400 });
  });

  // Issue #50: hosted CI failed once on this seed. A question joined a call inside its batch
  // window, the call went unanswered and, with a zero retry delay, the retry went out in the
  // same step. The queue was right; the invariant read the ask's `readyAt` from before the
  // `call-ended` event that reset it.
  it("replays seed -763136370 from issue #50", () => {
    fc.assert(silentProperty, {
      seed: -763136370,
      path: "390:0:0:0:0:0:4:4:4:10:11:11:14:1:2:8:8:8:9:13:17:20:5:16:16:16:17:20:24:24:34:36:36:23:23:23:23:23:23:23:23:23",
      endOnFailure: true,
    });
  });

  it("holds for the shrunk counterexample from issue #50", () => {
    const question = {
      kind: "ask",
      session: 0,
      askKind: "question",
      risk: "low",
      urgent: false,
      ttlMinutes: 1,
    } as const;
    checkSilentRun(
      {
        quietHours: { start: "00:00", end: "00:00", timeZone: "America/Toronto", allowUrgentCalls: false },
        rateLimits: { callsPerHour: 2, callsPerDay: 2, textsPerHour: 1, textsPerDay: 1 },
        batchWindowMs: 10,
        maxCallAttempts: 2,
        retryDelayMs: 0,
        maxAsksPerCall: 2,
        callStuckAfterMs: 5 * MINUTE,
      },
      Date.parse("2026-01-01T00:00:00Z"),
      [
        { ...question, text: 0 },
        { kind: "advance", ms: 1 },
        { ...question, text: 1 },
        { kind: "advance", ms: 9 },
        { kind: "call-ended", result: "no-pickup", current: true },
        { ...question, text: 0 },
        { kind: "call-me" },
        { kind: "call-me" },
        { kind: "unclear", pick: 0 },
        { ...question, text: 0 },
      ],
    );
  });

  it("answers count only when they pass answerProblem as they arrive; high-risk approvals need confirmation", () => {
    const command = fc.oneof(
      { arbitrary: silentCommand, weight: 3 },
      { arbitrary: answerCommand, weight: 2 },
    );
    fc.assert(
      fc.property(
        settingsArb,
        START,
        fc.array(command, { minLength: 5, maxLength: 80, size: "medium" }),
        (settings, start, commands) => {
          const result = run(settings, start, commands);
          checkInvariants(result);
          for (const action of ofType(result.h.allActions, "resolve")) {
            const ask = result.asks.get(action.askId);
            if (ask?.kind !== "permission" || permissionVerdict(ask, action.outcome) !== "allow") continue;
            expect(action.outcome.outcome === "answered" && action.outcome.answer.decision.type).toBe(
              "allow",
            );
            if (ask.risk === "high") {
              expect(action.outcome.outcome === "answered" && action.outcome.answer.confirmation).not.toBe(
                "none",
              );
            }
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("is deterministic: the same inputs give the same actions", () => {
    const command = fc.oneof(silentCommand, answerCommand);
    fc.assert(
      fc.property(settingsArb, START, fc.array(command, { maxLength: 40 }), (settings, start, commands) => {
        const first = run(settings, start, commands).h.allActions;
        const second = run(settings, start, commands).h.allActions;
        expect(second).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});
