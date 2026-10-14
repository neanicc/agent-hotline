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
  type GetStatusBody,
  POST_CALL_MAX_AGE_SECONDS,
  POST_CALL_PATH,
  type PostCallEvent,
  parsePostCallEvent,
  SIGNATURE_HEADER,
  TOOL_BODIES,
  TOOL_SECRET_HEADER,
  type ToolBodies,
  type ToolName,
  toolPath,
  validPostCallSignature,
} from "@hotline/providers";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PinGate } from "./pin.js";
import type { WebhookRoute } from "./server.js";

/** Longest status text handed to the voice agent, after redaction. */
export const MAX_STATUS_LENGTH = 1500;
const SEEN_EVENTS = 1000;

/** What every server-tool call says about the call it came from. */
export interface ToolCall {
  conversationId: string;
  callSid?: string;
  /**
   * `outbound` when the call went to the owner's number (Hotline dialled it);
   * `inbound` when it came from the owner's number, which caller ID alone
   * cannot prove.
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
export type SendInstructionResult = "queued" | "unknown-session";

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
  /** `config.voice.agentId`: post-call webhooks for any other agent are ignored. */
  agentId: string;
  /** `config.owner.phoneNumber`: a tool call is served only when the owner is on one end of the call. */
  ownerNumber: string;
  pins: PinGate;
  clock: () => Date;
  /** Applied to everything the routes send back to ElevenLabs, such as the daemon's redactor. */
  redact: (text: string) => string;
  handlers: VoiceHandlers;
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

  const toolRoute = <N extends ToolName>(
    name: N,
    serve: (body: ToolBodies[N], call: ToolCall) => Promise<Record<string, unknown>>,
  ): WebhookRoute => ({
    method: "POST",
    url: toolPath(name),
    precheck: (request) => header(request, TOOL_SECRET_HEADER) !== undefined && jsonRequest(request),
    verify: (request) => sameSecret(header(request, TOOL_SECRET_HEADER), options.toolSecret),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = TOOL_BODIES[name].safeParse(parseJson(rawBody(request)));
      let response: Record<string, unknown>;
      if (!parsed.success) {
        response = { result: "invalid" };
      } else if (!ownerOnCall(parsed.data)) {
        // Someone else's call: nothing about Hotline, the owner or the agents.
        response = { result: "refused", end_call: true };
      } else {
        const { conversation_id, call_sid } = parsed.data;
        const call: ToolCall = {
          conversationId: conversation_id,
          ...(call_sid ? { callSid: call_sid } : {}),
          direction: callDirection(parsed.data),
          receivedAt: options.clock(),
        };
        response = await serve(parsed.data as ToolBodies[N], call);
      }
      request.log.info({ tool: name, result: response.result ?? response.verified }, "voice tool");
      return reply.code(200).send(response);
    },
  });

  const ownerOnCall = (body: GetStatusBody) =>
    body.caller_id === options.ownerNumber || body.called_number === options.ownerNumber;
  // Only a call to the owner's number from somewhere else is one Hotline placed;
  // anything else that passed `ownerOnCall` came in from (what claims to be) the owner.
  const callDirection = (body: GetStatusBody): ToolCall["direction"] =>
    body.called_number === options.ownerNumber && body.caller_id !== options.ownerNumber
      ? "outbound"
      : "inbound";

  const pinRequired = { result: "pin-required", say: "Ask for the PIN and call verify_pin first." };

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
      const attempt = await pins.attempt(call.conversationId, body.pin);
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
    precheck: (request) => header(request, SIGNATURE_HEADER) !== undefined && jsonRequest(request),
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
      // Turns count as the owner's only on a call known to be with the owner.
      const event = parsePostCallEvent(parseJson(rawBody(request)), {
        ownerNumber: options.ownerNumber,
        pinVerified: (conversationId) => pins.isVerified(conversationId),
      });
      if (event === undefined || event.type === "other" || event.agentId !== options.agentId) {
        request.log.info({ kind: event?.type ?? "malformed" }, "post-call webhook ignored");
        return reply.code(200).send({});
      }
      // One delivery per event and conversation, whatever the signature header
      // looks like, so a replay (or a retry after success) is not handled twice.
      const key = `${event.type}:${event.conversationId}`;
      for (const [seen, expires] of handled) {
        if (expires > receivedAt.getTime() && handled.size <= SEEN_EVENTS) break;
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
      // No await between the check above and this claim, so one attempt runs at a time.
      const attempt = Promise.resolve().then(() => handlers.postCall(event, receivedAt));
      inFlight.set(key, attempt);
      try {
        await attempt;
        // Kept past the signature's age limit, after which a replay fails verification anyway.
        handled.set(key, receivedAt.getTime() + (POST_CALL_MAX_AGE_SECONDS + 5 * 60) * 1000);
      } finally {
        inFlight.delete(key);
      }
      request.log.info({ kind: event.type }, "post-call webhook");
      return reply.code(200).send({});
    },
  });
  return routes;
}
