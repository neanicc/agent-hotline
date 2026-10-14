// ElevenLabs routes on the webhook listener:
//
// - POST /hooks/el/tools/{submit_answer,verify_pin,get_status,send_instruction}:
//   the voice agent's server tools. Each carries the shared tool secret in
//   `x-hotline-tool-secret`, compared in constant time; a missing header or a
//   non-JSON body is refused before the body is read.
// - POST /hooks/el/post-call: ElevenLabs' post-call webhook, verified with the
//   `ElevenLabs-Signature` HMAC over the raw body, with a timestamp tolerance and
//   a memory of recent signatures against replays.
//
// A valid secret or signature is not enough (HL-13a): a same-user process can
// read both secrets and forge either. So every webhook is only a trigger, and
// the conversation is fetched from ElevenLabs by id (`conversation`) first:
// - Every server tool, before it has any effect (a PIN attempt, a held answer
//   or instruction, a status read out), needs the conversation to exist at
//   ElevenLabs, going on, as this agent's phone call on the Hotline line with
//   the owner's number on the far end, with exactly the caller and called
//   numbers and call SID the tool call carries. Its direction is the record's:
//   outbound only for a call Hotline placed. So forged tool calls can neither
//   guess nor lock the PIN, hold or deny a decision, nor hear the status.
// - A post-call transcription hands on the pulled transcript, metadata and
//   status, never the body's, and only for this agent's finished call on the
//   Hotline line with the owner (outbound only when Hotline placed it). A
//   finished call that is not with the owner is handed on with no words in
//   it. A call still going on at ElevenLabs leaves the event unhandled for the
//   genuine one; a record that contradicts the event confirms nothing.
// - A call initiation failure is acted on only when the pulled record shows
//   that call failed: Hotline's outbound call to the owner, `failed`, with
//   nothing said. Otherwise it is ignored, so a forged one cannot end a live
//   call or start retries and texts.
// - A pull that fails for now (ElevenLabs down or refusing) gets a 503 so
//   ElevenLabs delivers the event again; nothing is handled meanwhile.
// Records that do not match go to `onUnverified`, mismatches as possible forgeries.
//
// Every rejection is the router's bare 403. JSON is parsed only after
// verification. The routes enforce the safety rules that do not need the queue:
// a call must have the owner on one end; `get_status` and `send_instruction`
// need the PIN on this call; `confirmation: "pin"` comes only from the PinGate;
// PIN guesses are limited. What an answer means is left to injected handlers
// (call orchestration, HL-09; the inbound line, HL-10), like the SMS route.
//
// Logs carry the tool name and result only: never bodies, PINs, words or numbers.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Confirmation, Decision } from "@hotline/core";
import {
  type ConversationRecord,
  conversationEvent,
  freshPostCallHeader,
  type GetStatusBody,
  type OwnerContext,
  POST_CALL_MAX_AGE_SECONDS,
  POST_CALL_PATH,
  type PostCallEvent,
  parsePostCallEvent,
  SIGNATURE_HEADER,
  sameE164,
  TOOL_BODIES,
  TOOL_SECRET_HEADER,
  type ToolBodies,
  type ToolName,
  toolPath,
  validPostCallSignature,
} from "@hotline/providers";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PinGate } from "./pin.js";
import {
  type CallRecordExpectations,
  failedCallMismatch,
  finishedCallCheck,
  liveCallDirection,
  liveCallMismatch,
  pullFailure,
  type ToolCallBinding,
  transientPullFailure,
  type Unverified,
} from "./provider-pull.js";
import type { WebhookRoute } from "./server.js";

/** Longest status text handed to the voice agent, after redaction. */
export const MAX_STATUS_LENGTH = 1500;
const SEEN_EVENTS = 1000;
/** How long a state-changing tool delivery is remembered; longer than any call. */
const TOOL_REPLAY_MS = 2 * 60 * 60 * 1000;
/** State-changing deliveries remembered at once; more are refused, not run. */
export const MAX_TOOL_DELIVERIES = 1000;
/** Tools whose repeat must not run the handler again. `get_status` only reads, after the PIN. */
const ONCE_TOOLS: ReadonlySet<ToolName> = new Set(["submit_answer", "verify_pin", "send_instruction"]);
/**
 * Results that changed state, the only ones remembered: anything else (refused
 * before the PIN, `needs-pin`, `not-recorded`, invalid, not the owner) may be
 * sent again and run again once it is allowed.
 */
