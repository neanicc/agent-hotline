// ElevenLabs post-call webhooks: the `ElevenLabs-Signature` HMAC and the payloads.
//
// Signature algorithm, from the SDK's `constructEvent`
// (https://github.com/elevenlabs/elevenlabs-js/blob/278c39c0984ef55590749b92e6d0ef947abcee96/src/wrapper/webhooks.ts),
// which https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
// points to for verification:
//
//   header  = "t=<unix seconds>,v0=<hex HMAC-SHA256(secret, "<t>.<raw body>")>"
//
// The SDK rejects a timestamp more than 30 minutes old. Hotline also rejects one
// more than 5 minutes in the future, and compares in constant time.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sameE164 } from "./sms.js";

export const SIGNATURE_HEADER = "elevenlabs-signature";
/** The SDK's tolerance for an old timestamp. */
export const POST_CALL_MAX_AGE_SECONDS = 30 * 60;
/** Clock skew allowed for a timestamp from the future. */
export const POST_CALL_MAX_SKEW_SECONDS = 5 * 60;

/** `v0=<hex>` for this timestamp and raw body. */
export function postCallSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}

/** The full header value ElevenLabs would send. Used by the fake provider and tests. */
export function postCallSignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  const t = String(Math.floor(timestamp));
  return `t=${t},${postCallSignature(secret, t, rawBody)}`;
}

/**
 * The timestamp and `v0=` hash of a well-formed, fresh signature header, or
 * undefined. Needs no body, so a route can refuse a stale or malformed header
 * before reading one: exactly one `t` (digits) and one `v0` (64 lower-case hex
 * digits), with the timestamp within the tolerance of `nowSeconds`.
 */
export function freshPostCallHeader(
  header: string | undefined,
  nowSeconds: number,
): { timestamp: string; hash: string } | undefined {
  if (header === undefined || header.length > 512) return undefined;
  const parts = header.split(",");
  const times = parts.filter((part) => part.startsWith("t="));
  const sigs = parts.filter((part) => part.startsWith("v0="));
  const [time] = times;
  const [hash] = sigs;
  if (times.length !== 1 || sigs.length !== 1 || time === undefined || hash === undefined) return undefined;
  const timestamp = time.slice(2);
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(hash)) return undefined;
  const age = nowSeconds - Number(timestamp);
  if (age > POST_CALL_MAX_AGE_SECONDS || age < -POST_CALL_MAX_SKEW_SECONDS) return undefined;
  return { timestamp, hash };
}

/**
 * True only for a well-formed header whose HMAC matches `rawBody` under `secret`
 * and whose timestamp is within the tolerance of `nowSeconds`. Fails closed on an
 * empty secret, a missing or repeated `t`/`v0`, or a non-numeric timestamp.
 */
