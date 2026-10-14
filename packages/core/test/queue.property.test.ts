// Property tests for the ask queue: random asks, clocks, settings and provider events.
// The core claim: silence (no pickup, dropped or failed calls, unclear answers, failed
// texts, cancellation, timeouts) never yields an approval, and an `answered` outcome
// only ever carries an owner answer that passed `answerProblem` when it arrived.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Ask,
  type AskKind,
  AskOutcome,
  answerProblem,
  type CallEnd,
  type Decision,
  inQuietHours,
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
  | { kind: "unclear" | "text-failed" | "cancel"; pick: number }
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
      kind: fc.constantFrom("unclear" as const, "text-failed" as const, "cancel" as const),
      pick: fc.nat(),
    }),
    weight: 2,
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
      case "text-failed":
      case "cancel":
        h.send({ type: command.kind, askId: pick(command.pick) });
        break;
      case "answer": {
        const contacted = h.state.open.filter(
          (q) => q.duplicateOf === undefined && (q.callAttempts > 0 || q.texted),
        );
        const target = command.aimed ? contacted[command.pick % Math.max(contacted.length, 1)] : undefined;
        const askId = target?.ask.id ?? pick(command.pick);
        const channel = target === undefined ? command.channel : target.texted ? "sms" : "voice";
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

  for (const entry of h.log) {
    const calls = ofType(entry.actions, "place-call");
    expect(calls.length).toBeLessThanOrEqual(1);
    for (const call of calls) {
      // One call at a time: a new call only after the previous one ended or was given up on.
      const previous = entry.before.call;
      if (previous !== undefined) {
        const ended = entry.event.type === "call-ended" && entry.event.callId === previous.id;
        expect(ended || entry.at - previous.placedAt >= settings.callStuckAfterMs).toBe(true);
      }
      expect(call.askIds.length).toBeGreaterThan(0);
      expect(call.askIds.length).toBeLessThanOrEqual(settings.maxAsksPerCall);
      const quiet = inQuietHours(settings.quietHours, new Date(entry.at));
      for (const askId of call.askIds) {
        const ask = asks.get(askId);
        expect(ask?.kind).not.toBe("notify");
        if (quiet) expect(ask?.urgent && settings.quietHours.allowUrgentCalls).toBe(true);
      }
      callTimes.push(entry.at);
    }
    for (const _text of ofType(entry.actions, "send-text")) textTimes.push(entry.at);

    for (const action of entry.actions) {
      if (action.type !== "resolve" && action.type !== "delivered") continue;
      finals.set(action.askId, (finals.get(action.askId) ?? 0) + 1);
      if (action.type === "delivered") {
        expect(asks.get(action.askId)?.kind).toBe("notify");
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
      expect({ ...outcome.answer, askId: given.askId }).toEqual(given);
      const before = entry.before.open.find((q) => q.ask.id === action.askId);
      expect(before).toBeDefined();
      if (before === undefined) continue;
      expect(answerProblem(before.ask, outcome.answer, new Date(entry.at))).toBeUndefined();
      // The owner answered on a channel this ask (or the one it duplicates) actually went out on.
      const contacted = entry.before.open.find((q) => q.ask.id === (before.duplicateOf ?? before.ask.id));
      if (given.channel === "voice") expect(contacted?.callAttempts).toBeGreaterThan(0);
      else expect(contacted?.texted).toBe(true);
      if (
        before.ask.kind === "permission" &&
        before.ask.risk === "high" &&
        outcome.answer.decision.type === "allow"
      ) {
        expect(outcome.answer.confirmation).not.toBe("none");
      }
    }

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

  // Rate limits hold over every rolling hour and day.
  const within = (times: number[], at: number, window: number) =>
    times.filter((t) => t > at - window && t <= at).length;
  for (const at of callTimes) {
    expect(within(callTimes, at, HOUR)).toBeLessThanOrEqual(settings.rateLimits.callsPerHour);
    expect(within(callTimes, at, DAY)).toBeLessThanOrEqual(settings.rateLimits.callsPerDay);
  }
  for (const at of textTimes) {
    expect(within(textTimes, at, HOUR)).toBeLessThanOrEqual(settings.rateLimits.textsPerHour);
    expect(within(textTimes, at, DAY)).toBeLessThanOrEqual(settings.rateLimits.textsPerDay);
  }
}

describe("ask queue properties", () => {
  it("silence never yields approval: no pickup, drops, unclear answers, failures and timeouts all end unanswered", () => {
    fc.assert(
      fc.property(
        settingsArb,
        START,
        fc.array(silentCommand, { minLength: 5, maxLength: 80, size: "medium" }),
        (settings, start, commands) => {
          const result = run(settings, start, commands);
          checkInvariants(result);
          for (const action of ofType(result.h.allActions, "resolve")) {
            expect(action.outcome.outcome).toBe("no-answer");
            const ask = result.asks.get(action.askId);
            if (ask?.kind === "permission") expect(permissionVerdict(ask, action.outcome)).toBe("deny");
          }
        },
      ),
      { numRuns: 400 },
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