const REMEMBERED_RESULTS: ReadonlySet<string> = new Set(["recorded", "queued"]);
/**
 * Post-call bodies being read or handled at once. The HMAC covers the body, so
 * it can only be checked after up to `POST_CALL_BODY_LIMIT` bytes are read; this
 * caps what unauthenticated senders can make the daemon hold.
 */
export const MAX_POST_CALLS_IN_FLIGHT = 4;
/** How long a post-call sender may take to deliver its body; a real webhook needs far less. */
export const POST_CALL_BODY_TIMEOUT_MS = 5_000;
/**
 * A post-call transcription carries the whole transcript plus analysis and
 * metadata, so it may exceed the listener's default. Bigger bodies get the bare
 * 403; ElevenLabs then retries and the asks end as "no answer".
 */
export const POST_CALL_BODY_LIMIT = 1024 * 1024;

/** What every server-tool call says about the call it came from. */
export interface ToolCall {
  conversationId: string;
  callSid?: string;
  /**
   * From ElevenLabs' record of the call: `outbound` when it dialled the owner's
   * number on a call Hotline placed; `inbound` for any other call with the
   * owner's number, which caller ID alone cannot prove.
   */
  direction: "outbound" | "inbound";
  receivedAt: Date;
}

export interface VoiceAnswer extends ToolCall {
  /** Which ask on this call, 1-based, in the order the call read them. */
  askNumber: number;
  /** The decision, or `unclear` when the owner stayed unclear after a second try. */
  decision: Decision | "unclear";
  /** The owner's words as the voice model reported them. Confirm against the transcript before trusting. */
  ownerWords: string;
  /** `pin` only when this call verified the PIN with the PinGate; never from the model. */
  confirmation: Confirmation;
}

export interface VoiceInstruction extends ToolCall {
  sessionNumber: number;
  instruction: string;
  ownerWords: string;
}

export type SubmitAnswerResult = "recorded" | "needs-pin" | "not-recorded";
/**
 * `queued`: held until the post-call transcript confirms it (HL-10).
 * `unknown-session`: not a session number the status on this call read out, or it ended.
 * `too-many`: the call, the session or all sessions have as many waiting as allowed.
 */
export type SendInstructionResult = "queued" | "unknown-session" | "too-many" | "invalid";

export interface VoiceHandlers {
  submitAnswer(answer: VoiceAnswer): SubmitAnswerResult | Promise<SubmitAnswerResult>;
  /** A short summary of every session, read out only after the PIN. Redacted and cut by the route. */
  getStatus(call: ToolCall): string | Promise<string>;
  sendInstruction(instruction: VoiceInstruction): SendInstructionResult | Promise<SendInstructionResult>;
  /** A verified post-call webhook for this agent. Throw to have ElevenLabs retry it. */
  postCall(event: Exclude<PostCallEvent, { type: "other" }>, receivedAt: Date): void | Promise<void>;
}

