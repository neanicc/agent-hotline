// Call orchestration (HL-09): drives core's pure ask queue with the daemon's
// clock and a real timer, persists its state, carries out its actions through
// the voice and SMS providers, and resolves asks through the store.
//
// This file is the coordinator: it serializes steps, feeds the queue, runs the
// timer and resolves asks. The rest is split by concern (HL-09b):
// - `orchestrator-state.ts`: the saved state, its fail-closed restore, the
//   checks made before anything goes out, and crash recovery;
// - `orchestrator-voice.ts`: placing calls, holding voice answers and
//   confirming them against the post-call transcript;
// - `orchestrator-texts.ts`: texting asks with confirmation codes and applying
//   the owner's replies (`owner-texts.ts` plans them).
//
// Safety rules these files keep (AGENTS.md):
// - Decisions come only from the owner. A voice answer is held until the
//   post-call transcript confirms it (`confirmVoiceDecision`: the owner's own
//   turns, after the ask was read and before the next one); a text answer is
//   accepted only for the one ask Hotline texted that is still open. Both then
//   go through the queue (`answerProblem` at arrival) and `recordAnswer`, which
//   checks `answerProblem` again. Nothing else produces an answered outcome.
// - Silence is not consent: no pickup, a dropped call, a missing post-call
//   event, an unconfirmed or conflicting answer, an unclear one and every
//   failure leave the ask unanswered, and the queue ends it as `no-answer`.
// - High-risk approvals need the PIN on the call (the route's PinGate sets
//   `confirmation: "pin"`) or `YES <code>` by text with a random, single-use
//   code that dies with the ask.
// - Before a call or text goes out, each ask is checked again: still open in
//   the store and its session not ended.
// - Owner only: providers are bound to the owner's number; texts reach this
//   file only from the owner's number on a verified webhook, once per message
//   SID (remembered in the store across restarts).
// - Logs and audit entries carry ids, kinds, counts and reasons, never words.
import {
  nextWakeAt,
  type PolicySettings,
  type QueueAction,
  type QueueEvent,
  type QueueState,
  step,
} from "@hotline/core";
import type { PostCallEvent, SmsProvider, VoiceProvider } from "@hotline/providers";
import type { SubmitAnswerResult, VoiceAnswer } from "./elevenlabs-webhook.js";
import {
  OPEN,
  type OrchestratorLog,
  OrchestratorState,
  type PendingAction,
  recoverPending,
  silentLog,
} from "./orchestrator-state.js";
import { OwnerTexts } from "./orchestrator-texts.js";
import { VoiceCalls } from "./orchestrator-voice.js";
import type { OwnerSms } from "./sms-webhook.js";
import type { HotlineStore } from "./store.js";

export { ORCHESTRATOR_STATE_KEY, type OrchestratorLog, RATE_STATE_KEY } from "./orchestrator-state.js";
export { CALL_CENTS_PER_MINUTE } from "./orchestrator-voice.js";

/** A timer never fires sooner than this after the last step, so overdue work cannot spin. */
const MIN_TIMER_MS = 100;
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * How long `stop` waits for the step in progress. A slow provider request can
 * outlast it; the step's unfinished actions are saved and recovered on start.
 */
export const STOP_WAIT_MS = 5_000;

export interface CallOrchestratorOptions {
  store: HotlineStore;
  settings: PolicySettings;
  /** The daemon's injected clock. Every queue step uses it. */
  clock: () => Date;
  /** Places calls to the owner. Without one, every call fails and asks fall back to text. */
  voice?: VoiceProvider;
  /** Texts the owner. Without one, every text fails. */
  sms?: SmsProvider;
  /** The daemon's redactor; a confirmation code it would change is never used. */
  redact: (text: string) => string;
  log?: OrchestratorLog;
  /** Tick at `nextWakeAt` with a real timer (default). Tests may turn it off and call `tick()`. */
  autoTick?: boolean;
  /** For tests: the next confirmation code. Default: 6 random digits. */
  newCode?: () => string;
  /** How long `stop` waits for the step in progress; default `STOP_WAIT_MS`. */
  stopWaitMs?: number;
}

export class CallOrchestrator {
  readonly #options: CallOrchestratorOptions;
  readonly #store: HotlineStore;
  #log: OrchestratorLog;
  readonly #state: OrchestratorState;
  readonly #voice: VoiceCalls;
  readonly #texts: OwnerTexts;
  /** Every step runs after the previous one. Closed until `start` has recovered. */
  #chain: Promise<unknown>;
  #open: () => void = () => {};
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #unsubscribe: (() => void)[] = [];

