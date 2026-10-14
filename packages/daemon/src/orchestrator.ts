// Call orchestration (HL-09): drives core's pure ask queue with the daemon's
// clock and a real timer, persists its state, carries out its actions through
// the voice and SMS providers, and resolves asks through the store.
//
// Safety rules this file keeps (AGENTS.md):
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
import { randomInt, randomUUID } from "node:crypto";
import {
  Answer,
  Ask,
  AskOutcome,
  type AskStatus,
  createQueue,
  nextWakeAt,
  type PolicySettings,
  type QueueAction,
  type QueueEvent,
  type QueueState,
  step,
} from "@hotline/core";
import type { PostCallEvent, SmsProvider, VoiceAsk, VoiceProvider } from "@hotline/providers";
import { z } from "zod";
import type { SubmitAnswerResult, VoiceAnswer } from "./elevenlabs-webhook.js";
import { planTextReply, replyHint, replyKind, TEXT_REPLIES, textFor } from "./owner-texts.js";
import type { OwnerSms } from "./sms-webhook.js";
import type { HotlineStore } from "./store.js";
import { confirmVoiceDecision, type ReadAsk } from "./voice-confirm.js";

/** Key of the orchestrator's saved state in the store. */
export const ORCHESTRATOR_STATE_KEY = "orchestrator";
/** Key of the call and text times, saved apart from the main state. */
export const RATE_STATE_KEY = "orchestrator.rates";
/** A timer never fires sooner than this after the last step, so overdue work cannot spin. */
const MIN_TIMER_MS = 100;
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * How long `stop` waits for the step in progress. A slow provider request can
 * outlast it; the step's unfinished actions are saved and recovered on start.
 */
export const STOP_WAIT_MS = 5_000;
/** Rough cost of a call minute in US cents (Twilio voice plus ElevenLabs Agents), for `hotline doctor`. */
export const CALL_CENTS_PER_MINUTE = 12;

/** The subset of a pino/Fastify logger the orchestrator uses. */
export interface OrchestratorLog {
  info(detail: object, message: string): void;
  warn(detail: object, message: string): void;
  error(detail: object, message: string): void;
}

const silentLog: OrchestratorLog = { info() {}, warn() {}, error() {} };

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

/** A voice answer held until the post-call transcript confirms it. */
interface PendingVoiceAnswer {
  decision: Answer["decision"] | "unclear";
  ownerWords: string;
  confirmation: Answer["confirmation"];
  answeredAt: string;
  /** The model submitted a different decision for this ask on the same call: nothing counts. */
  conflict?: boolean;
}

/** A call Hotline placed and is waiting on, until its post-call event, its failure or the stuck-call limit. */
interface LiveCall {
  callId: string;
  conversationId: string;
  callSid?: string;
  /** The asks read out, in order: ask number N on the call is `askIds[N - 1]`. */
  askIds: string[];
  placedAt: string;
  answers: Record<string, PendingVoiceAnswer>;
}

