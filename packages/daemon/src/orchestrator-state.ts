// Call orchestration's durable state (HL-09; split out of orchestrator.ts in
// HL-09b): what it saves in the store and how that is restored, failing closed;
// the checks made against the store before anything goes out; and crash
// recovery of the actions a step left undone.
import { randomUUID } from "node:crypto";
import {
  Answer,
  Ask,
  AskOutcome,
  type AskStatus,
  createQueue,
  type PolicySettings,
  type QueueAction,
  type QueueEvent,
  type QueueState,
} from "@hotline/core";
import { z } from "zod";
import { hashCode, isCodeHash } from "./code-hash.js";
import type { HotlineStore } from "./store.js";

/** Key of the orchestrator's saved state in the store. */
export const ORCHESTRATOR_STATE_KEY = "orchestrator";
/** Key of the call and text times, saved apart from the main state. */
export const RATE_STATE_KEY = "orchestrator.rates";

/** The subset of a pino/Fastify logger the orchestrator uses. */
export interface OrchestratorLog {
  info(detail: object, message: string): void;
  warn(detail: object, message: string): void;
  error(detail: object, message: string): void;
}

export const silentLog: OrchestratorLog = { info() {}, warn() {}, error() {} };

/** A voice answer held until the post-call transcript confirms it. */
export interface PendingVoiceAnswer {
  decision: Answer["decision"] | "unclear";
  ownerWords: string;
  confirmation: Answer["confirmation"];
  answeredAt: string;
  /** The model submitted a different decision for this ask on the same call: nothing counts. */
  conflict?: boolean;
}

/** A call Hotline placed and is waiting on, until its post-call event, its failure or the stuck-call limit. */
export interface LiveCall {
  callId: string;
  conversationId: string;
  callSid?: string;
  /** The asks read out, in order: ask number N on the call is `askIds[N - 1]`. */
  askIds: string[];
  placedAt: string;
  answers: Record<string, PendingVoiceAnswer>;
}

export interface SavedState {
  version: 1;
  queue: QueueState;
  calls: LiveCall[];
  /**
   * Salted hashes (`hashCode`) of the confirmation codes of texted permission
   * asks, by ask id. Single use. The plaintext code is never stored (HL-13a).
   */
  codes: Record<string, string>;
  /**
   * Actions of the last step not carried out yet, saved together with the queue
   * state that assumes them, so a crash part way through can be recovered on
   * start (see `recoverPending`).
   */
  pending: PendingAction[];
  /** When each waiting ask's text went out, by ask id; a bare reply right after it is not bound. */
  textedAt: Record<string, string>;
}

const RateStateSchema = z.strictObject({ callTimes: z.array(z.number()), textTimes: z.array(z.number()) });

const QueuedAskSchema = z.strictObject({
  ask: Ask,
  phase: z.enum(["waiting", "calling", "texted"]),
  readyAt: z.number(),
  callAttempts: z.int().min(0),
  texted: z.boolean(),
  textOnly: z.enum(["notify", "quiet-hours", "call-limit", "after-call"]).optional(),
  duplicateOf: z.string().optional(),
  lastFailure: z.enum(["no-pickup", "dropped", "failed"]).optional(),
});
const PendingSchema = z.strictObject({
  decision: z.union([z.literal("unclear"), Answer.shape.decision]),
  ownerWords: z.string().min(1),
  confirmation: Answer.shape.confirmation,
  answeredAt: z.iso.datetime(),
  conflict: z.boolean().optional(),
});
/** An action the queue asked for whose effect may not have happened yet. */
const PendingActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("place-call"), callId: z.string(), askIds: z.array(z.string()) }),
  z.strictObject({ type: z.literal("end-call"), callId: z.string() }),
  z.strictObject({
    type: z.literal("send-text"),
    askId: z.string(),
    reason: z.enum(["notify", "quiet-hours", "call-limit", "after-call"]),
  }),
  z.strictObject({
    type: z.literal("resolve"),
    askId: z.string(),
    outcome: AskOutcome,
    status: z.enum(["answered", "expired", "cancelled"]),
  }),
  z.strictObject({ type: z.literal("delivered"), askId: z.string() }),
]);
export type PendingAction = z.infer<typeof PendingActionSchema>;

const SavedStateSchema = z.strictObject({
  version: z.literal(1),
  queue: z.strictObject({
    open: z.array(QueuedAskSchema),
    call: z.strictObject({ id: z.string(), askIds: z.array(z.string()), placedAt: z.number() }).optional(),
    callTimes: z.array(z.number()),
    textTimes: z.array(z.number()),
    callSeq: z.int().min(0),
    idPrefix: z.string().min(1),
  }),
  calls: z.array(
    z.strictObject({
      callId: z.string(),
      conversationId: z.string(),
      callSid: z.string().optional(),
      askIds: z.array(z.string()),
      placedAt: z.iso.datetime(),
      answers: z.record(z.string(), PendingSchema),
    }),
  ),
  codes: z.record(z.string(), z.string()),
  pending: z.array(PendingActionSchema).default([]),
  textedAt: z.record(z.string(), z.iso.datetime()).default({}),
});