  constructor(options: CallOrchestratorOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#log = options.log ?? silentLog;
    this.#state = new OrchestratorState(options.store, options.settings, options.clock);
    const log = () => this.#log;
    const processEvent = (event: QueueEvent) => this.#process(event);
    this.#voice = new VoiceCalls({
      store: options.store,
      state: this.#state,
      clock: options.clock,
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      log,
      process: processEvent,
    });
    this.#texts = new OwnerTexts({
      store: options.store,
      state: this.#state,
      clock: options.clock,
      ...(options.sms === undefined ? {} : { sms: options.sms }),
      redact: options.redact,
      ...(options.newCode === undefined ? {} : { newCode: options.newCode }),
      log,
      process: processEvent,
    });
    // Webhooks or agent requests that arrive before `start` wait for it.
    this.#chain = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  /** Sends logs to the daemon's logger once it exists. */
  attachLog(log: OrchestratorLog): void {
    this.#log = log;
  }

  /**
   * Restores the saved state, finishes what the last run left undone, reconciles
   * with the store (asks closed while the daemon was down are dropped, open asks
   * it does not know are queued), starts listening for new and changed asks, and
   * runs the first step. Nothing else runs until this is done.
   */
  async start(): Promise<void> {
    this.#state.restore(this.#log);
    this.#unsubscribe.push(
      this.#store.onAskAdded((ask) => {
        if (ask.status === "pending") void this.#run(() => this.#process({ type: "ask", ask }));
      }),
      this.#store.onAskChange((askId) => {
        void this.#run(() => this.#storeChanged(askId));
      }),
    );
    try {
      await this.#texts.reportInterrupted(this.#options.clock());
      const recovered = await recoverPending(this.#state, this.#store, this.#options.clock, (action, now) =>
        this.#execute(action, now),
      );
      for (const event of recovered) await this.#process(event);
      const queued = new Set(this.#state.data.queue.open.map((q) => q.ask.id));
      for (const askId of queued) await this.#storeChanged(askId);
      for (const ask of this.#store.listAsks(["pending", "in-flight"])) {
        if (!queued.has(ask.id)) await this.#process({ type: "ask", ask: { ...ask, status: "pending" } });
      }
      await this.#process({ type: "tick" });
    } finally {
      this.#open();
    }
  }

  /**
   * Stops the timer and the store listeners and refuses new steps. Waits for the
   * step in progress, at most `STOP_WAIT_MS`: a slow provider request may
   * outlast that, and what it leaves undone is recovered on the next start.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#open();
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#options.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref();
    });
    await Promise.race([this.idle(), waited]);
    clearTimeout(timer);
  }

  /** Resolves once every queued step has run. */
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.#chain) {
      seen = this.#chain;
      await seen;
    }
  }

  /** Runs whatever is due now. The timer calls this; tests with a fake clock call it after moving the clock. */
  tick(): Promise<void> {
    return this.#run(async () => {
      await this.#process({ type: "tick" });
    });
  }

  /** The queue's current state, for tests and status. */
  get queue(): QueueState {
    return structuredClone(this.#state.data.queue);
  }

  /**
   * Whether Hotline placed this conversation and is still waiting on it: the
   * `placedCall` the ElevenLabs routes need. Only such a call is outbound.
   */
  placedCall(conversationId: string): boolean {
    return this.#voice.placedCall(conversationId);
  }

  /** `submit_answer`: holds the answer until the post-call transcript confirms it. */
  submitAnswer(answer: VoiceAnswer): Promise<SubmitAnswerResult> {
    return this.#run(async () => this.#voice.submitAnswer(answer));
  }

  /** A verified post-call webhook; see `VoiceCalls.postCall`. */
  postCall(event: Exclude<PostCallEvent, { type: "other" }>, receivedAt: Date): Promise<void> {
    return this.#run(() => this.#voice.postCall(event, receivedAt));
  }

  /**
   * A verified text from the owner's number. Handled once per message SID, also
   * across restarts. Returns the reply to send back, if any.
   */
  ownerText(message: OwnerSms): Promise<string | undefined> {
    return this.#run(() => this.#texts.ownerText(message));
  }

  // The queue -----------------------------------------------------------------

  /** Serializes every step: the queue sees one event at a time. A failure never blocks later steps. */
  #run<T>(work: () => Promise<T>): Promise<T> {
    // After `stop`, queued work is refused rather than run against a closing store.
    const result = this.#chain.then(() =>
      this.#stopped ? Promise.reject(new Error("call orchestration has stopped")) : work(),
    );
    this.#chain = result.then(
      () => undefined,
      (error: unknown) => this.#log.error({ err: error }, "call orchestration step failed"),
    );
    return result;
  }

  /** The store changed an ask (the agent cancelled, its session ended, the agent API expired it). */
  async #storeChanged(askId: string): Promise<void> {
    if (!this.#state.data.queue.open.some((q) => q.ask.id === askId)) return;
    const ask = this.#store.getAsk(askId);
    if (ask !== undefined && OPEN.has(ask.status)) return;
    if (ask?.status === "expired" && this.#options.clock().getTime() >= Date.parse(ask.expiresAt)) {
      // The queue expires it on its own, with the specific reason.
      await this.#process({ type: "tick" });
      return;
    }
    await this.#process({ type: "cancel", askId });
  }

  /** Steps the queue with `first` and every event its actions lead to; returns all actions. */
  async #process(first: QueueEvent): Promise<QueueAction[]> {
    const events: QueueEvent[] = [first];
    const all: QueueAction[] = [];
    const state = this.#state;
    for (let event = events.shift(); event !== undefined; event = events.shift()) {
      const now = this.#options.clock();
      const result = step(state.data.queue, event, now, this.#options.settings);
      // The new queue state and the actions it assumes are saved together, and
      // each action is crossed off once done, so a crash in between is recovered.
      state.data.queue = result.state;
      state.data.pending = result.actions.filter((action) => action.type !== "ignored") as PendingAction[];
      state.save();
      all.push(...result.actions);
      for (const action of result.actions) {
        events.push(...(await this.#execute(action, now)));
        if (action.type !== "ignored") {
          state.data.pending.shift();
          state.save();
        }
      }
    }
    this.#schedule();
    return all;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#stopped || this.#options.autoTick === false) return;
    const now = this.#options.clock();
    const wake = nextWakeAt(this.#state.data.queue, now, this.#options.settings);
    if (wake === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, wake.getTime() - now.getTime()));
    this.#timer = setTimeout(() => {
      void this.tick().catch(() => {});
    }, delay);
    this.#timer.unref();
  }

  /** Carries out one action; returns the events it leads to. */
  async #execute(action: QueueAction, now: Date): Promise<QueueEvent[]> {
    switch (action.type) {
      case "place-call":
        return this.#voice.place(action.callId, action.askIds, now);
      case "end-call":
        this.#voice.abandon(action.callId, now);
        return [];
      case "send-text":
        return this.#texts.send(action.askId, action.reason, now);
      case "resolve":
        this.#resolve(action, now);
        return [];
      case "delivered": {
        const ask = this.#store.getAsk(action.askId);
        this.#store.closeAsk(action.askId, "expired", "delivered");
        this.#store.appendAudit("ask.delivered", {}, now, {
          askId: action.askId,
          ...(ask === undefined ? {} : { sessionId: ask.sessionId }),
        });
        return [];
      }
      case "ignored":
        this.#log.info({ event: action.event, reason: action.reason }, "queue event ignored");
        return [];
    }
  }

  #resolve(action: Extract<QueueAction, { type: "resolve" }>, now: Date): void {
    const { askId, outcome } = action;
    delete this.#state.data.codes[askId];
    delete this.#state.data.textedAt[askId];
    this.#state.save();
    const ask = this.#store.getAsk(askId);
    const ids = { askId, ...(ask === undefined ? {} : { sessionId: ask.sessionId }) };
    if (outcome.outcome === "answered") {
      const { answer } = outcome;
      try {
        // The store checks `answerProblem` again against its own copy of the ask.
        this.#store.recordAnswer(answer, now);
        this.#store.appendAudit(
          "ask.answered",
          { channel: answer.channel, decision: answer.decision.type, confirmation: answer.confirmation },
          now,
          ids,
        );
      } catch (error) {
        this.#log.warn({ err: error }, "answer refused by the store");
        this.#store.appendAudit("ask.answer-refused", { channel: answer.channel }, now, ids);
        // The queue has let the ask go, so end it now as no answer rather than
        // leave the agent waiting until it expires.
        this.#store.closeAsk(askId, "expired", "failed");
      }
      return;
    }
    const status = action.status === "cancelled" ? "cancelled" : "expired";
    this.#store.closeAsk(askId, status, outcome.reason);
    this.#store.appendAudit("ask.no-answer", { reason: outcome.reason }, now, ids);
  }
}
