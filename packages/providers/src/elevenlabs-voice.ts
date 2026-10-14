// ElevenLabs Agents outbound calls through their native Twilio integration:
// POST /v1/convai/twilio/outbound-call with `agent_id`, `agent_phone_number_id`,
// `to_number` and the call's dynamic variables, authenticated with `xi-api-key`.
// https://elevenlabs.io/docs/api-reference/twilio/outbound-call
//
// A small hand-written REST call rather than the `@elevenlabs/elevenlabs-js` SDK:
// Hotline sends one request type, and a required injected `fetch` means no test
// can reach the network.
import { type ConversationRecord, parseConversation } from "./elevenlabs-webhook.js";
import { PullError, pullJson } from "./pull.js";
import { requirePhoneNumber } from "./sms.js";
import type { HttpFetch } from "./twilio-sms.js";
import {
  callVariables,
  type OutboundCall,
  type PlacedCall,
  VoiceCallError,
  type VoiceProvider,
} from "./voice.js";

export const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
export const OUTBOUND_CALL_PATH = "/v1/convai/twilio/outbound-call";
/** Where one conversation is fetched: `${CONVERSATIONS_PATH}/{conversation_id}`. */
export const CONVERSATIONS_PATH = "/v1/convai/conversations";
export const DEFAULT_ELEVENLABS_TIMEOUT_MS = 15_000;

export interface ElevenLabsVoiceOptions {
  /** The `elevenlabs.apiKey` secret. */
  apiKey: string;
  /** `config.voice.agentId`: the agent created from `hotlineAgentConfig`. */
  agentId: string;
  /** `config.voice.agentPhoneNumberId`: the Twilio number imported into ElevenLabs. */
  agentPhoneNumberId: string;
  /** The only number this provider will ever call. */
  ownerNumber: string;
  /** Applied to every string about an ask before it is sent, such as the daemon's redactor. */
  redact: (text: string) => string;
  /** Required, so nothing can reach the real API by accident. */
  fetch: HttpFetch;
  timeoutMs?: number;
}

const ELEVENLABS_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  readonly #options: ElevenLabsVoiceOptions;

  constructor(options: ElevenLabsVoiceOptions) {
    if (options.apiKey.length === 0) throw new TypeError("The ElevenLabs API key is empty");
    if (!ELEVENLABS_ID.test(options.agentId)) throw new TypeError("The ElevenLabs agent id is malformed");
    if (!ELEVENLABS_ID.test(options.agentPhoneNumberId)) {
      throw new TypeError("The ElevenLabs phone number id is malformed");
    }
    requirePhoneNumber(options.ownerNumber, "The owner's number");
    this.#options = options;
  }

  /**
   * GET /v1/convai/conversations/{conversation_id} (HL-13a).
   * https://elevenlabs.io/docs/api-reference/conversations/get
   * Rejects with `PullError`: `not-found` for an id ElevenLabs does not know,
   * `malformed` for a body that is not that conversation. The daemon checks
   * the agent id, status and numbers itself.
   */
  async fetchConversation(conversationId: string): Promise<ConversationRecord> {
    const { apiKey, fetch, timeoutMs } = this.#options;
    if (!ELEVENLABS_ID.test(conversationId)) {
      throw new PullError("The conversation id is malformed", "malformed");
    }
    const body = await pullJson(
      fetch,
      `${ELEVENLABS_API_ORIGIN}${CONVERSATIONS_PATH}/${conversationId}`,
      { "xi-api-key": apiKey },
      timeoutMs ?? DEFAULT_ELEVENLABS_TIMEOUT_MS,
      "ElevenLabs",
    );
    const record = parseConversation(body);
    if (record === undefined || record.conversation_id !== conversationId) {
      throw new PullError("ElevenLabs' answer is not the conversation asked for", "malformed");
    }
    return record;
  }

  async callOwner(call: OutboundCall): Promise<PlacedCall> {
    const { apiKey, agentId, agentPhoneNumberId, ownerNumber, redact, fetch, timeoutMs } = this.#options;
    const body = JSON.stringify({
      agent_id: agentId,
      agent_phone_number_id: agentPhoneNumberId,
      to_number: ownerNumber,
      conversation_initiation_client_data: { dynamic_variables: callVariables(call, redact) },
    });
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await fetch(`${ELEVENLABS_API_ORIGIN}${OUTBOUND_CALL_PATH}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_ELEVENLABS_TIMEOUT_MS),
      });
    } catch (error) {
      // Only a system error code, never the error itself, which can quote the request.
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
      const reason =
        typeof cause?.code === "string" && /^[A-Z_]{1,40}$/.test(cause.code) ? ` (${cause.code})` : "";
      throw new VoiceCallError(`Could not reach ElevenLabs${reason}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      // Never ElevenLabs' message text: it can echo the request, numbers included.
      throw new VoiceCallError(`ElevenLabs refused the call (HTTP ${response.status})`, response.status);
    }
    const result = (parsed ?? {}) as { success?: unknown; conversation_id?: unknown; callSid?: unknown };
    if (result.success !== true) {
      throw new VoiceCallError("ElevenLabs could not place the call", response.status);
    }
    if (typeof result.conversation_id !== "string" || !ELEVENLABS_ID.test(result.conversation_id)) {
      throw new VoiceCallError("ElevenLabs' response did not include a conversation id", response.status);
    }
    const callSid =
      typeof result.callSid === "string" && /^CA[0-9a-f]{32}$/.test(result.callSid)
        ? result.callSid
        : undefined;
    return { conversationId: result.conversation_id, ...(callSid === undefined ? {} : { callSid }) };
  }
}