export function validPostCallSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSeconds: number,
): boolean {
  if (secret.length === 0) return false;
  const fresh = freshPostCallHeader(header, nowSeconds);
  if (fresh === undefined) return false;
  const expected = postCallSignature(secret, fresh.timestamp, rawBody);
  const a = createHash("sha256").update(fresh.hash, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const Turn = z.object({
  role: z.string(),
  message: z.string().nullish(),
  time_in_call_secs: z.number().nullish(),
});
const PhoneCall = z.object({
  direction: z.string().nullish(),
  external_number: z.string().nullish(),
  call_sid: z.string().nullish(),
});

const Transcription = z.object({
  type: z.literal("post_call_transcription"),
  event_timestamp: z.number(),
  data: z.object({
    agent_id: z.string().min(1),
    conversation_id: z.string().min(1).max(128),
    status: z.string(),
    transcript: z.array(Turn).default([]),
    metadata: z
      .object({
        start_time_unix_secs: z.number().nullish(),
        call_duration_secs: z.number().nullish(),
        phone_call: PhoneCall.nullish(),
      })
      .nullish(),
  }),
});

const InitiationFailure = z.object({
  type: z.literal("call_initiation_failure"),
  event_timestamp: z.number(),
  data: z.object({
    agent_id: z.string().min(1),
    conversation_id: z.string().min(1).max(128),
    failure_reason: z.string(),
  }),
});

export interface TranscriptTurn {
  /**
   * `owner` only for a call known to be with the owner (see `OwnerContext`);
   * any other person on the line is a `caller`, whose words never count.
   */
  role: "owner" | "caller" | "agent";
  message: string;
}

/** What the daemon knows that makes a caller's turns the owner's. */
export interface OwnerContext {
  /** `config.owner.phoneNumber`. */
  ownerNumber: string;
  /** When this conversation passed `verify_pin` (the daemon's PinGate), if it did. */
  pinVerifiedAt: (conversationId: string) => Date | undefined;
  /** Whether Hotline placed this conversation; only then is an outbound call the owner's. */
  placedCall: (conversationId: string) => boolean;
}

/**
 * From when (unix seconds) the person on the line counts as the owner, or
 * undefined if never: from the start of an outbound call to the owner's number
 * (Hotline dialled it), or after the PIN on an inbound call from the owner's
 * number, since caller ID can be spoofed and words said before the PIN prove
 * nothing.
 */
function ownerFrom(
  owner: OwnerContext | undefined,
  conversationId: string,
  direction: "inbound" | "outbound" | undefined,
  externalNumber: string | null | undefined,
): number | undefined {
  if (owner === undefined || !sameE164(externalNumber, owner.ownerNumber)) return undefined;
  if (direction === "outbound") {
    return owner.placedCall(conversationId) ? Number.NEGATIVE_INFINITY : undefined;
  }
  if (direction !== "inbound") return undefined;
  const verifiedAt = owner.pinVerifiedAt(conversationId);
  return verifiedAt === undefined ? undefined : verifiedAt.getTime() / 1000;
}

/** A verified post-call webhook, reduced to what the daemon uses. Transcripts stay on this machine. */
export type PostCallEvent =
  | {
      type: "transcription";
      agentId: string;
      conversationId: string;
      /** ElevenLabs' conversation status, such as `done` or `failed`. */
      status: string;
      direction?: "inbound" | "outbound";
      /** The phone on the other end: the owner's, for every call Hotline places. */
      externalNumber?: string;
      callSid?: string;
      durationSeconds?: number;
      transcript: TranscriptTurn[];
    }
  | {
      type: "initiation-failure";
      agentId: string;
      conversationId: string;
      /** `busy` and `no-answer` mean nobody picked up; anything else is a failure. */
      reason: "busy" | "no-answer" | "unknown";
    }
  /** Another webhook type (such as `post_call_audio`), acknowledged and ignored. */
  | { type: "other" };

/**
 * Reduces a verified, parsed post-call body to a `PostCallEvent`, or undefined if
 * it is malformed. Without `owner`, or when the call is not known to be with the
 * owner, the person's turns are labelled `caller`.
 */
export function parsePostCallEvent(body: unknown, owner?: OwnerContext): PostCallEvent | undefined {
  const type = (body as { type?: unknown } | null)?.type;
  if (type === "post_call_transcription") {
    const parsed = Transcription.safeParse(body);
    if (!parsed.success) return undefined;
    const { data } = parsed.data;
    const phone = data.metadata?.phone_call;
    const direction =
      phone?.direction === "inbound" || phone?.direction === "outbound" ? phone.direction : undefined;
    const from = ownerFrom(owner, data.conversation_id, direction, phone?.external_number);
    const start = data.metadata?.start_time_unix_secs;
    /** A turn is the owner's only when it is known to come after `from`; an unknown time is not. */
    const person = (turn: z.infer<typeof Turn>): "owner" | "caller" => {
      if (from === undefined) return "caller";
      if (from === Number.NEGATIVE_INFINITY) return "owner";
      const at =
        typeof start === "number" && typeof turn.time_in_call_secs === "number"
          ? start + turn.time_in_call_secs
          : undefined;
      return at !== undefined && at > from ? "owner" : "caller";
    };
    return {
      type: "transcription",
      agentId: data.agent_id,
      conversationId: data.conversation_id,
      status: data.status,
      ...(direction === undefined ? {} : { direction }),
      ...(phone?.external_number ? { externalNumber: phone.external_number } : {}),
      ...(phone?.call_sid ? { callSid: phone.call_sid } : {}),
      ...(typeof data.metadata?.call_duration_secs === "number"
        ? { durationSeconds: data.metadata.call_duration_secs }
        : {}),
      transcript: data.transcript.flatMap((turn): TranscriptTurn[] =>
        (turn.role === "user" || turn.role === "agent") && typeof turn.message === "string"
          ? [{ role: turn.role === "agent" ? "agent" : person(turn), message: turn.message }]
          : [],
      ),
    };
  }
  if (type === "call_initiation_failure") {
    const parsed = InitiationFailure.safeParse(body);
    if (!parsed.success) return undefined;
    const { data } = parsed.data;
    const reason =
      data.failure_reason === "busy" || data.failure_reason === "no-answer" ? data.failure_reason : "unknown";
    return {
      type: "initiation-failure",
      agentId: data.agent_id,
      conversationId: data.conversation_id,
      reason,
    };
  }
  return typeof type === "string" ? { type: "other" } : undefined;
}

/** Apostrophe look-alikes a transcript may use, as in "don’t". */
const APOSTROPHES = /[’‘ʼ`´′＇]/g;

/**
 * Spoken text in a canonical form for comparing words: NFKC first (fullwidth
 * letters, ligatures), then lower case, apostrophe look-alikes as `'`, and any
 * combining mark left over dropped. The one normalisation every owner-words
 * check uses (`ownerSaid`, the daemon's voice and instruction confirmation),
 * so the same words can never pass one check and fail another.
 */
export function normalizeSpeech(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(/\p{M}+/gu, "");
}

/** The words of `text`: `normalizeSpeech`, then split on anything but letters and digits. */
export function speechTokens(text: string): string[] {
  return normalizeSpeech(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function words(text: string): string {
  return speechTokens(text).join(" ");
}

/**
 * True when `excerpt` (the `owner_words` the voice model sent) appears in what the
 * owner said, ignoring case and punctuation: within one owner turn, or across
 * consecutive owner turns. The voice model writes `owner_words`, so the daemon
 * (HL-09) confirms a decision against the post-call transcript with this before
 * it trusts it; agent and `caller` turns never count.
 */
export function ownerSaid(excerpt: string, transcript: readonly TranscriptTurn[]): boolean {
  const wanted = words(excerpt);
  if (wanted.length === 0) return false;
  let run = "";
  for (const turn of transcript) {
    if (turn.role !== "owner") {
      run = "";
      continue;
    }
    run = run.length === 0 ? words(turn.message) : `${run} ${words(turn.message)}`;
    if (` ${run} `.includes(` ${wanted} `)) return true;
  }
  return false;
}