export interface ElevenLabsRoutesOptions {
  /** The `elevenlabs.toolSecret` secret. */
  toolSecret: string;
  /** The `elevenlabs.webhookSecret` secret, the post-call HMAC key. */
  webhookSecret: string;
  /** How long a post-call sender may take to deliver its body (default 5 s); tests shorten it. */
  postCallBodyTimeoutMs?: number;
  /** `config.voice.agentId`: post-call webhooks for any other agent are ignored. */
  agentId: string;
  /** `config.owner.phoneNumber`: a tool call is served only when the owner is on one end of the call. */
  ownerNumber: string;
  /**
   * Whether Hotline placed this conversation and is still waiting on it (call
   * orchestration, HL-09, knows). Only such a call counts as outbound; any
   * other conversation is treated as inbound and needs the PIN first.
   */
  placedCall: (conversationId: string) => boolean;
  pins: PinGate;
  clock: () => Date;
  /** Applied to everything the routes send back to ElevenLabs, such as the daemon's redactor. */
  redact: (text: string) => string;
  handlers: VoiceHandlers;
  /**
   * Fetches a conversation from ElevenLabs by id: the voice provider's
   * `fetchConversation`. Rejects with `PullError`. Required: no call confirms
   * a decision, an instruction or a PIN without it.
   */
  conversation: (conversationId: string) => Promise<ConversationRecord>;
  /** `config.voice.agentPhoneNumberId`: only a call on that ElevenLabs number is served or confirms anything. */
  agentPhoneNumberId: string;
  /** A tool call or post-call event that ElevenLabs' record does not confirm. */
  onUnverified?: (what: ToolName | "post-call", failure: Unverified) => void | Promise<void>;
}

type TranscriptionEvent = Extract<PostCallEvent, { type: "transcription" }>;

