// Call orchestration's text side (HL-09; split out of orchestrator.ts in
// HL-09b): sending an ask to the owner by text with its confirmation code, and
// applying the owner's replies. `owner-texts.ts` decides what a reply means
// (pure); this file carries the plan out against the queue and the store.
//
// A text answer is accepted only for the one ask Hotline texted that is still
// open, and every permission request needs `YES <code>` with a random,
// single-use code that dies with the ask. The store keeps only each code's
// salted hash (HL-13a). Texts reach this file only from the
// owner's number on a verified webhook, once per message SID (remembered in
// the store across restarts).
import { randomInt } from "node:crypto";
import type { Ask, QueueAction, QueueEvent } from "@hotline/core";
import type { SmsProvider } from "@hotline/providers";
import { codeMatches, hashCode } from "./code-hash.js";
import {
  dropEvent,
  notReachable,
  type OrchestratorLog,
  type OrchestratorState,
} from "./orchestrator-state.js";
import { planTextReply, replyHint, replyKind, TEXT_REPLIES, textFor } from "./owner-texts.js";
import type { OwnerSms } from "./sms-webhook.js";
import type { HotlineStore } from "./store.js";

export interface OwnerTextsOptions {
  store: HotlineStore;
  state: OrchestratorState;
  clock: () => Date;
  sms?: SmsProvider;
  /** The daemon's redactor; a confirmation code it would change is never used. */
  redact: (text: string) => string;
  /** For tests: the next confirmation code. Default: 6 random digits. */
  newCode?: () => string;
  /** The reply to a `status` text: what every live session is doing. */
  status?: () => string;
  /** The orchestrator's current logger (it can be attached after construction). */
  log: () => OrchestratorLog;
  /** Steps the queue with an event and everything it leads to. */
  process: (event: QueueEvent) => Promise<QueueAction[]>;
}

/** Texts to and from the owner. Every method runs inside one orchestrator step. */
export class OwnerTexts {
  readonly #store: HotlineStore;
  readonly #state: OrchestratorState;
  readonly #options: OwnerTextsOptions;

  constructor(options: OwnerTextsOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#state = options.state;
  }