interface SavedState {
  version: 1;
  queue: QueueState;
  calls: LiveCall[];
  /** Confirmation codes of texted permission asks, by ask id. Single use. */
  codes: Record<string, string>;
  /**
   * Actions of the last step not carried out yet, saved together with the queue
   * state that assumes them, so a crash part way through can be recovered on
   * start (see `#recover`).
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
type PendingAction = z.infer<typeof PendingActionSchema>;

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

const OPEN: ReadonlySet<AskStatus> = new Set<AskStatus>(["pending", "in-flight"]);
/** `#notReachable`'s reason for an ask past its `expiresAt`. */
const EXPIRED = "the ask expired";

function sameDecision(a: PendingVoiceAnswer["decision"], b: PendingVoiceAnswer["decision"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class CallOrchestrator {
  readonly #options: CallOrchestratorOptions;
  readonly #store: HotlineStore;
  #log: OrchestratorLog;
  #state: SavedState;
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
    this.#state = {
      version: 1,
      queue: createQueue(`call-${randomUUID().slice(0, 8)}`),
      calls: [],
      codes: {},
      pending: [],
      textedAt: {},
    };
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
    const stored = this.#store.getState(ORCHESTRATOR_STATE_KEY);
    const saved = SavedStateSchema.safeParse(stored);
    if (saved.success) this.#state = saved.data as SavedState;
    else if (stored !== undefined) {
      // Unreadable state fails closed: open asks are queued afresh below, and the
      // rate limits keep counting what was already sent (or start out full).
      this.#log.warn({}, "call orchestration state unreadable; starting a new queue");
      this.#restoreRates();
    }
    this.#unsubscribe.push(
      this.#store.onAskAdded((ask) => {
        if (ask.status === "pending") void this.#run(() => this.#process({ type: "ask", ask }));
      }),
      this.#store.onAskChange((askId) => {
        void this.#run(() => this.#storeChanged(askId));
      }),
    );
    try {
      await this.#recover();
      const queued = new Set(this.#state.queue.open.map((q) => q.ask.id));
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
   * Carries out the actions the last run saved but may not have finished. A call
   * that may or may not have been placed counts as failed (the queue's retry
   * policy applies); a text is sent again (at least once); the rest is idempotent.
   */
  async #recover(): Promise<void> {
    await this.#reportInterruptedTexts(this.#options.clock());
    const pending = this.#state.pending;
    if (pending.length === 0) return;
    this.#state.pending = [];
    this.#save();
    const now = this.#options.clock();
    this.#store.appendAudit("orchestration.recovered", { actions: pending.length }, now);
    const events: QueueEvent[] = [];
    for (const action of pending) {
      if (action.type === "place-call") {
        if (!this.#state.calls.some((call) => call.callId === action.callId)) {
          events.push({ type: "call-ended", callId: action.callId, result: "failed" });
        }
        continue;
      }
      events.push(...(await this.#execute(action, now)));
    }
    for (const event of events) await this.#process(event);
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
    return structuredClone(this.#state.queue);
  }

  /**
   * Whether Hotline placed this conversation and is still waiting on it: the
   * `placedCall` the ElevenLabs routes need. Only such a call is outbound.
   */
  placedCall(conversationId: string): boolean {
    return this.#state.calls.some((call) => call.conversationId === conversationId);
  }

  // Voice ---------------------------------------------------------------------

  /** `submit_answer`: holds the answer until the post-call transcript confirms it. */
  submitAnswer(answer: VoiceAnswer): Promise<SubmitAnswerResult> {
    return this.#run(async () => {
      const result = this.#holdVoiceAnswer(answer);
      this.#store.appendAudit(
        "voice.answer",
        { decision: answer.decision === "unclear" ? "unclear" : answer.decision.type, result },
        answer.receivedAt,
        result === "recorded" ? { callId: this.#callFor(answer.conversationId)?.callId } : {},
      );
      return result;
    });
  }

  #callFor(conversationId: string): LiveCall | undefined {
    return this.#state.calls.find((call) => call.conversationId === conversationId);
  }

  #holdVoiceAnswer(voice: VoiceAnswer): SubmitAnswerResult {
    const call = this.#callFor(voice.conversationId);
    // Asks are answered only on a call Hotline placed to the owner (the inbound line is HL-10).
    if (call === undefined || voice.direction !== "outbound") return "not-recorded";
    const askId = call.askIds[voice.askNumber - 1];
    const queued = this.#state.queue.open.find((q) => q.ask.id === askId);
    if (
      askId === undefined ||
      queued === undefined ||
      queued.phase !== "calling" ||
      this.#state.queue.call?.id !== call.callId
    ) {
      return "not-recorded";
    }
    const pending: PendingVoiceAnswer = {
      decision: voice.decision,
      ownerWords: voice.ownerWords,
      confirmation: voice.confirmation,
      answeredAt: voice.receivedAt.toISOString(),
    };
    if (voice.decision !== "unclear") {
      const ask = queued.ask;
      if (
        ask.kind === "permission" &&
        ask.risk === "high" &&
        voice.decision.type === "allow" &&
        voice.confirmation === "none"
      ) {
        return "needs-pin";
      }
      const parsed = Answer.safeParse({
        askId,
        decision: voice.decision,
        channel: "voice",
        ownerExcerpt: voice.ownerWords,
        sourceId: voice.conversationId,
        confirmation: voice.confirmation,
        answeredAt: pending.answeredAt,
      });
      if (!parsed.success) return "not-recorded";
    }
    const earlier = call.answers[askId];
    if (earlier !== undefined) {
      const isDeny = (d: PendingVoiceAnswer["decision"]) => d !== "unclear" && d.type === "deny";
      // A refusal always wins: once the owner may have said no, nothing on this
      // call turns it into an approval.
      if (isDeny(earlier.decision))
        return sameDecision(earlier.decision, pending.decision) ? "recorded" : "not-recorded";
      if (isDeny(pending.decision)) {
        call.answers[askId] = pending;
        this.#save();
        return "recorded";
      }
      // A repeat of the same decision is fine; a different one means nobody can
      // tell what the owner chose, so neither counts.
      if (!earlier.conflict && sameDecision(earlier.decision, pending.decision)) return "recorded";
      earlier.conflict = true;
      this.#save();
      return "not-recorded";
    }
    call.answers[askId] = pending;
    this.#save();
    return "recorded";
  }

  /**
   * A verified post-call webhook. The held answers that the transcript confirms
   * reach the queue before the call's end, as the queue requires. Idempotent:
   * an event for a call that is no longer live (a replay, a call given up on)
   * changes nothing.
   */
  postCall(event: Exclude<PostCallEvent, { type: "other" }>, receivedAt: Date): Promise<void> {
    return this.#run(async () => {
      const call = this.#callFor(event.conversationId);
      if (call === undefined) {
        this.#store.appendAudit("voice.post-call-ignored", { kind: event.type }, receivedAt);
        return;
      }
      const events: QueueEvent[] = [];
      let result: "answered" | "no-pickup" | "dropped" | "failed";
      if (event.type === "initiation-failure") {
        result = event.reason === "unknown" ? "failed" : "no-pickup";
      } else {
        const asks = call.askIds.map((askId) => this.#readAsk(askId));
        let settled = 0;
        call.askIds.forEach((askId, index) => {
          const held = call.answers[askId];
          if (held === undefined) return;
          if (held.conflict) {
            this.#store.appendAudit("voice.answer-conflict", {}, receivedAt, { askId, callId: call.callId });
            return;
          }
          if (held.decision === "unclear") {
            events.push({ type: "unclear", askId });
            settled += 1;
            return;
          }
          const check = confirmVoiceDecision({
            transcript: event.transcript,
            asks,
            index,
            decision: held.decision,
            ownerWords: held.ownerWords,
          });
          if (!check.confirmed) {
            this.#store.appendAudit("voice.answer-unconfirmed", { reason: check.reason }, receivedAt, {
              askId,
              callId: call.callId,
            });
            if (held.decision.type === "deny") {
              // A refusal takes effect even unconfirmed: nothing is recorded as the
              // owner's words, but the request ends now as no answer (a deny), and is
              // never sent out again for approval.
              events.push({ type: "unclear", askId });
              settled += 1;
            }
            return;
          }
          events.push({
            type: "answer",
            answer: {
              askId,
              decision: held.decision,
              channel: "voice",
              ownerExcerpt: check.excerpt,
              sourceId: event.conversationId,
              confirmation: held.confirmation,
              answeredAt: held.answeredAt,
            },
          });
          settled += 1;
        });
        const ownerSpoke = event.transcript.some((turn) => turn.role === "owner");
        result = !ownerSpoke ? "no-pickup" : settled === call.askIds.length ? "answered" : "dropped";
      }
      events.push({ type: "call-ended", callId: call.callId, result });
      // The call stays live (with its held answers) until every event is applied:
      // if this fails part way, ElevenLabs' retry applies them again, and events
      // already applied are ignored by the queue.
      for (const next of events) await this.#process(next);
      this.#state.calls = this.#state.calls.filter((other) => other !== call);
      this.#save();
      this.#recordCall(call, event, result, receivedAt);
    });
  }

  #readAsk(askId: string): ReadAsk {
    const ask = this.#store.getAsk(askId);
    const nickname = ask === undefined ? "" : (this.#store.getSession(ask.sessionId)?.nickname ?? "");
    return {
      text: ask?.text ?? "",
      nickname,
      options: ask?.options ?? [],
      ...(ask?.toolName === undefined ? {} : { toolName: ask.toolName }),
    };
  }

  #recordCall(
    call: LiveCall,
    event: Exclude<PostCallEvent, { type: "other" }>,
    result: string,
    endedAt: Date,
  ): void {
    const duration = event.type === "transcription" ? (event.durationSeconds ?? 0) : 0;
    const startedAt = new Date(Math.min(Date.parse(call.placedAt), endedAt.getTime()));
    try {
      this.#store.putCall({
        id: call.callId,
        provider: this.#options.voice?.name ?? "fake",
        direction: "outbound",
        providerIds: {
          conversationId: call.conversationId,
          ...(call.callSid === undefined ? {} : { callSid: call.callSid }),
        },
        askIds: call.askIds,
        outcome:
          result === "answered" || result === "dropped"
            ? "answered"
            : result === "failed"
              ? "failed"
              : "no-answer",
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSeconds: duration,
        costEstimateCents: Math.ceil(duration / 60) * CALL_CENTS_PER_MINUTE,
      });
    } catch (error) {
      this.#log.error({ err: error, callId: call.callId }, "could not store the call record");
    }
    this.#store.appendAudit("call.ended", { result, durationSeconds: duration }, endedAt, {
      callId: call.callId,
    });
  }

  // SMS -----------------------------------------------------------------------

  /**
   * A verified text from the owner's number. Handled once per message SID, also
   * across restarts. Returns the reply to send back, if any.
   */
  ownerText(message: OwnerSms): Promise<string | undefined> {
    return this.#run(async () => {
      if (this.#store.inboundMessageHandled(message.messageSid)) return undefined;
      // Claimed before any effect, so a redelivery after a crash part way through
      // can never apply the same words again, say to a different waiting ask. A
      // failure after this point loses the text (no answer), and the owner is told
      // so: in the reply here, or by text on the next start after a crash.
      this.#store.markInboundMessage(message.messageSid, message.receivedAt);
      try {
        return await this.#handleText(message);
      } catch (error) {
        this.#log.error({ err: error, messageSid: message.messageSid }, "owner text failed");
        this.#store.appendAudit("sms.failed", { messageSid: message.messageSid }, message.receivedAt);
        return TEXT_REPLIES.notHandled;
      } finally {
        this.#store.finishInboundMessage(message.messageSid);
      }
    });
  }

  /** Tells the owner, once, about texts a crash interrupted: they may not have counted. */
  async #reportInterruptedTexts(now: Date): Promise<void> {
    const interrupted = this.#store.unfinishedInboundMessages();
    if (interrupted.length === 0) return;
    for (const messageSid of interrupted) this.#store.finishInboundMessage(messageSid);
    this.#store.appendAudit("sms.interrupted", { count: interrupted.length }, now);
    try {
      await this.#options.sms?.sendToOwner(TEXT_REPLIES.interrupted);
    } catch (error) {
      this.#log.warn({ err: error }, "could not tell the owner about interrupted texts");
    }
  }

  async #handleText({ messageSid, body, receivedAt, optOutType }: OwnerSms): Promise<string | undefined> {
    this.#store.appendAudit("sms.received", { messageSid, reply: replyKind(body) }, receivedAt);
    const plan = planTextReply({
      body,
      messageSid,
      receivedAt,
      // Recorded by `ownerText` just before; a fresh claim reads `receivedAt`.
      firstSeenAt: this.#store.inboundMessageFirstSeen(messageSid) ?? receivedAt,
      optedOut: optOutType !== undefined,
      waiting: this.#state.queue.open
        .filter((q) => q.texted && q.duplicateOf === undefined)
        .map((q) => {
          const code = this.#state.codes[q.ask.id];
          const sent = this.#state.textedAt[q.ask.id];
          return {
            ask: q.ask,
            ...(code === undefined ? {} : { code }),
            ...(sent === undefined ? {} : { sentAt: new Date(sent) }),
          };
        }),
    });
    switch (plan.type) {
      case "ignore":
        return undefined;
      case "call-me": {
        const actions = await this.#process({ type: "call-me" });
        const ignored = actions.find((action) => action.type === "ignored" && action.event === "call-me");
        return ignored?.type === "ignored" ? TEXT_REPLIES.notCalling(ignored.reason) : TEXT_REPLIES.calling;
      }
      case "nothing-waiting":
        return TEXT_REPLIES.nothingWaiting;
      case "too-soon":
        this.#store.appendAudit("sms.too-soon", { messageSid }, receivedAt);
        return TEXT_REPLIES.tooSoon;
      case "ambiguous":
        this.#store.appendAudit("sms.ambiguous", { messageSid, waiting: plan.waiting }, receivedAt);
        return TEXT_REPLIES.ambiguous(plan.waiting);
      case "code-mismatch": {
        // Those requests can then only be approved on a call, with the PIN.
        const burnt = Object.keys(this.#state.codes).length;
        this.#state.codes = {};
        this.#save();
        this.#store.appendAudit("sms.code-mismatch", { messageSid, burnt }, receivedAt);
        return TEXT_REPLIES.codeMismatch;
      }
      case "not-an-answer":
      case "answer": {
        const askId = plan.ask.id;
        if (plan.codeUsed) {
          // Single use: a code that matched is spent whatever happens next.
          delete this.#state.codes[askId];
          this.#save();
        }
        if (plan.type === "not-an-answer") {
          this.#store.appendAudit("sms.not-an-answer", { messageSid, reason: plan.reason }, receivedAt, {
            askId,
          });
          return replyHint(plan.ask);
        }
        await this.#process({ type: "answer", answer: plan.answer });
        // What the store holds is what the agent gets, so that is what the owner is told.
        const recorded = this.#store.getAnswer(askId)?.sourceId === messageSid;
        return recorded ? TEXT_REPLIES.answered : TEXT_REPLIES.notRecorded;
      }
    }
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
    if (!this.#state.queue.open.some((q) => q.ask.id === askId)) return;
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
    for (let event = events.shift(); event !== undefined; event = events.shift()) {
      const now = this.#options.clock();
      const { state, actions } = step(this.#state.queue, event, now, this.#options.settings);
      // The new queue state and the actions it assumes are saved together, and
      // each action is crossed off once done, so a crash in between is recovered.
      this.#state.queue = state;
      this.#state.pending = actions.filter((action) => action.type !== "ignored") as PendingAction[];
      this.#save();
      all.push(...actions);
      for (const action of actions) {
        events.push(...(await this.#execute(action, now)));
        if (action.type !== "ignored") {
          this.#state.pending.shift();
          this.#save();
        }
      }
    }
    this.#schedule();
    return all;
  }

  #save(): void {
    this.#store.putState(ORCHESTRATOR_STATE_KEY, this.#state);
    // Kept apart too, so losing the main state never resets the rate limits.
    const { callTimes, textTimes } = this.#state.queue;
    this.#store.putState(RATE_STATE_KEY, { callTimes, textTimes });
  }

  /**
   * After unreadable main state: the saved call and text times, or, if those are
   * unreadable too, hourly windows treated as full from now, so a corrupt state
   * can never set off a burst of calls or texts.
   */
  #restoreRates(): void {
    const rates = RateStateSchema.safeParse(this.#store.getState(RATE_STATE_KEY));
    const queue = this.#state.queue;
    if (rates.success) {
      queue.callTimes = rates.data.callTimes;
      queue.textTimes = rates.data.textTimes;
      return;
    }
    const now = this.#options.clock().getTime();
    const { callsPerHour, textsPerHour } = this.#options.settings.rateLimits;
    queue.callTimes = Array.from({ length: callsPerHour }, () => now);
    queue.textTimes = Array.from({ length: textsPerHour }, () => now);
    this.#store.appendAudit("orchestration.rates-reset", {}, new Date(now));
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#stopped || this.#options.autoTick === false) return;
    const now = this.#options.clock();
    const wake = nextWakeAt(this.#state.queue, now, this.#options.settings);
    if (wake === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, wake.getTime() - now.getTime()));
    this.#timer = setTimeout(() => {
      void this.tick().catch(() => {});
    }, delay);
    this.#timer.unref();
  }

  /** Why an ask must not go out now, or undefined: it closed, or its agent left. */
  #notReachable(askId: string): string | undefined {
    const ask = this.#store.getAsk(askId);
    if (ask === undefined) return "unknown ask";
    if (!OPEN.has(ask.status)) return `the ask is ${ask.status}`;
    if (this.#store.getSession(ask.sessionId)?.state === "ended") return "the session ended";
    // A fresh reading: an earlier slow send in the same step may have run past it.
    if (this.#options.clock().getTime() >= Date.parse(ask.expiresAt)) return EXPIRED;
    return undefined;
  }

  /** The queue event for an ask that must not go out: an expired one expires with its own reason. */
  #dropEvent(askId: string, why: string): QueueEvent {
    return why === EXPIRED ? { type: "tick" } : { type: "cancel", askId };
  }

  /** Carries out one action; returns the events it leads to. */
  async #execute(action: QueueAction, now: Date): Promise<QueueEvent[]> {
    switch (action.type) {
      case "place-call":
        return this.#placeCall(action.callId, action.askIds, now);
      case "end-call": {
        // No provider offers a hang-up, so the daemon stops serving the call: its
        // tool calls are no longer answered and its post-call event changes nothing.
        this.#state.calls = this.#state.calls.filter((call) => call.callId !== action.callId);
        this.#save();
        this.#store.appendAudit("call.abandoned", {}, now, { callId: action.callId });
        return [];
      }
      case "send-text":
        return this.#sendText(action.askId, action.reason, now);
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

  async #placeCall(callId: string, askIds: readonly string[], now: Date): Promise<QueueEvent[]> {
    const events: QueueEvent[] = [];
    const asks: VoiceAsk[] = [];
    for (const askId of askIds) {
      const why = this.#notReachable(askId);
      if (why !== undefined) {
        this.#store.appendAudit("ask.not-called", { reason: why }, now, { askId, callId });
        events.push(this.#dropEvent(askId, why));
        continue;
      }
      const ask = this.#store.getAsk(askId) as Ask;
      asks.push({
        askId,
        kind: ask.kind,
        nickname: this.#store.getSession(ask.sessionId)?.nickname ?? "an agent",
        text: ask.text,
        options: ask.options,
        risk: ask.risk,
        ...(ask.toolName === undefined ? {} : { toolName: ask.toolName }),
      });
    }
    const voice = this.#options.voice;
    if (asks.length === 0 || voice === undefined) {
      if (asks.length > 0)
        this.#store.appendAudit("call.failed", { reason: "no voice provider" }, now, { callId });
      events.push({ type: "call-ended", callId, result: "failed" });
      return events;
    }
    for (const ask of asks) this.#store.setAskStatus(ask.askId, "in-flight");
    try {
      const placed = await voice.callOwner({ callId, asks });
      this.#state.calls.push({
        callId,
        conversationId: placed.conversationId,
        ...(placed.callSid === undefined ? {} : { callSid: placed.callSid }),
        askIds: asks.map((ask) => ask.askId),
        placedAt: now.toISOString(),
        answers: {},
      });
      this.#save();
      this.#store.appendAudit("call.placed", { asks: asks.length }, now, { callId });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      this.#store.appendAudit("call.failed", { status: typeof status === "number" ? status : null }, now, {
        callId,
      });
      events.push({ type: "call-ended", callId, result: "failed" });
    }
    return events;
  }

  async #sendText(askId: string, reason: string, now: Date): Promise<QueueEvent[]> {
    const why = this.#notReachable(askId);
    if (why !== undefined) {
      this.#store.appendAudit("ask.not-texted", { reason: why }, now, { askId });
      return [this.#dropEvent(askId, why)];
    }
    const ask = this.#store.getAsk(askId) as Ask;
    const sms = this.#options.sms;
    // Every permission request carries a code: no text approves one without it.
    // A text sent again (say, on recovery) keeps the code the owner may already have.
    const code = ask.kind === "permission" ? (this.#state.codes[askId] ?? this.#newCode()) : undefined;
    if (sms === undefined) {
      this.#store.appendAudit("text.failed", { reason: "no SMS provider" }, now, { askId });
      return [{ type: "text-failed", askId }];
    }
    if (code !== undefined) {
      this.#state.codes[askId] = code;
      this.#save();
    }
    const nickname = this.#store.getSession(ask.sessionId)?.nickname ?? "An agent";
    try {
      await sms.sendToOwner(textFor(ask, nickname, code));
    } catch (error) {
      if (code !== undefined) {
        delete this.#state.codes[askId];
        this.#save();
      }
      const { status, code: providerCode } = error as { status?: unknown; code?: unknown };
      this.#store.appendAudit(
        "text.failed",
        {
          status: typeof status === "number" ? status : null,
          code: typeof providerCode === "number" ? providerCode : null,
        },
        now,
        { askId },
      );
      return [{ type: "text-failed", askId }];
    }
    this.#state.textedAt[askId] = this.#options.clock().toISOString();
    this.#save();
    this.#store.setAskStatus(askId, "in-flight");
    this.#store.appendAudit("text.sent", { reason, confirmationCode: code !== undefined }, now, {
      askId,
      sessionId: ask.sessionId,
    });
    return [{ type: "text-sent", askId }];
  }

  /** A random 6-digit code the redactor leaves alone and no other waiting ask has. */
  #newCode(): string | undefined {
    const outstanding = new Set(Object.values(this.#state.codes));
    for (let tries = 0; tries < 20; tries++) {
      const code = this.#options.newCode?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (/^\d{4,10}$/.test(code) && !outstanding.has(code) && this.#options.redact(code) === code)
        return code;
    }
    // No usable code: the request goes out without one and cannot be approved by text.
    return undefined;
  }

  #resolve(action: Extract<QueueAction, { type: "resolve" }>, now: Date): void {
    const { askId, outcome } = action;
    delete this.#state.codes[askId];
    delete this.#state.textedAt[askId];
    this.#save();
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
