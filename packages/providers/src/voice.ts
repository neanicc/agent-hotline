// What every voice provider offers the daemon. A provider is bound to the owner's
// number when it is created, and `callOwner` takes no recipient, so no caller can
// phone anyone else. Only short, redacted summaries of each ask leave the machine.
import type { AskKind, Risk, VoiceProviderName } from "@hotline/core";
import type { ConversationRecord } from "./elevenlabs-webhook.js";
import { MAX_SPOKEN_NICKNAME_LENGTH, speakableName } from "./nickname.js";

/** One call reads out at most this many asks (the queue's `DEFAULT_MAX_ASKS_PER_CALL`). */
export const MAX_ASKS_PER_CALL = 4;
/** Longest ask text sent to the provider, after redaction. Longer text is cut. */
export const MAX_SPOKEN_ASK_LENGTH = 300;
export const MAX_SPOKEN_OPTION_LENGTH = 80;

/** One ask as the voice agent reads it out. Every string is untrusted agent text. */
export interface VoiceAsk {
  askId: string;
  kind: AskKind;
  /** Spoken name of the session that asked, such as "Claude in demo-app". */
  nickname: string;
  text: string;
  options: readonly string[];
  risk: Risk;
  toolName?: string;
}

export interface OutboundCall {
  /** The daemon's id for this call; passed to the voice agent as `hotline_call_id`. */
  callId: string;
  /** Read out in this order; the voice agent refers to them as ask 1, 2, ... */
  asks: readonly VoiceAsk[];
}

export interface PlacedCall {
  /** ElevenLabs conversation id: the key every server-tool call and the post-call webhook carry. */
  conversationId: string;
  /** Twilio call SID, when the provider reported one. */
  callSid?: string;
}

export interface VoiceProvider {
  readonly name: VoiceProviderName;
  /**
   * Phones the owner about `call.asks`. Resolves once the provider accepted the
   * call, not when it is answered; the outcome arrives through the server tools
   * and the post-call webhook. Rejects with `VoiceCallError`.
   */
  callOwner(call: OutboundCall): Promise<PlacedCall>;
  /**
   * Fetches one conversation by id from the provider (HL-13a): its status,
   * transcript and phone metadata as the provider holds them. The daemon uses
   * this record, never a webhook body, before a call decides anything. Rejects
   * with `PullError`. Without it no call can confirm a decision or a PIN.
   */
  fetchConversation?(conversationId: string): Promise<ConversationRecord>;
}

/** A call the provider refused or could not be asked to place. Never quotes the provider's response. */
export class VoiceCallError extends Error {
  override readonly name = "VoiceCallError";
  constructor(
    message: string,
    /** HTTP status of the provider's response, when there was one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The dynamic variables an outbound call carries. ElevenLabs substitutes them into the prompt as `{{name}}`. */
export interface CallVariables {
  hotline_call_id: string;
  ask_count: number;
  /**
   * The rest of the first message, which ElevenLabs speaks as is. Fixed words
   * only: no agent text, since it cannot be fenced there. The asks say who is calling.
   */
  opening: string;
  /** Every ask as numbered, redacted, length-capped lines. Untrusted agent text. */
  asks: string;
}

function cut(text: string, max: number): string {
  // Control and invisible format characters (bidi overrides, zero-width
  // spaces) and newlines go, so agent text is one plain line; angle brackets go,
  // so it cannot close its own `<agent_text>` fence; braces go, so it cannot
  // spell a `{{dynamic_variable}}` reference.
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function describeAsk(ask: VoiceAsk, index: number, redact: (text: string) => string): string {
  // Redact the whole text first, then cut, so a cut can never split a secret
  // into a piece the redactor no longer recognizes. Every agent-derived string
  // (nickname, tool name, options, text) sits inside its own fence; only the
  // fixed words around them come from Hotline.
  const fenced = (text: string, max: number) => `<agent_text>${cut(redact(text), max)}</agent_text>`;
  // The nickname is Hotline's (see `sessionNickname`), but its folder part came
  // from the agent's process, so it is reduced to a speakable name here too.
  const name = speakableName(redact(ask.nickname)) || "an unnamed session";
  const who = `<agent_text>${cut(name, MAX_SPOKEN_NICKNAME_LENGTH)}</agent_text>`;
  const what = fenced(ask.text, MAX_SPOKEN_ASK_LENGTH);
  const tool = ask.toolName === undefined ? "" : ` to use ${fenced(ask.toolName, MAX_SPOKEN_OPTION_LENGTH)}`;
  const head: Record<AskKind, string> = {
    question: "question",
    permission: `permission request${tool}, ${ask.risk === "high" ? "HIGH RISK (PIN required)" : "low risk"}`,
    stop: "finished its turn and asks what to do next",
    notify: "notification, no answer needed",
  };
  const options =
    ask.options.length === 0
      ? ""
      : ` Options: ${ask.options.map((o, i) => `${i + 1}) ${fenced(o, MAX_SPOKEN_OPTION_LENGTH)}`).join(" ")}.`;
  return `Ask ${index + 1}, from ${who}, ${head[ask.kind]}: ${what}${options}`;
}

/**
 * The redacted, length-capped dynamic variables for a call. Shared by the real
 * and fake providers so the scenario suite sees exactly what would leave the machine.
 */
export function callVariables(call: OutboundCall, redact: (text: string) => string): CallVariables {
  if (call.asks.length === 0 || call.asks.length > MAX_ASKS_PER_CALL) {
    throw new VoiceCallError(`A call covers 1 to ${MAX_ASKS_PER_CALL} asks`);
  }
  const sessions = new Set(call.asks.map((ask) => ask.nickname)).size;
  return {
    hotline_call_id: call.callId,
    ask_count: call.asks.length,
    opening:
      sessions === 1
        ? "One of your agents needs you for a sec. Got a moment?"
        : "A few of your agents need you for a sec. Got a moment?",
    asks: call.asks.map((ask, i) => describeAsk(ask, i, redact)).join("\n"),
  };
}
