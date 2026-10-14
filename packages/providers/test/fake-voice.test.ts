import { describe, expect, it } from "vitest";
import {
  FakeVoiceProvider,
  type HttpFetch,
  httpVoiceToolClient,
  type OutboundCall,
  parsePostCallEvent,
  scriptedHuman,
  type ToolName,
  VoiceCallError,
  type VoiceToolClient,
  validPostCallSignature,
} from "../src/index.js";

const OWNER = "+15555550100";

interface Recorded {
  tools: { name: ToolName; body: Record<string, unknown> }[];
  postCalls: Record<string, unknown>[];
}

/** A client that answers like the daemon would, from canned responses. */
function recordingClient(responses: Partial<Record<ToolName, Record<string, unknown>[]>> = {}) {
  const recorded: Recorded = { tools: [], postCalls: [] };
  const client: VoiceToolClient = {
    async tool(name, body) {
      recorded.tools.push({ name, body });
      return responses[name]?.shift() ?? { result: "recorded" };
    },
    async postCall(payload) {
      recorded.postCalls.push(payload);
    },
  };
  return { client, recorded };
}

const call: OutboundCall = {
  callId: "call-1",
  asks: [
    {
      askId: "ask-1",
      kind: "permission",
      nickname: "Codex in api",
      text: "Run rm -rf build with token hl08-fake-token-abc",
      options: [],
      risk: "low",
      toolName: "Bash",
    },
  ],
};

