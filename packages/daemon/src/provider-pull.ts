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
import { PhoneNumber } from "@hotline/core";
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

/**
 * Whether a failed pull may succeed when the webhook comes again: the provider
 * could not be reached or refused for now. Not for a record it does not have,
 * an answer that is not one, or a provider that cannot pull at all.
 */
export function transientPullFailure(error: unknown): boolean {
  return !(error instanceof PullError) || error.reason === "unreachable" || error.reason === "refused";
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
  /** `config.voice.agentPhoneNumberId`: the record must be on that ElevenLabs number. */
  agentPhoneNumberId: string;
  /** `config.owner.phoneNumber`. */
  ownerNumber: string;
  /** Whether Hotline placed this conversation and still waits on it (call orchestration knows). */
  placedCall: (conversationId: string) => boolean;
}

type PhoneCall = NonNullable<NonNullable<ConversationRecord["metadata"]>["phone_call"]>;
type LinePhoneCall = PhoneCall & { direction: "inbound" | "outbound" };

const isE164 = (value: unknown): value is string =>
  typeof value === "string" && PhoneNumber.safeParse(value).success;

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

/**
 * The record's phone call when it is one on the Hotline line, or why not: it
 * has a direction, the Hotline end is a strict E.164 number that is not the
 * owner's, and it is on the configured phone number id. Who is on the far end
 * is left to the caller.
 */
function hotlineLine(
  record: ConversationRecord,
  expected: CallRecordExpectations,
): { phone: LinePhoneCall; reason?: undefined } | { reason: string } {
  const phone = record.metadata?.phone_call;
  if (phone === undefined || phone === null) return { reason: "the conversation is not a phone call" };
  const direction = phone.direction;
  if (direction !== "inbound" && direction !== "outbound") return { reason: "the call has no direction" };
  if (!isE164(phone.agent_number) || sameE164(phone.agent_number, expected.ownerNumber)) {
    return { reason: "the call is not on a Hotline number" };
  }
  if (phone.phone_number_id !== expected.agentPhoneNumberId) {
    return { reason: "the call is not on the Hotline number" };
  }
  return { phone: { ...phone, direction } };
}

/** This agent's phone call on the Hotline line with the owner on the far end, or why the record is not one. */
function ownerCall(
  record: ConversationRecord,
  conversationId: string,
  expected: CallRecordExpectations,
): { phone: LinePhoneCall; reason?: undefined } | { reason: string } {
  const other = conversationMismatch(record, conversationId, expected.agentId);
  if (other !== undefined) return { reason: other };
  const line = hotlineLine(record, expected);
  if (line.reason !== undefined) return line;
  if (!sameE164(line.phone.external_number, expected.ownerNumber)) {
    return { reason: "the call is not with the owner's number" };
  }
  return line;
}

/** A call SID as a comparable value: absent, null and empty all mean none. */
const sidOf = (value: string | null | undefined) =>
  value === undefined || value === null || value === "" ? undefined : value;

/**
 * Why a pulled record is not the live call a server tool claims to come from,
 * or undefined when it is: this agent's conversation, still going on, a phone
 * call on the Hotline line with the owner's number on the far end, and both
 * the caller and the called number (strict E.164, both required) and the call
 * SID exactly as the provider has them.
 */
export function liveCallMismatch(
  record: ConversationRecord,
  binding: ToolCallBinding,
  expected: CallRecordExpectations,
): string | undefined {
  const call = ownerCall(record, binding.conversation_id, expected);
  if (call.reason !== undefined) return call.reason;
  const { phone } = call;
  if (!LIVE_STATUSES.has(record.status)) return "the call is not going on";
  if (sidOf(binding.call_sid) !== sidOf(phone.call_sid)) return "the call SID differs from the provider's";
  // Caller and called number as the provider has them, for the call's direction.
  const [caller, called] =
    phone.direction === "outbound"
      ? [phone.agent_number, phone.external_number]
      : [phone.external_number, phone.agent_number];
  const same = (claimed: string | undefined, actual: string | null | undefined) =>
    typeof actual === "string" && sameE164(claimed, actual);
  if (!same(binding.caller_id, caller) || !same(binding.called_number, called)) {
    return "the numbers differ from the provider's";
  }
  return undefined;
}

