// Verify by pull (HL-13a). Any process running as the owner, a coding agent
// included, can read Hotline's provider secrets (the Keychain items, the 0600
// file) and so sign a Twilio or ElevenLabs webhook itself. A signed webhook is
// therefore only a trigger: before a text reply or a call decides anything, the
// daemon fetches the message or the conversation from the provider's REST API
// and checks it here. A forger can sign a body, but it cannot make the owner's
// inbound message, or the owner's speech in a real call, exist at the provider.
//
// Every check fails closed: a pull that fails (network, 404, an answer that is
// not the record asked for) or a record that does not match means no answer.
// A mismatch is audited as a possible forgery and the owner is texted, at most
// once an hour. Reasons are fixed phrases: never bodies, numbers or words.
import {
  type ConversationRecord,
  PullError,
  type PulledMessage,
  type SmsProvider,
  sameE164,
} from "@hotline/providers";
import type { HotlineStore } from "./store.js";

/** How old a pulled inbound message may be when its webhook arrives. Twilio delivers within seconds. */
export const MAX_SMS_AGE_MS = 15 * 60 * 1000;
/** Clock skew allowed for a message stamped in the future. */
export const MAX_SMS_SKEW_MS = 5 * 60 * 1000;
/** The owner is texted about possible forgeries at most this often. */
export const FORGERY_TEXT_MS = 60 * 60 * 1000;

/** Conversation statuses of a call still going on: only then can a server tool be called. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["initiated", "in-progress"]);
/** Statuses of a finished conversation, whose transcript is complete. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);

/** Why a webhook could not be confirmed. `forgery`: the provider's record contradicts it. */
export interface Unverified {
  forgery: boolean;
  reason: string;
}

/** A failed pull: `not-found` is the mark of a forged webhook; the rest are outages. */
export function pullFailure(error: unknown): Unverified {
  if (error instanceof PullError) {
    return error.reason === "not-found"
      ? { forgery: true, reason: "the provider has no such record" }
      : { forgery: false, reason: `the provider lookup failed (${error.reason})` };
  }
  return { forgery: false, reason: "the provider lookup failed" };
}

export interface ExpectedSms {
  messageSid: string;
  /** The webhook's `Body`. */
  body: string;
  /** `config.owner.phoneNumber`. */
  ownerNumber: string;
  /** `config.sms.fromNumber`. */
  smsNumber: string;
  receivedAt: Date;
}

/**
 * Why a pulled message is not the owner's text the webhook claims, or
 * undefined when it is: the same SID, inbound, from the owner's number to the
 * Hotline number (strict E.164), the same body, and recent.
 */
export function smsMismatch(pulled: PulledMessage, expected: ExpectedSms): string | undefined {
  if (pulled.sid !== expected.messageSid) return "the provider returned another message";
  if (pulled.direction !== "inbound") return "the message is not inbound";
  if (pulled.status !== "received" && pulled.status !== "receiving") return "the message was not received";
  if (!sameE164(pulled.from, expected.ownerNumber)) return "the message is not from the owner's number";
  if (!sameE164(pulled.to, expected.smsNumber)) return "the message is not to the Hotline number";
  if (pulled.body !== expected.body) return "the message text differs from the provider's";
  const created = pulled.dateCreated?.getTime();
  if (created === undefined) return "the message has no time";
  const age = expected.receivedAt.getTime() - created;
  if (age > MAX_SMS_AGE_MS || age < -MAX_SMS_SKEW_MS) return "the message is not recent";
  return undefined;
}

/** What a server-tool call says about its call, checked against the pulled record. */
export interface ToolCallBinding {
  conversation_id: string;
  call_sid?: string | undefined;
  caller_id?: string | undefined;
  called_number?: string | undefined;
}

export interface CallRecordExpectations {
  /** `config.voice.agentId`. */
  agentId: string;
  /** `config.voice.agentPhoneNumberId`, when configured: the record's number must be it. */
  agentPhoneNumberId?: string | undefined;
  /** `config.owner.phoneNumber`. */
  ownerNumber: string;
}

/** Why a record is not this agent's conversation `conversationId`, or undefined. */
function conversationMismatch(
  record: ConversationRecord,
  conversationId: string,
  agentId: string,
): string | undefined {
  if (record.conversation_id !== conversationId) return "the provider returned another conversation";
  if (record.agent_id !== agentId) return "the conversation belongs to another agent";
  return undefined;
}