describe("FakeVoiceProvider", () => {
  it("calls only the owner, with the real provider's redacted variables", async () => {
    const { client } = recordingClient();
    const voice = new FakeVoiceProvider({
      ownerNumber: OWNER,
      client,
      redact: (text) => text.replace(/hl08-fake-token-\w+/g, "[REDACTED]"),
    });
    const placed = await voice.callOwner(call);
    expect(placed).toEqual({ conversationId: "conv_fake_1", callSid: `CA${"1".padStart(32, "0")}` });
    expect(voice.placed[0]?.to).toBe(OWNER);
    expect(voice.placed[0]?.variables.asks).toContain("[REDACTED]");
    // What would have left the machine; `call` is the daemon's own copy.
    expect(JSON.stringify(voice.placed[0]?.variables)).not.toContain("hl08-fake-token");
  });

  it("nobody picks up when no script was given", async () => {
    const { client, recorded } = recordingClient();
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    await voice.callOwner(call);
    await voice.playPending();
    expect(recorded.tools).toEqual([]);
    expect(recorded.postCalls.map((body) => parsePostCallEvent(body))).toEqual([
      {
        type: "initiation-failure",
        agentId: "agent_fake",
        conversationId: "conv_fake_1",
        reason: "no-answer",
      },
    ]);
  });

  it.each([
    ["busy", scriptedHuman.busy(), "busy"],
    ["fail", { kind: "fail" } as const, "unknown"],
  ])("reports a %s line as an initiation failure", async (_name, script, reason) => {
    const { client, recorded } = recordingClient();
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    voice.script(script);
    await voice.callOwner(call);
    await voice.playPending();
    expect(parsePostCallEvent(recorded.postCalls[0])).toMatchObject({ reason });
  });

  it("turns an answer into submit_answer bound to the call, then a transcript with the owner's words", async () => {
    const { client, recorded } = recordingClient();
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    voice.script(scriptedHuman.allows(1, "yes, go ahead"));
    await voice.callOwner(call);
    const [played] = await voice.playPending();
    expect(recorded.tools).toEqual([
      {
        name: "submit_answer",
        body: {
          conversation_id: "conv_fake_1",
          call_sid: `CA${"1".padStart(32, "0")}`,
          caller_id: "+15555550101",
          called_number: OWNER,
          ask_number: 1,
          decision: "allow",
          owner_words: "yes, go ahead",
        },
      },
    ]);
    expect(played?.endedEarly).toBe(false);
    const event = parsePostCallEvent(recorded.postCalls[0], { ownerNumber: OWNER, pinVerified: () => false });
    expect(event).toMatchObject({ type: "transcription", direction: "outbound", externalNumber: OWNER });
    expect(event?.type === "transcription" && event.transcript).toContainEqual({
      role: "owner",
      message: "yes, go ahead",
    });
  });

  it("plays silence, an unclear answer and a hang-up without inventing a decision", async () => {
    const { client, recorded } = recordingClient();
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    voice.script(scriptedHuman.silent(), scriptedHuman.unclear(), scriptedHuman.drops());
    await voice.callOwner(call);
    await voice.callOwner(call);
    await voice.callOwner(call);
    const played = await voice.playPending();
    expect(recorded.tools.map((t) => [t.name, t.body.decision])).toEqual([["submit_answer", "unclear"]]);
    expect(played.map((p) => p.endedEarly)).toEqual([false, false, true]);
    expect(recorded.postCalls).toHaveLength(3);
  });

  it("stops guessing PINs as soon as verify_pin says to end the call", async () => {
    const { client, recorded } = recordingClient({
      verify_pin: [
        { verified: false, attempts_left: 1, end_call: false },
        { verified: false, attempts_left: 0, end_call: true },
      ],
    });
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    const played = await voice.inboundCall(scriptedHuman.wrongPin());
    expect(recorded.tools.map((t) => t.name)).toEqual(["verify_pin", "verify_pin"]);
    expect(played.endedEarly).toBe(true);
    expect(recorded.tools[0]?.body).toMatchObject({ caller_id: OWNER, called_number: "+15555550101" });
  });

  it("plays an inbound status call and instruction from another number when told to", async () => {
    const { client, recorded } = recordingClient();
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
    await voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: "4821" },
        { kind: "status" },
        { kind: "instruct", session: 2, instruction: "now write the tests" },
      ),
      "+15555550199",
    );
    expect(recorded.tools.map((t) => t.name)).toEqual(["verify_pin", "get_status", "send_instruction"]);
    expect(recorded.tools[2]?.body).toMatchObject({
      caller_id: "+15555550199",
      session_number: 2,
      instruction: "now write the tests",
      owner_words: "now write the tests",
    });
  });

  it("can refuse the next call like ElevenLabs would", async () => {
    const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client: recordingClient().client });
    voice.failNext();
    await expect(voice.callOwner(call)).rejects.toBeInstanceOf(VoiceCallError);
    expect(voice.placed).toEqual([]);
    await expect(voice.callOwner(call)).resolves.toMatchObject({ conversationId: "conv_fake_1" });
  });
});

describe("httpVoiceToolClient", () => {
  it("sends the tool secret and a valid post-call signature, and rejects non-200 answers", async () => {
    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    let status = 200;
    const fetch: HttpFetch = async (url, init) => {
      requests.push({ url, headers: init.headers, body: init.body });
      return { status, json: async () => ({ verified: true }) };
    };
    const now = new Date("2026-10-13T22:00:00.000Z");
    const client = httpVoiceToolClient({
      hooksUrl: "http://127.0.0.1:9/hooks",
      toolSecret: "fake-tool-secret",
      webhookSecret: "fake-webhook-secret",
      fetch,
      clock: () => now,
    });
    expect(await client.tool("verify_pin", { pin: "1234" })).toEqual({ verified: true });
    await client.postCall({ type: "post_call_transcription" });
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:9/hooks/el/tools/verify_pin",
      headers: { "x-hotline-tool-secret": "fake-tool-secret", "content-type": "application/json" },
    });
    const post = requests[1];
    expect(post?.url).toBe("http://127.0.0.1:9/hooks/el/post-call");
    expect(
      validPostCallSignature(
        "fake-webhook-secret",
        post?.body ?? "",
        post?.headers["elevenlabs-signature"],
        now.getTime() / 1000,
      ),
    ).toBe(true);
    status = 403;
    await expect(client.tool("get_status", {})).rejects.toBeInstanceOf(VoiceCallError);
  });
});
