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
  if (secret.length === 0 || header === undefined || header.length > 512) return false;
  const parts = header.split(",");
  const times = parts.filter((part) => part.startsWith("t="));
  const sigs = parts.filter((part) => part.startsWith("v0="));
  const [time] = times;
  const [presented] = sigs;
  if (times.length !== 1 || sigs.length !== 1 || time === undefined || presented === undefined) return false;
  const t = time.slice(2);
  if (!/^\d{1,12}$/.test(t)) return false;
  const age = nowSeconds - Number(t);
  if (age > POST_CALL_MAX_AGE_SECONDS || age < -POST_CALL_MAX_SKEW_SECONDS) return false;
  const expected = postCallSignature(secret, t, rawBody);
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const Turn = z.object({ role: z.string(), message: z.string().nullish() });
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
      .object({ call_duration_secs: z.number().nullish(), phone_call: PhoneCall.nullish() })
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
  role: "owner" | "agent";
  message: string;
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

/** Reduces a verified, parsed post-call body to a `PostCallEvent`, or undefined if it is malformed. */
export function parsePostCallEvent(body: unknown): PostCallEvent | undefined {
  const type = (body as { type?: unknown } | null)?.type;
  if (type === "post_call_transcription") {
    const parsed = Transcription.safeParse(body);
    if (!parsed.success) return undefined;
    const { data } = parsed.data;
    const phone = data.metadata?.phone_call;
    const direction =
      phone?.direction === "inbound" || phone?.direction === "outbound" ? phone.direction : undefined;
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
          ? [{ role: turn.role === "user" ? "owner" : "agent", message: turn.message }]
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

function words(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * True when `excerpt` (the `owner_words` the voice model sent) appears in what the
 * owner said, ignoring case and punctuation: within one owner turn, or across
 * consecutive owner turns. The voice model writes `owner_words`, so the daemon
 * (HL-09) confirms a decision against the post-call transcript with this before
 * it trusts it; agent turns never count.
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