/** Whether two transcription events say the same about the call. */
function sameCall(a: TranscriptionEvent, b: TranscriptionEvent): boolean {
  const essence = (event: TranscriptionEvent) =>
    JSON.stringify([event.direction, event.externalNumber, event.callSid, event.transcript]);
  return essence(a) === essence(b);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const jsonRequest = (request: FastifyRequest) =>
  (header(request, "content-type") ?? "").toLowerCase().startsWith("application/json");

/** The raw JSON text the webhook listener kept, or undefined. */
function rawBody(request: FastifyRequest): string | undefined {
  return typeof request.body === "string" ? request.body : undefined;
}

function sameSecret(presented: string | undefined, secret: string): boolean {
  if (presented === undefined || secret.length === 0) return false;
  // Hash both sides so neither the content nor the length leaks through timing.
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toDecision(body: {
  decision: string;
  option?: number;
  text?: string;
}): Decision | "unclear" | undefined {
  switch (body.decision) {
    case "option":
      return body.option === undefined ? undefined : { type: "option", option: body.option };
    case "text":
      return body.text === undefined || body.text.trim().length === 0
        ? undefined
        : { type: "text", text: body.text };
    case "allow":
    case "deny":
    case "done":
      return { type: body.decision };
    case "unclear":
      return "unclear";
    default:
      return undefined;
  }
}

export function elevenLabsRoutes(options: ElevenLabsRoutesOptions): WebhookRoute[] {
  const { pins, handlers } = options;
  /**
   * State-changing tool deliveries by a hash of tool name and exact body, with
   * their response and when they may be forgotten, oldest first. A repeat (an
   * ElevenLabs retry or a replay) gets the first response without running the
   * handler again. A failed delivery is forgotten so a retry can get through.
   */
  const deliveries = new Map<string, { response: Promise<Record<string, unknown>>; expires: number }>();

  const toolRoute = <N extends ToolName>(
    name: N,
    serve: (body: ToolBodies[N], call: ToolCall) => Promise<Record<string, unknown>>,
  ): WebhookRoute => {
    const handleTool = async (raw: string): Promise<Record<string, unknown>> => {
      const parsed = TOOL_BODIES[name].safeParse(parseJson(raw));
      if (!parsed.success) return { result: "invalid" };
      // Someone else's call: nothing about Hotline, the owner or the agents.
      if (!ownerOnCall(parsed.data)) return refused;
      // Before any effect, ElevenLabs' own record must show this live call with
      // the owner: a forged tool call can hold, deny or hear nothing.
      const live = await liveCall(parsed.data);
      if ("failure" in live) {
        await report(name, live.failure);
        return refused;
      }
      const { conversation_id, call_sid } = parsed.data;
      const call: ToolCall = {
        conversationId: conversation_id,
        ...(call_sid ? { callSid: call_sid } : {}),
        direction: liveCallDirection(live.record, expectations),
        receivedAt: options.clock(),
      };
      return serve(parsed.data as ToolBodies[N], call);
    };

    /** Runs the tool once per distinct delivery; see `deliveries`. */
    const once = (raw: string) => {
      const now = options.clock().getTime();
      // Only expired deliveries are forgotten; one still in its window is never evicted.
      for (const [key, seen] of deliveries) {
        if (seen.expires > now) break;
        deliveries.delete(key);
      }
      const key = createHash("sha256").update(`${name}\0${raw}`, "utf8").digest("base64url");
      const seen = deliveries.get(key);
      if (seen !== undefined) return { response: seen.response, repeat: true };
      // Full of live deliveries (only possible with the tool secret): fail closed
      // rather than forget one and let it run twice.
      if (deliveries.size >= MAX_TOOL_DELIVERIES)
        return { response: Promise.resolve<Record<string, unknown>>({ result: "busy" }), repeat: false };
      // No await between the lookup and this claim, so one delivery runs the handler.
      const response = handleTool(raw);
      deliveries.set(key, { response, expires: now + TOOL_REPLAY_MS });
      // Keep only a delivery that changed state (a PIN attempt counts); forget the
      // rest, so the same call can succeed once it is allowed.
      response.then(
        (result) => {
          const changed =
            typeof result.verified === "boolean" ||
            (typeof result.result === "string" && REMEMBERED_RESULTS.has(result.result));
          if (!changed) deliveries.delete(key);
        },
        () => deliveries.delete(key),
      );
      return { response, repeat: false };
    };

    return {
      method: "POST",
      url: toolPath(name),
      // The secret needs no body, so a wrong one is refused before the body is read.
      precheck: (request) =>
        sameSecret(header(request, TOOL_SECRET_HEADER), options.toolSecret) && jsonRequest(request),
      verify: (request) => sameSecret(header(request, TOOL_SECRET_HEADER), options.toolSecret),
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const raw = rawBody(request) ?? "";
        const { response, repeat } = ONCE_TOOLS.has(name)
          ? once(raw)
          : { response: handleTool(raw), repeat: false };
        const result = await response;
        request.log.info({ tool: name, result: result.result ?? result.verified, repeat }, "voice tool");
        return reply.code(200).send(result);
      },
    };
  };

  // Strict E.164 on both sides: no number variant collides with or slips past the owner's.
  const isOwner = (number: string | undefined) => sameE164(number, options.ownerNumber);
  const ownerOnCall = (body: GetStatusBody) => isOwner(body.caller_id) || isOwner(body.called_number);

  const refused = { result: "refused", end_call: true };
  const pinRequired = { result: "pin-required", say: "Ask for the PIN and call verify_pin first." };

  const expectations: CallRecordExpectations = {
    agentId: options.agentId,
    ownerNumber: options.ownerNumber,
    agentPhoneNumberId: options.agentPhoneNumberId,
    placedCall: options.placedCall,
  };
  const ownerContext: OwnerContext = {
    ownerNumber: options.ownerNumber,
    pinVerifiedAt: (conversationId) => pins.verifiedAt(conversationId),
    placedCall: options.placedCall,
  };
  const report = async (what: ToolName | "post-call", failure: Unverified) => {
    try {
      await options.onUnverified?.(what, failure);
    } catch {
      // Reporting is best effort; the request is refused either way.
    }
  };

  /** ElevenLabs' record of a conversation, or why it could not be had (`transient`: try again later). */
  const pull = async (
    conversationId: string,
  ): Promise<{ record: ConversationRecord } | { failure: Unverified; transient: boolean }> => {
    try {
      return { record: await options.conversation(conversationId) };
    } catch (error) {
      return { failure: pullFailure(error), transient: transientPullFailure(error) };
    }
  };

  /** ElevenLabs' record when it shows this tool call's live call with the owner, or why not. */
  const liveCall = async (
    binding: ToolCallBinding,
  ): Promise<{ record: ConversationRecord } | { failure: Unverified }> => {
    const pulled = await pull(binding.conversation_id);
    if ("failure" in pulled) return { failure: pulled.failure };
    const reason = liveCallMismatch(pulled.record, binding, expectations);
    return reason === undefined ? { record: pulled.record } : { failure: { forgery: true, reason } };
  };

  type Handled = Exclude<PostCallEvent, { type: "other" }>;
  /** What to do with a post-call event: hand `event` on, ignore it, or have ElevenLabs send it again. */
  type Verdict = { type: "handle"; event: Handled } | { type: "ignore" } | { type: "retry" };

  /**
   * The post-call transcription as ElevenLabs' record has it: the pulled
   * transcript, metadata and status, never the webhook body's.
   * - A call with the owner as the record has it is handed on as pulled.
   * - A finished call that is not with the owner is handed on without its
   *   words, so it is still recorded but nothing said on it counts.
   * - A record that contradicts the event, or no record at all, becomes a
   *   failed call: nothing confirmed, every ask no answer.
   * - A call still going on is ignored, so the genuine event still counts; a
   *   pull that failed for now is retried.
   */
  const verifiedTranscription = async (event: TranscriptionEvent): Promise<Verdict> => {
    const failedCall: Verdict = {
      type: "handle",
      event: {
        type: "initiation-failure",
        agentId: event.agentId,
        conversationId: event.conversationId,
        reason: "unknown",
      },
    };
    const pulled = await pull(event.conversationId);
    if ("failure" in pulled) {
      await report("post-call", pulled.failure);
      return pulled.transient ? { type: "retry" } : failedCall;
    }
    const { record } = pulled;
    const check = finishedCallCheck(record, event.conversationId, expectations);
    if (check.type === "not-final") {
      await report("post-call", { forgery: true, reason: "the call is not over at the provider" });
      return { type: "ignore" };
    }
    if (check.type === "mismatch") {
      await report("post-call", { forgery: true, reason: check.reason });
      return failedCall;
    }
    const pulledEvent = conversationEvent(record, ownerContext);
    if (!sameCall(event, pulledEvent)) {
      await report("post-call", { forgery: true, reason: "the webhook differs from the provider's record" });
    }
    if (check.type === "no-owner") return { type: "handle", event: { ...pulledEvent, transcript: [] } };
    return { type: "handle", event: pulledEvent };
  };

  /**
   * A call initiation failure, acted on only when ElevenLabs' record shows that
   * call of Hotline's really failed. Otherwise it is ignored (and a pull that
   * failed for now retried), so a forged one cannot end a live call, nor start
   * retries and texts.
   */
  const verifiedFailure = async (
    event: Extract<Handled, { type: "initiation-failure" }>,
  ): Promise<Verdict> => {
    const pulled = await pull(event.conversationId);
    if ("failure" in pulled) {
      await report("post-call", pulled.failure);
      return pulled.transient ? { type: "retry" } : { type: "ignore" };
    }
    const failure = failedCallMismatch(pulled.record, event.conversationId, expectations);
    if (failure !== undefined) {
      await report("post-call", failure);
      return { type: "ignore" };
    }
    return { type: "handle", event };
  };

  const routes: WebhookRoute[] = [
    toolRoute("submit_answer", async (body, call) => {
      // Caller ID can be spoofed: on an inbound call nothing is answered before the PIN.
      if (call.direction === "inbound" && !pins.isVerified(call.conversationId)) return pinRequired;
      const decision = toDecision(body);
      if (decision === undefined) return { result: "invalid" };
      const result = await handlers.submitAnswer({
        ...call,
        askNumber: body.ask_number,
        decision,
        ownerWords: body.owner_words,
        confirmation: pins.isVerified(call.conversationId) ? "pin" : "none",
      });
      return { result };
    }),
    toolRoute("verify_pin", async (body, call) => {
      // The route already checked ElevenLabs has this call, going on now with
      // the owner: a forged tool call for a made-up conversation never spends
      // an attempt, so it can neither guess the PIN nor lock it out.
      const attempt = await pins.attempt(call.conversationId, body.pin, call.direction);
      return { verified: attempt.verified, attempts_left: attempt.attemptsLeft, end_call: attempt.endCall };
    }),
    toolRoute("get_status", async (_body, call) => {
      if (!pins.isVerified(call.conversationId)) return pinRequired;
      const status = cut(options.redact(await handlers.getStatus(call)), MAX_STATUS_LENGTH);
      return { result: "ok", status };
    }),
    toolRoute("send_instruction", async (body, call) => {
      if (!pins.isVerified(call.conversationId)) return pinRequired;
      const result = await handlers.sendInstruction({
        ...call,
        sessionNumber: body.session_number,
        instruction: body.instruction,
        ownerWords: body.owner_words,
      });
      return { result };
    }),
  ];

  /** Events whose handler succeeded, with when they may be forgotten, oldest first. */
  const handled = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  routes.push({
    method: "POST",
    url: POST_CALL_PATH,
    bodyLimit: POST_CALL_BODY_LIMIT,
    maxInFlight: MAX_POST_CALLS_IN_FLIGHT,
    bodyTimeoutMs: options.postCallBodyTimeoutMs ?? POST_CALL_BODY_TIMEOUT_MS,
    // A well-formed, fresh signature header is required before a slot is taken
    // and the body read; only the HMAC itself needs the body.
    precheck: (request) =>
      freshPostCallHeader(header(request, SIGNATURE_HEADER), Math.floor(options.clock().getTime() / 1000)) !==
        undefined && jsonRequest(request),
    verify: (request) => {
      const raw = rawBody(request);
      return (
        raw !== undefined &&
        validPostCallSignature(
          options.webhookSecret,
          raw,
          header(request, SIGNATURE_HEADER),
          Math.floor(options.clock().getTime() / 1000),
        )
      );
    },
    handler: async (request, reply) => {
      const receivedAt = options.clock();
      // The body only names the event: every event is checked against the
      // pulled record, and a transcription's own content is never used.
      const event = parsePostCallEvent(parseJson(rawBody(request)), ownerContext);
      if (event === undefined || event.type === "other" || event.agentId !== options.agentId) {
        request.log.info({ kind: event?.type ?? "malformed" }, "post-call webhook ignored");
        return reply.code(200).send({});
      }
      // One delivery per event and conversation, whatever the signature header
      // looks like, so a replay (or a retry after success) is not handled twice.
      const key = `${event.type}:${event.conversationId}`;
      // Only expired events are forgotten; a live one is never evicted.
      for (const [seen, expires] of handled) {
        if (expires > receivedAt.getTime()) break;
        handled.delete(seen);
      }
      let pending = inFlight.get(key);
      while (pending !== undefined) {
        await pending.catch(() => {});
        pending = inFlight.get(key);
      }
      if (handled.has(key)) {
        request.log.info({ kind: event.type }, "duplicate post-call webhook ignored");
        return reply.code(200).send({});
      }
      if (handled.size >= SEEN_EVENTS) {
        // Full of live events: ask ElevenLabs to retry later rather than forget one.
        request.log.warn("post-call webhook deferred: replay memory full");
        return reply.code(503).send();
      }
      // No await between the check above and this claim, so one attempt runs at a time.
      const attempt = Promise.resolve().then(async (): Promise<Verdict["type"]> => {
        const verdict =
          event.type === "transcription" ? await verifiedTranscription(event) : await verifiedFailure(event);
        if (verdict.type !== "handle") return verdict.type;
        await handlers.postCall(verdict.event, receivedAt);
        return "handle";
      });
      inFlight.set(
        key,
        attempt.then(
          () => undefined,
          () => undefined,
        ),
      );
      let outcome: Verdict["type"];
      try {
        outcome = await attempt;
        // Kept past the signature's age limit, after which a replay fails verification anyway.
        if (outcome === "handle") {
          handled.set(key, receivedAt.getTime() + (POST_CALL_MAX_AGE_SECONDS + 5 * 60) * 1000);
        }
      } finally {
        inFlight.delete(key);
      }
      request.log.info({ kind: event.type, handled: outcome === "handle" }, "post-call webhook");
      // ElevenLabs could not be asked: have it deliver the event again rather than lose it.
      if (outcome === "retry") return reply.code(503).send();
      return reply.code(200).send({});
    },
  });
  return routes;
}