/**
 * The direction a confirmed live call counts as: outbound only when the
 * provider dialled out and Hotline placed that conversation. Anything else
 * needs the PIN, as an inbound call does.
 */
export function liveCallDirection(
  record: ConversationRecord,
  expected: CallRecordExpectations,
): "inbound" | "outbound" {
  return record.metadata?.phone_call?.direction === "outbound" && expected.placedCall(record.conversation_id)
    ? "outbound"
    : "inbound";
}

/**
 * What a pulled record says about a post-call transcription event:
 * - `final`: this agent's finished call on the Hotline line with the owner,
 *   outbound only if Hotline placed it and inbound only if it did not;
 * - `no-owner`: a finished call on the Hotline line that is not a call with
 *   the owner: a stranger calling in, or an outbound call Hotline does not
 *   wait on (given up on). Nothing said on it may count;
 * - `not-final`: still going on (or being processed), so the event came too
 *   early to be ElevenLabs';
 * - `mismatch`: anything else, with why.
 */
export function finishedCallCheck(
  record: ConversationRecord,
  conversationId: string,
  expected: CallRecordExpectations,
): { type: "final" } | { type: "no-owner" } | { type: "not-final" } | { type: "mismatch"; reason: string } {
  const other = conversationMismatch(record, conversationId, expected.agentId);
  if (other !== undefined) return { type: "mismatch", reason: other };
  if (!FINAL_STATUSES.has(record.status)) return { type: "not-final" };
  const line = hotlineLine(record, expected);
  if (line.reason !== undefined) return { type: "mismatch", reason: line.reason };
  const { phone } = line;
  if (!isE164(phone.external_number)) return { type: "mismatch", reason: "the call has no other number" };
  const placed = expected.placedCall(conversationId);
  if (phone.direction === "inbound" && placed) {
    return { type: "mismatch", reason: "the provider has a call Hotline placed as inbound" };
  }
  if (phone.direction === "outbound" && !placed) return { type: "no-owner" };
  if (!sameE164(phone.external_number, expected.ownerNumber)) {
    return phone.direction === "inbound"
      ? { type: "no-owner" }
      : { type: "mismatch", reason: "the call is not with the owner's number" };
  }
  return { type: "final" };
}

/**
 * Why a pulled record does not show that the call a `call_initiation_failure`
 * event names really failed, or undefined when it does: this agent's
 * conversation, `failed` at the provider, an outbound call on the Hotline line
 * to the owner's number that Hotline placed, with no words from the person in
 * it. `forgery` is false only when there is no call of Hotline's to act on.
 */
export function failedCallMismatch(
  record: ConversationRecord,
  conversationId: string,
  expected: CallRecordExpectations,
): Unverified | undefined {
  const call = ownerCall(record, conversationId, expected);
  if (call.reason !== undefined) return { forgery: true, reason: call.reason };
  if (!FINAL_STATUSES.has(record.status)) {
    return { forgery: true, reason: "the call is going on at the provider" };
  }
  if (record.status !== "failed") return { forgery: true, reason: "the call did not fail at the provider" };
  if (call.phone.direction !== "outbound")
    return { forgery: true, reason: "the failed call is not outbound" };
  if (record.transcript.some((turn) => turn.role === "user")) {
    return { forgery: true, reason: "the call was answered at the provider" };
  }
  if (!expected.placedCall(conversationId)) {
    return { forgery: false, reason: "the failed call is not one Hotline waits on" };
  }
  return undefined;
}

/**
 * The one text about possible forgeries. Says what happened and what to do; no
 * numbers or words. It promises nothing about approvals: when a post-call body
 * differs from ElevenLabs' record, the record is still used, and what the owner
 * really said on that call may approve a request.
 */
export const FORGERY_TEXT =
  "Hotline: it got a message or call result that claimed to come from you but did not match Twilio's or ElevenLabs' records. It used only their records, never what that claim said. If that was not you, something on your computer may be trying to answer for you.";

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
