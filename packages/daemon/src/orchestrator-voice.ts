// Call orchestration's voice side (HL-09; split out of orchestrator.ts in
// HL-09b): placing calls to the owner, holding `submit_answer` answers, and
// confirming them against the post-call transcript before they reach the queue.
//
// A voice answer is never taken on the model's word: it is held until the
// post-call transcript confirms it (`confirmVoiceDecision`: the owner's own
// turns, after the ask was read and before the next one; an allow, the owner's
// reply to the read-back). Only confirmed answers and `unclear` reports become
// queue events; everything else (no pickup, a dropped call, a conflict, an
// unconfirmed answer, an owner who stayed unclear) is no answer.
import { Answer, type Ask, type QueueAction, type QueueEvent } from "@hotline/core";
import type { PostCallEvent, VoiceAsk, VoiceProvider } from "@hotline/providers";
import type { SubmitAnswerResult, VoiceAnswer } from "./elevenlabs-webhook.js";
import {
  dropEvent,
  type LiveCall,
  notReachable,
  type OrchestratorLog,
  type OrchestratorState,
  type PendingVoiceAnswer,
} from "./orchestrator-state.js";
import type { HotlineStore } from "./store.js";
import { answerWindows, confirmVoiceDecision, type ReadAsk } from "./voice-confirm.js";

/** Rough cost of a call minute in US cents (Twilio voice plus ElevenLabs Agents), for `hotline doctor`. */
export const CALL_CENTS_PER_MINUTE = 12;

/**
 * How a call ended, as the call log and audit record it: the queue's result, or
 * `owner-unclear` for a call the queue sees as `dropped` where every ask left
 * open was read and replied to, but no decision for it was confirmed (the owner
 * stayed unclear and the voice agent moved on, or the answer could not be
 * confirmed). The queue still gets `dropped`, which texts those asks.
 */
type CallResult = "answered" | "no-pickup" | "dropped" | "failed" | "owner-unclear";

export interface VoiceCallsOptions {
  store: HotlineStore;
  state: OrchestratorState;
  clock: () => Date;
  voice?: VoiceProvider;
  /** The orchestrator's current logger (it can be attached after construction). */
  log: () => OrchestratorLog;
  /** Steps the queue with an event and everything it leads to. */
  process: (event: QueueEvent) => Promise<QueueAction[]>;
}