/** Why a record is not one of this agent's phone calls with the owner, or undefined. */
function callMismatch(
  record: ConversationRecord,
  conversationId: string,
  expected: CallRecordExpectations,
): string | undefined {
  const other = conversationMismatch(record, conversationId, expected.agentId);
  if (other !== undefined) return other;
  const phone = record.metadata?.phone_call;
  if (phone === undefined || phone === null) return "the conversation is not a phone call";
  if (phone.direction !== "inbound" && phone.direction !== "outbound") return "the call has no direction";
  if (!sameE164(phone.external_number, expected.ownerNumber))
    return "the call is not with the owner's number";
  if (expected.agentPhoneNumberId !== undefined && phone.phone_number_id !== expected.agentPhoneNumberId) {
    return "the call is not on the Hotline number";
  }
  return undefined;
}

/**
 * Why a pulled record is not the live call a server tool claims to come from,
 * or undefined when it is: this agent's conversation, still going on, a phone
 * call with the owner's number on the far end, on the configured Hotline
 * number, with the numbers and call SID the tool call carries.
 */
export function liveCallMismatch(
  record: ConversationRecord,
  binding: ToolCallBinding,
  expected: CallRecordExpectations,
): string | undefined {
  const mismatch = callMismatch(record, binding.conversation_id, expected);
  if (mismatch !== undefined) return mismatch;
  if (!LIVE_STATUSES.has(record.status)) return "the call is not going on";
  const phone = record.metadata?.phone_call;
  if (phone === undefined || phone === null) return "the conversation is not a phone call";
  if (binding.call_sid && phone.call_sid && binding.call_sid !== phone.call_sid) {
    return "the call SID differs from the provider's";
  }
  // Caller and called number as the provider has them, for the call's direction.
  const [caller, called] =
    phone.direction === "outbound"
      ? [phone.agent_number, phone.external_number]
      : [phone.external_number, phone.agent_number];
  const differs = (claimed: string | undefined, actual: string | null | undefined) =>
    claimed !== undefined && claimed !== "" && (typeof actual !== "string" || !sameE164(claimed, actual));
  if (differs(binding.caller_id, caller) || differs(binding.called_number, called)) {
    return "the numbers differ from the provider's";
  }
  return undefined;
}

/**
 * Whether a pulled record can stand for a post-call event: `final` when it is
 * this agent's finished conversation; `not-final` when it is still going on
 * (or being processed), so the event came too early to be ElevenLabs';
 * otherwise why it does not match. Who was on the line is not checked here: the
 * record's own metadata decides whose turns count (a stranger's never do).
 */
export function finishedCallCheck(
  record: ConversationRecord,
  conversationId: string,
  agentId: string,
): { type: "final" } | { type: "not-final" } | { type: "mismatch"; reason: string } {
  const mismatch = conversationMismatch(record, conversationId, agentId);
  if (mismatch !== undefined) return { type: "mismatch", reason: mismatch };
  return FINAL_STATUSES.has(record.status) ? { type: "final" } : { type: "not-final" };
}

/** The one text about possible forgeries. Says what happened and what to do; no numbers or words. */
export const FORGERY_TEXT =
  "Hotline: it ignored a message or call result that claimed to come from you but did not match Twilio's or ElevenLabs' records. If that was not you, something on your computer may be trying to answer for you. Nothing was approved.";

export interface ForgeryAlarmOptions {
  store: HotlineStore;
  clock: () => Date;
  sms?: SmsProvider;
}

/**
 * Audits webhooks the provider could not confirm, and texts the owner about
 * possible forgeries at most once an hour. Never throws.
 */
export class ForgeryAlarm {
  readonly #options: ForgeryAlarmOptions;
  #textedAt: number | undefined;

  constructor(options: ForgeryAlarmOptions) {
    this.#options = options;
  }

  /** One webhook that could not be confirmed with the provider. */
  async report(channel: "sms" | "voice", what: string, failure: Unverified): Promise<void> {
    const now = this.#options.clock();
    const { store } = this.#options;
    try {
      store.appendAudit(
        failure.forgery ? "security.possible-forgery" : "security.unverified",
        { channel, what, reason: failure.reason },
        now,
      );
    } catch {
      // The audit log is best effort here: the webhook is refused either way.
    }
    if (!failure.forgery) return;
    const last = this.#textedAt;
    if (last !== undefined && now.getTime() - last < FORGERY_TEXT_MS && now.getTime() >= last) return;
    this.#textedAt = now.getTime();
    const sms = this.#options.sms;
    try {
      if (sms === undefined) throw new Error("no SMS provider");
      await sms.sendToOwner(FORGERY_TEXT);
      store.appendAudit("text.sent", { reason: "possible-forgery" }, now);
    } catch {
      try {
        store.appendAudit("text.failed", { about: "possible-forgery" }, now);
      } catch {
        // Nothing more to do.
      }
    }
  }
}
