// An in-memory voice provider with scripted humans, for tests and the scenario
// suite (HL-12). It keeps the real provider's rules (owner only, the same redacted
// dynamic variables) and plays the ElevenLabs side of a call deterministically:
// each scripted step becomes the server-tool call a well-behaved voice agent
// would make, sent through a `VoiceToolClient` (normally the daemon's real
// `/hooks/el/*` routes over HTTP, with the tool secret and a signed post-call
// webhook), followed by the post-call webhook.
import type { ToolName } from "./elevenlabs-agent.js";
import { POST_CALL_PATH, toolPath } from "./elevenlabs-agent.js";
import { postCallSignatureHeader } from "./elevenlabs-webhook.js";
import { requirePhoneNumber } from "./sms.js";
import type { HttpFetch } from "./twilio-sms.js";
import {
  type CallVariables,
  callVariables,
  type OutboundCall,
  type PlacedCall,
  VoiceCallError,
  type VoiceProvider,
} from "./voice.js";

/** One thing the scripted human does on a call that was picked up. */
export type HumanStep =
  /** Says (or keys) a PIN: the agent calls `verify_pin`. */
  | { kind: "pin"; digits: string }
  /** Answers ask `ask` (1-based) in `words`: the agent calls `submit_answer`. */
  | {
      kind: "answer";
      ask: number;
      decision: "option" | "allow" | "deny" | "text" | "done";
      option?: number;
      text?: string;
      words: string;
    }
  /** Stays unclear after the agent asked twice: `submit_answer` with `unclear`. */
  | { kind: "unclear"; ask: number; words: string }
  /** Asks what the agents are doing: `get_status`. */
  | { kind: "status" }
  /** Gives session `session` an instruction: `send_instruction`. */
  | { kind: "instruct"; session: number; instruction: string; words?: string }
  /** Says nothing; the agent makes no tool call. */
  | { kind: "silence" }
  /** Hangs up here; the remaining steps never happen. */
  | { kind: "hang-up" };

export type HumanScript =
  | { kind: "no-pickup" }
  | { kind: "busy" }
  /** The call could not be connected for another reason. */
  | { kind: "fail" }
  | { kind: "conversation"; steps: readonly HumanStep[] };

/** Ready-made scripts for the cases every scenario needs. */
export const scriptedHuman = {
  noPickup: (): HumanScript => ({ kind: "no-pickup" }),
  busy: (): HumanScript => ({ kind: "busy" }),
  silent: (): HumanScript => ({ kind: "conversation", steps: [{ kind: "silence" }] }),
  drops: (): HumanScript => ({ kind: "conversation", steps: [{ kind: "hang-up" }] }),
  says: (...steps: HumanStep[]): HumanScript => ({ kind: "conversation", steps }),
  allows: (ask = 1, words = "yes, go ahead"): HumanScript => ({
    kind: "conversation",
    steps: [{ kind: "answer", ask, decision: "allow", words }],
  }),
  denies: (ask = 1, words = "no, don't do that"): HumanScript => ({
    kind: "conversation",
    steps: [{ kind: "answer", ask, decision: "deny", words }],
  }),
  unclear: (ask = 1, words = "hmm, maybe, I don't know"): HumanScript => ({
    kind: "conversation",
    steps: [{ kind: "unclear", ask, words }],
  }),
  wrongPin: (digits = "0000"): HumanScript => ({
    kind: "conversation",
    steps: [
      { kind: "pin", digits },
      { kind: "pin", digits },
      { kind: "pin", digits },
    ],
  }),
};