  /** `send-text`: texts one ask to the owner; returns the events it leads to. */
  async send(askId: string, reason: string, now: Date): Promise<QueueEvent[]> {
    const why = notReachable(this.#store, this.#options.clock, askId);
    if (why !== undefined) {
      this.#store.appendAudit("ask.not-texted", { reason: why }, now, { askId });
      return [dropEvent(askId, why)];
    }
    const ask = this.#store.getAsk(askId) as Ask;
    const sms = this.#options.sms;
    const state = this.#state.data;
    // Every permission request carries a code: no text approves one without it.
    // Only its salted hash is kept (HL-13a), so a text sent again (say, on
    // recovery) cannot repeat the code: it carries a fresh one, which replaces
    // the old. The earlier text's code, if it ever went out, then no longer works.
    if (sms === undefined) {
      this.#store.appendAudit("text.failed", { reason: "no SMS provider" }, now, { askId });
      return [{ type: "text-failed", askId }];
    }
    const code = ask.kind === "permission" ? this.#newCode(askId) : undefined;
    if (code !== undefined) {
      state.codes[askId] = hashCode(code);
      this.#state.save();
    } else if (state.codes[askId] !== undefined) {
      delete state.codes[askId];
      this.#state.save();
    }
    const nickname = this.#store.getSession(ask.sessionId)?.nickname ?? "An agent";
    try {
      await sms.sendToOwner(textFor(ask, nickname, code));
    } catch (error) {
      if (code !== undefined) {
        delete this.#state.data.codes[askId];
        this.#state.save();
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
    this.#state.data.textedAt[askId] = this.#options.clock().toISOString();
    this.#state.save();
    this.#store.setAskStatus(askId, "in-flight");
    this.#store.appendAudit("text.sent", { reason, confirmationCode: code !== undefined }, now, {
      askId,
      sessionId: ask.sessionId,
    });
    return [{ type: "text-sent", askId }];
  }

  /** A random 6-digit code the redactor leaves alone and no other waiting ask has. */
  #newCode(askId: string): string | undefined {
    const outstanding = Object.entries(this.#state.data.codes).flatMap(([id, hash]) =>
      id === askId ? [] : [hash],
    );
    for (let tries = 0; tries < 20; tries++) {
      const code = this.#options.newCode?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (
        /^\d{4,10}$/.test(code) &&
        this.#options.redact(code) === code &&
        !outstanding.some((hash) => codeMatches(code, hash))
      )
        return code;
    }
    // No usable code: the request goes out without one and cannot be approved by text.
    return undefined;
  }

  /** Tells the owner, once, about texts a crash interrupted: they may not have counted. */
  async reportInterrupted(now: Date): Promise<void> {
    const interrupted = this.#store.unfinishedInboundMessages();
    if (interrupted.length === 0) return;
    for (const messageSid of interrupted) this.#store.finishInboundMessage(messageSid);
    this.#store.appendAudit("sms.interrupted", { count: interrupted.length }, now);
    try {
      await this.#options.sms?.sendToOwner(TEXT_REPLIES.interrupted);
    } catch (error) {
      this.#options.log().warn({ err: error }, "could not tell the owner about interrupted texts");
    }
  }

  /**
   * A verified text from the owner's number. Handled once per message SID, also
   * across restarts. Returns the reply to send back, if any.
   */
  async ownerText(message: OwnerSms): Promise<string | undefined> {
    if (this.#store.inboundMessageHandled(message.messageSid)) return undefined;
    // Claimed before any effect, so a redelivery after a crash part way through
    // can never apply the same words again, say to a different waiting ask. A
    // failure after this point loses the text (no answer), and the owner is told
    // so: in the reply here, or by text on the next start after a crash.
    this.#store.markInboundMessage(message.messageSid, message.receivedAt);
    try {
      return await this.#handle(message);
    } catch (error) {
      this.#options.log().error({ err: error, messageSid: message.messageSid }, "owner text failed");
      this.#store.appendAudit("sms.failed", { messageSid: message.messageSid }, message.receivedAt);
      return TEXT_REPLIES.notHandled;
    } finally {
      this.#store.finishInboundMessage(message.messageSid);
    }
  }

  async #handle({
    messageSid,
    body,
    receivedAt,
    writtenAt,
    optOutType,
  }: OwnerSms): Promise<string | undefined> {
    this.#store.appendAudit("sms.received", { messageSid, reply: replyKind(body) }, receivedAt);
    const state = this.#state.data;
    // Recorded by `ownerText` just before; a fresh claim reads `receivedAt`.
    const claimedAt = this.#store.inboundMessageFirstSeen(messageSid) ?? receivedAt;
    const plan = planTextReply({
      body,
      messageSid,
      receivedAt,
      // The earlier of the daemon's first sight and Twilio's own time: a text
      // written before a request went out can never answer it, even if its
      // webhook only arrives (or is replayed) later.
      firstSeenAt:
        writtenAt !== undefined && writtenAt.getTime() < claimedAt.getTime() ? writtenAt : claimedAt,
      optedOut: optOutType !== undefined,
      waiting: state.queue.open
        .filter((q) => q.texted && q.duplicateOf === undefined)
        .map((q) => {
          const codeHash = state.codes[q.ask.id];
          const sent = state.textedAt[q.ask.id];
          return {
            ask: q.ask,
            ...(codeHash === undefined ? {} : { codeHash }),
            ...(sent === undefined ? {} : { sentAt: new Date(sent) }),
          };
        }),
    });
    switch (plan.type) {
      case "ignore":
        return undefined;
      case "status":
        // The webhook only lets the owner's number through, and the reply goes
        // back to that number: a spoofed sender never sees it.
        return this.#options.status?.() ?? TEXT_REPLIES.statusUnavailable;
      case "call-me": {
        const actions = await this.#options.process({ type: "call-me" });
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
        const burnt = Object.keys(state.codes).length;
        state.codes = {};
        this.#state.save();
        this.#store.appendAudit("sms.code-mismatch", { messageSid, burnt }, receivedAt);
        return TEXT_REPLIES.codeMismatch;
      }
      case "not-an-answer":
      case "answer": {
        const askId = plan.ask.id;
        if (plan.codeUsed) {
          // Single use: a code that matched is spent whatever happens next.
          delete state.codes[askId];
          this.#state.save();
        }
        if (plan.type === "not-an-answer") {
          this.#store.appendAudit("sms.not-an-answer", { messageSid, reason: plan.reason }, receivedAt, {
            askId,
          });
          return replyHint(plan.ask);
        }
        await this.#options.process({ type: "answer", answer: plan.answer });
        // What the store holds is what the agent gets, so that is what the owner is told.
        const recorded = this.#store.getAnswer(askId)?.sourceId === messageSid;
        return recorded ? TEXT_REPLIES.answered : TEXT_REPLIES.notRecorded;
      }
    }
  }
}