/**
 * The orchestrator's state and its copy in the store. Every part of the
 * orchestrator mutates `data` in place and calls `save` after each change.
 * `restore` replaces the object, so read `this.data` afresh at the start of
 * each step and never keep a reference to it across steps.
 */
export class OrchestratorState {
  data: SavedState;
  readonly #store: HotlineStore;
  readonly #settings: PolicySettings;
  readonly #clock: () => Date;

  constructor(store: HotlineStore, settings: PolicySettings, clock: () => Date) {
    this.#store = store;
    this.#settings = settings;
    this.#clock = clock;
    this.data = {
      version: 1,
      queue: createQueue(`call-${randomUUID().slice(0, 8)}`),
      calls: [],
      codes: {},
      pending: [],
      textedAt: {},
    };
  }

  /**
   * Restores the saved state. Unreadable state fails closed: the queue starts
   * empty (the caller queues open asks afresh), and the rate limits keep
   * counting what was already sent (or start out full).
   */
  restore(log: OrchestratorLog): void {
    const stored = this.#store.getState(ORCHESTRATOR_STATE_KEY);
    const saved = SavedStateSchema.safeParse(stored);
    if (saved.success) {
      this.data = saved.data as SavedState;
      // State saved before HL-13a held plaintext codes: hash them now, and save
      // at once, so the plaintext does not stay in the store.
      const plain = Object.entries(this.data.codes).filter(([, value]) => !isCodeHash(value));
      if (plain.length > 0) {
        for (const [askId, code] of plain) this.data.codes[askId] = hashCode(code);
        this.save();
      }
    } else if (stored !== undefined) {
      log.warn({}, "call orchestration state unreadable; starting a new queue");
      this.#restoreRates();
    }
  }

  save(): void {
    this.#store.putState(ORCHESTRATOR_STATE_KEY, this.data);
    // Kept apart too, so losing the main state never resets the rate limits.
    const { callTimes, textTimes } = this.data.queue;
    this.#store.putState(RATE_STATE_KEY, { callTimes, textTimes });
  }

  /**
   * After unreadable main state: the saved call and text times, or, if those are
   * unreadable too, hourly windows treated as full from now, so a corrupt state
   * can never set off a burst of calls or texts.
   */
  #restoreRates(): void {
    const rates = RateStateSchema.safeParse(this.#store.getState(RATE_STATE_KEY));
    const queue = this.data.queue;
    if (rates.success) {
      queue.callTimes = rates.data.callTimes;
      queue.textTimes = rates.data.textTimes;
      return;
    }
    const now = this.#clock().getTime();
    const { callsPerHour, textsPerHour } = this.#settings.rateLimits;
    queue.callTimes = Array.from({ length: callsPerHour }, () => now);
    queue.textTimes = Array.from({ length: textsPerHour }, () => now);
    this.#store.appendAudit("orchestration.rates-reset", {}, new Date(now));
  }
}

/**
 * Carries out the actions the last run saved but may not have finished, and
 * returns the queue events they lead to. A call that may or may not have been
 * placed counts as failed (the queue's retry policy applies); a text is sent
 * again (at least once); the rest is idempotent.
 */
export async function recoverPending(
  state: OrchestratorState,
  store: HotlineStore,
  clock: () => Date,
  execute: (action: QueueAction, now: Date) => Promise<QueueEvent[]>,
): Promise<QueueEvent[]> {
  const pending = state.data.pending;
  if (pending.length === 0) return [];
  state.data.pending = [];
  state.save();
  const now = clock();
  store.appendAudit("orchestration.recovered", { actions: pending.length }, now);
  const events: QueueEvent[] = [];
  for (const action of pending) {
    if (action.type === "place-call") {
      if (!state.data.calls.some((call) => call.callId === action.callId)) {
        events.push({ type: "call-ended", callId: action.callId, result: "failed" });
      }
      continue;
    }
    events.push(...(await execute(action, now)));
  }
  return events;
}

// Checks before anything goes out ---------------------------------------------

/** Ask statuses the queue may still act on. */
export const OPEN: ReadonlySet<AskStatus> = new Set<AskStatus>(["pending", "in-flight"]);
/** `notReachable`'s reason for an ask past its `expiresAt`. */
const EXPIRED = "the ask expired";

/** Why an ask must not go out now, or undefined: it closed, or its agent left. */
export function notReachable(store: HotlineStore, clock: () => Date, askId: string): string | undefined {
  const ask = store.getAsk(askId);
  if (ask === undefined) return "unknown ask";
  if (!OPEN.has(ask.status)) return `the ask is ${ask.status}`;
  if (store.getSession(ask.sessionId)?.state === "ended") return "the session ended";
  // A fresh reading: an earlier slow send in the same step may have run past it.
  if (clock().getTime() >= Date.parse(ask.expiresAt)) return EXPIRED;
  return undefined;
}

/** The queue event for an ask that must not go out: an expired one expires with its own reason. */
export function dropEvent(askId: string, why: string): QueueEvent {
  return why === EXPIRED ? { type: "tick" } : { type: "cancel", askId };
}