/** Where the fake sends what ElevenLabs would send. */
export interface VoiceToolClient {
  tool(name: ToolName, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  postCall(payload: Record<string, unknown>): Promise<void>;
}

export interface HttpVoiceToolClientOptions {
  /** The daemon's webhook base, such as `http://127.0.0.1:7342/hooks`. */
  hooksUrl: string;
  toolSecret: string;
  webhookSecret: string;
  fetch: HttpFetch;
  /** Signs post-call webhooks with this time. */
  clock: () => Date;
}

/** Sends tool calls and signed post-call webhooks to the daemon's real routes. Rejects on anything but 200. */
export function httpVoiceToolClient(options: HttpVoiceToolClientOptions): VoiceToolClient {
  const post = async (path: string, body: string, headers: Record<string, string>) => {
    const response = await options.fetch(`${options.hooksUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200)
      throw new VoiceCallError(`The daemon answered HTTP ${response.status}`, response.status);
    return response;
  };
  return {
    async tool(name, body) {
      const response = await post(toolPath(name), JSON.stringify(body), {
        "x-hotline-tool-secret": options.toolSecret,
      });
      return (await response.json()) as Record<string, unknown>;
    },
    async postCall(payload) {
      const raw = JSON.stringify(payload);
      const signature = postCallSignatureHeader(options.webhookSecret, options.clock().getTime() / 1000, raw);
      await post(POST_CALL_PATH, raw, { "elevenlabs-signature": signature });
    },
  };
}

export interface FakePlacedCall {
  to: string;
  call: OutboundCall;
  /** Exactly what would have left the machine. */
  variables: CallVariables;
  conversationId: string;
  callSid: string;
}

export interface PlayedTool {
  tool: ToolName;
  body: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface PlayedCall {
  conversationId: string;
  direction: "outbound" | "inbound";
  tools: PlayedTool[];
  /** True when the human hung up, or the voice agent ended the call because a tool said so. */
  endedEarly: boolean;
}

export interface FakeVoiceOptions {
  ownerNumber: string;
  /** The Hotline number the calls come from. */
  agentNumber?: string;
  /** The agent id the post-call webhooks carry (`config.voice.agentId`). */
  agentId?: string;
  redact?: (text: string) => string;
  client: VoiceToolClient;
  /** Times the transcript turns (normally the scenario's fake clock). */
  clock?: () => Date;
}

const hex32 = (n: number) => n.toString(16).padStart(32, "0");

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = "fake";
  /** Every call placed, oldest first. */
  readonly placed: FakePlacedCall[] = [];
  /** Every call played, oldest first. */
  readonly played: PlayedCall[] = [];
  readonly #owner: string;
  readonly #agentNumber: string;
  readonly #agentId: string;
  readonly #redact: (text: string) => string;
  readonly #client: VoiceToolClient;
  readonly #clock: () => Date;
  readonly #scripts: HumanScript[] = [];
  readonly #failures: Error[] = [];
  readonly #unplayed: FakePlacedCall[] = [];
  #count = 0;

  constructor(options: FakeVoiceOptions) {
    this.#owner = requirePhoneNumber(options.ownerNumber, "The owner's number");
    this.#agentNumber = requirePhoneNumber(options.agentNumber ?? "+15555550101", "The agent's number");
    this.#agentId = options.agentId ?? "agent_fake";
    this.#redact = options.redact ?? ((text) => text);
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** How the human behaves on the next call that has no script yet. Without one, nobody picks up. */
  script(...scripts: HumanScript[]): void {
    this.#scripts.push(...scripts);
  }

  /** Makes the next `callOwner` reject, as if ElevenLabs refused the call. */
  failNext(error: Error = new VoiceCallError("ElevenLabs refused the call (HTTP 422)", 422)): void {
    this.#failures.push(error);
  }

  async callOwner(call: OutboundCall): Promise<PlacedCall> {
    const variables = callVariables(call, this.#redact);
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.#count += 1;
    const placed = {
      to: this.#owner,
      call,
      variables,
      conversationId: `conv_fake_${this.#count}`,
      callSid: `CA${hex32(this.#count)}`,
    };
    this.placed.push(placed);
    this.#unplayed.push(placed);
    return { conversationId: placed.conversationId, callSid: placed.callSid };
  }

  /** Plays every placed call not played yet, in order, each with the next script. */
  async playPending(): Promise<PlayedCall[]> {
    const results: PlayedCall[] = [];
    for (let next = this.#unplayed.shift(); next !== undefined; next = this.#unplayed.shift()) {
      results.push(await this.#play("outbound", next.conversationId, next.callSid, this.#nextScript()));
    }
    return results;
  }

  /** The owner (or `from`) calls the Hotline number and follows `script`. */
  async inboundCall(script: HumanScript, from = this.#owner): Promise<PlayedCall> {
    this.#count += 1;
    return this.#play("inbound", `conv_fake_${this.#count}`, `CA${hex32(this.#count)}`, script, from);
  }

  #nextScript(): HumanScript {
    return this.#scripts.shift() ?? { kind: "no-pickup" };
  }

  async #play(
    direction: "outbound" | "inbound",
    conversationId: string,
    callSid: string,
    script: HumanScript,
    from = this.#owner,
  ): Promise<PlayedCall> {
    const played: PlayedCall = { conversationId, direction, tools: [], endedEarly: false };
    this.played.push(played);
    if (script.kind !== "conversation") {
      const failure_reason = { "no-pickup": "no-answer", busy: "busy", fail: "unknown" }[script.kind];
      await this.#client.postCall({
        type: "call_initiation_failure",
        event_timestamp: 0,
        data: { agent_id: this.#agentId, conversation_id: conversationId, failure_reason },
      });
      return played;
    }
    const external = direction === "outbound" ? this.#owner : from;
    const binding = {
      conversation_id: conversationId,
      call_sid: callSid,
      caller_id: direction === "outbound" ? this.#agentNumber : from,
      called_number: direction === "outbound" ? this.#owner : this.#agentNumber,
    };
    const start = this.#clock().getTime();
    const transcript: { role: "user" | "agent"; message: string; time_in_call_secs: number }[] = [];
    /** One transcript turn, timed by the clock as ElevenLabs would. */
    const say = (role: "user" | "agent", message: string) =>
      transcript.push({ role, message, time_in_call_secs: (this.#clock().getTime() - start) / 1000 });
    say("agent", "Hey, it's your hotline.");
    const tool = async (name: ToolName, body: Record<string, unknown>) => {
      const response = await this.#client.tool(name, { ...binding, ...body });
      played.tools.push({ tool: name, body: { ...binding, ...body }, response });
      return response;
    };
    for (const step of script.steps) {
      if (step.kind === "hang-up") {
        played.endedEarly = true;
        break;
      }
      if (step.kind === "silence") continue;
      let response: Record<string, unknown>;
      if (step.kind === "pin") {
        say("user", step.digits);
        response = await tool("verify_pin", { pin: step.digits });
      } else if (step.kind === "answer" || step.kind === "unclear") {
        say("user", step.words);
        response = await tool("submit_answer", {
          ask_number: step.ask,
          decision: step.kind === "unclear" ? "unclear" : step.decision,
          ...(step.kind === "answer" && step.option !== undefined ? { option: step.option } : {}),
          ...(step.kind === "answer" && step.text !== undefined ? { text: step.text } : {}),
          owner_words: step.words,
        });
      } else if (step.kind === "status") {
        say("user", "What's everyone doing?");
        response = await tool("get_status", {});
      } else {
        const words = step.words ?? step.instruction;
        say("user", words);
        response = await tool("send_instruction", {
          session_number: step.session,
          instruction: step.instruction,
          owner_words: words,
        });
      }
      // A well-behaved agent ends the call when a tool says so.
      if (response.end_call === true) {
        played.endedEarly = true;
        break;
      }
    }
    await this.#client.postCall({
      type: "post_call_transcription",
      event_timestamp: 0,
      data: {
        agent_id: this.#agentId,
        conversation_id: conversationId,
        status: "done",
        transcript,
        metadata: {
          start_time_unix_secs: Math.floor(start / 1000),
          call_duration_secs: Math.ceil((this.#clock().getTime() - start) / 1000),
          phone_call: { direction, external_number: external, call_sid: callSid, type: "twilio" },
        },
      },
    });
    return played;
  }
}