function sameDecision(a: PendingVoiceAnswer["decision"], b: PendingVoiceAnswer["decision"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The calls Hotline placed and is waiting on. Every method runs inside one orchestrator step. */
export class VoiceCalls {
  readonly #store: HotlineStore;
  readonly #state: OrchestratorState;
  readonly #options: VoiceCallsOptions;

  constructor(options: VoiceCallsOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#state = options.state;
  }

  /** Whether Hotline placed this conversation and is still waiting on it. */
  placedCall(conversationId: string): boolean {
    return this.#state.data.calls.some((call) => call.conversationId === conversationId);
  }

  #callFor(conversationId: string): LiveCall | undefined {
    return this.#state.data.calls.find((call) => call.conversationId === conversationId);
  }

  /** `place-call`: reads the asks still reachable out on one call; returns the events it leads to. */
  async place(callId: string, askIds: readonly string[], now: Date): Promise<QueueEvent[]> {
    const events: QueueEvent[] = [];
    const asks: VoiceAsk[] = [];
    for (const askId of askIds) {
      const why = notReachable(this.#store, this.#options.clock, askId);
      if (why !== undefined) {
        this.#store.appendAudit("ask.not-called", { reason: why }, now, { askId, callId });
        events.push(dropEvent(askId, why));
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
      this.#state.data.calls.push({
        callId,
        conversationId: placed.conversationId,
        ...(placed.callSid === undefined ? {} : { callSid: placed.callSid }),
        askIds: asks.map((ask) => ask.askId),
        placedAt: now.toISOString(),
        answers: {},
      });
      this.#state.save();
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

  /**
   * `end-call`: no provider offers a hang-up, so the daemon stops serving the
   * call: its tool calls are no longer answered and its post-call event changes nothing.
   */
  abandon(callId: string, now: Date): void {
    this.#state.data.calls = this.#state.data.calls.filter((call) => call.callId !== callId);
    this.#state.save();
    this.#store.appendAudit("call.abandoned", {}, now, { callId });
  }

  /** `submit_answer`: holds the answer until the post-call transcript confirms it. */
  submitAnswer(answer: VoiceAnswer): SubmitAnswerResult {
    const result = this.#hold(answer);
    this.#store.appendAudit(
      "voice.answer",
      { decision: answer.decision === "unclear" ? "unclear" : answer.decision.type, result },
      answer.receivedAt,
      result === "recorded" ? { callId: this.#callFor(answer.conversationId)?.callId } : {},
    );
    return result;
  }

  #hold(voice: VoiceAnswer): SubmitAnswerResult {
    const call = this.#callFor(voice.conversationId);
    // Asks are answered only on a call Hotline placed to the owner (the inbound line is HL-10).
    if (call === undefined || voice.direction !== "outbound") return "not-recorded";
    const askId = call.askIds[voice.askNumber - 1];
    const queue = this.#state.data.queue;
    const queued = queue.open.find((q) => q.ask.id === askId);
    if (
      askId === undefined ||
      queued === undefined ||
      queued.phase !== "calling" ||
      queue.call?.id !== call.callId
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
        this.#state.save();
        return "recorded";
      }
      // A repeat of the same decision is fine; a different one means nobody can
      // tell what the owner chose, so neither counts.
      if (!earlier.conflict && sameDecision(earlier.decision, pending.decision)) return "recorded";
      earlier.conflict = true;
      this.#state.save();
      return "not-recorded";
    }
    call.answers[askId] = pending;
    this.#state.save();
    return "recorded";
  }

  /**
   * A verified post-call webhook. The held answers that the transcript confirms
   * reach the queue (through `process`) before the call's end, as the queue
   * requires. Idempotent: an event for a call that is no longer live (a replay,
   * a call given up on) changes nothing.
   */
  async postCall(event: Exclude<PostCallEvent, { type: "other" }>, receivedAt: Date): Promise<void> {
    const call = this.#callFor(event.conversationId);
    if (call === undefined) {
      this.#store.appendAudit("voice.post-call-ignored", { kind: event.type }, receivedAt);
      return;
    }
    const events: QueueEvent[] = [];
    let result: "answered" | "no-pickup" | "dropped" | "failed";
    let logged: CallResult;
    if (event.type === "initiation-failure") {
      result = event.reason === "unknown" ? "failed" : "no-pickup";
      logged = result;
    } else {
      const asks = call.askIds.map((askId) => this.#readAsk(askId));
      const settledIds = new Set<string>();
      call.askIds.forEach((askId, index) => {
        const held = call.answers[askId];
        if (held === undefined) return;
        if (held.conflict) {
          this.#store.appendAudit("voice.answer-conflict", {}, receivedAt, { askId, callId: call.callId });
          return;
        }
        if (held.decision === "unclear") {
          events.push({ type: "unclear", askId });
          settledIds.add(askId);
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
            settledIds.add(askId);
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
        settledIds.add(askId);
      });
      const ownerSpoke = event.transcript.some((turn) => turn.role === "owner");
      const open = call.askIds.flatMap((askId, index) => (settledIds.has(askId) ? [] : [{ askId, index }]));
      result = !ownerSpoke ? "no-pickup" : open.length === 0 ? "answered" : "dropped";
      // An open ask the owner replied to after it was read stayed unclear: it
      // was heard, not cut off. It is texted all the same.
      const unclear = open.filter(({ index }) =>
        (answerWindows(event.transcript, asks, index) ?? []).some((window) =>
          window.some((turn) => turn.role === "owner"),
        ),
      );
      if (result === "dropped") {
        for (const { askId } of unclear) {
          this.#store.appendAudit("voice.ask-unclear", {}, receivedAt, { askId, callId: call.callId });
        }
      }
      logged = result === "dropped" && unclear.length === open.length ? "owner-unclear" : result;
    }
    events.push({ type: "call-ended", callId: call.callId, result });
    // The call stays live (with its held answers) until every event is applied:
    // if this fails part way, ElevenLabs' retry applies them again, and events
    // already applied are ignored by the queue.
    for (const next of events) await this.#options.process(next);
    this.#state.data.calls = this.#state.data.calls.filter((other) => other !== call);
    this.#state.save();
    this.#recordCall(call, event, logged, receivedAt);
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
    result: CallResult,
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
          result === "answered" || result === "dropped" || result === "owner-unclear"
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
      this.#options.log().error({ err: error, callId: call.callId }, "could not store the call record");
    }
    this.#store.appendAudit("call.ended", { result, durationSeconds: duration }, endedAt, {
      callId: call.callId,
    });
  }
}
