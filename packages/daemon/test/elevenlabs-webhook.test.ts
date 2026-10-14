import {
  FakeVoiceProvider,
  type HttpFetch,
  httpVoiceToolClient,
  postCallSignatureHeader,
  scriptedHuman,
} from "@hotline/providers";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookServer,
  createRedactor,
  type ElevenLabsRoutesOptions,
  elevenLabsRoutes,
  type LogOptions,
  MAX_STATUS_LENGTH,
  PinGate,
  POST_CALL_BODY_LIMIT,
  type SubmitAnswerResult,
  type ToolCall,
  type VoiceAnswer,
  type VoiceHandlers,
  type VoiceInstruction,
} from "../src/index.js";

const OWNER = "+15555550100";
const AGENT_NUMBER = "+15555550101";
const STRANGER = "+15555550199";
const TOOL_SECRET = "fake-tool-secret-for-tests-0001";
const WEBHOOK_SECRET = "fake-webhook-secret-for-tests-01";
const AGENT_ID = "agent_fake";
const PIN = "4821";

/**
 * The log text without the numbers pino and Fastify add themselves (`time`,
 * `pid`, `responseTime`), which can contain any digits and made PIN checks flaky.
 */
function loggedText(logLines: readonly string[]): string {
  return logLines
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      delete entry.time;
      delete entry.pid;
      delete entry.responseTime;
      return JSON.stringify(entry);
    })
    .join("\n");
}

let lines: string[];
let now: Date;
let app: FastifyInstance;
let answers: VoiceAnswer[];
let instructions: VoiceInstruction[];
let statusCalls: ToolCall[];
let postCalls: unknown[];
let answerResult: SubmitAnswerResult;
let status: string;
let failPostCall: number;
let pins: PinGate;
let redactor: ReturnType<typeof createRedactor>;

function server(overrides: Partial<ElevenLabsRoutesOptions> = {}): FastifyInstance {
  const log: LogOptions = { level: "info", destination: { write: (line) => lines.push(line) }, redactor };
  const handlers: VoiceHandlers = {
    submitAnswer: (answer) => {
      answers.push(answer);
      return answerResult;
    },
    getStatus: (call) => {
      statusCalls.push(call);
      return status;
    },
    sendInstruction: (instruction) => {
      instructions.push(instruction);
      return "queued";
    },
    postCall: (event) => {
      if (failPostCall > 0) {
        failPostCall -= 1;
        throw new Error("store unavailable");
      }
      postCalls.push(event);
    },
  };
  return buildWebhookServer({
    log,
    routes: elevenLabsRoutes({
      toolSecret: TOOL_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      agentId: AGENT_ID,
      ownerNumber: OWNER,
      pins,
      clock: () => now,
      redact: (text) => redactor.text(text),
      handlers,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  lines = [];
  now = new Date("2026-10-13T22:00:00.000Z");
  answers = [];
  instructions = [];
  statusCalls = [];
  postCalls = [];
  answerResult = "recorded";
  status = "1. Claude in demo-app: working on the tests.";
  failPostCall = 0;
  redactor = createRedactor([TOOL_SECRET, WEBHOOK_SECRET]);
  pins = new PinGate({
    check: async (pin) => pin === PIN,
    clock: () => now,
    onVerified: (pin) => redactor.addShortSecret(pin),
  });
  app = server();
});

afterEach(async () => {
  await app.close();
});

const binding = (conversation = "conv_1") => ({
  conversation_id: conversation,
  call_sid: `CA${"0".repeat(31)}1`,
  caller_id: AGENT_NUMBER,
  called_number: OWNER,
});

interface ToolOptions {
  secret?: string | null;
  contentType?: string;
  raw?: string;
}

function tool(
  name: string,
  body: Record<string, unknown>,
  { secret = TOOL_SECRET, contentType, raw }: ToolOptions = {},
) {
  const headers: Record<string, string> = { "content-type": contentType ?? "application/json" };
  if (secret !== null) headers["x-hotline-tool-secret"] = secret;
  return app.inject({
    method: "POST",
    url: `/hooks/el/tools/${name}`,
    headers,
    payload: raw ?? JSON.stringify(body),
  });
}

const answer = (extra: Record<string, unknown> = {}, conversation = "conv_1") =>
  tool("submit_answer", {
    ...binding(conversation),
    ask_number: 1,
    decision: "allow",
    owner_words: "yes, go ahead",
    ...extra,
  });

describe("server tools: authentication", () => {
  it.each([
    ["no secret header", { secret: null }],
    ["a wrong secret", { secret: "wrong-secret" }],
    ["a secret one character short", { secret: TOOL_SECRET.slice(0, -1) }],
    ["a form body", { contentType: "application/x-www-form-urlencoded", raw: "decision=allow" }],
    ["malformed JSON without the secret", { secret: null, raw: "{not json" }],
    ["malformed JSON with a wrong secret", { secret: "nope", raw: "{not json" }],
    ["an unsupported content type", { contentType: "text/plain", raw: "allow" }],
  ] as const)("answers a bare 403 to %s, and no handler runs", async (_name, options) => {
    for (const name of ["submit_answer", "verify_pin", "get_status", "send_instruction"]) {
      const response = await tool(
        name,
        { ...binding(), pin: PIN, ask_number: 1, decision: "allow" },
        options,
      );
      expect([response.statusCode, response.body], name).toEqual([403, ""]);
    }
    expect([answers, instructions, statusCalls]).toEqual([[], [], []]);
    expect(pins.isVerified("conv_1")).toBe(false);
  });

  it("answers an unknown tool path with the same bare 403", async () => {
    const response = await tool("approve_everything", binding());
    expect([response.statusCode, response.body]).toEqual([403, ""]);
  });

  it("refuses a call without the owner on either end, revealing nothing", async () => {
    const response = await answer({ ...binding(), caller_id: STRANGER, called_number: AGENT_NUMBER });
    expect(response.json()).toEqual({ result: "refused", end_call: true });
    const missing = await tool("get_status", { conversation_id: "conv_1" });
    expect(missing.json()).toEqual({ result: "refused", end_call: true });
    expect(answers).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  it("answers an authenticated but malformed request with invalid", async () => {
    expect((await tool("submit_answer", {}, { raw: "{not json" })).json()).toEqual({ result: "invalid" });
    expect((await answer({ ask_number: 9 })).json()).toEqual({ result: "invalid" });
    expect((await answer({ decision: "option" })).json()).toEqual({ result: "invalid" });
    expect((await answer({ decision: "text", text: "  " })).json()).toEqual({ result: "invalid" });
    expect(answers).toEqual([]);
  });
});

describe("submit_answer", () => {
  it("hands the decision and the owner's words to the handler, unconfirmed without a PIN", async () => {
    const response = await answer();
    expect(response.json()).toEqual({ result: "recorded" });
    expect(answers).toEqual([
      {
        conversationId: "conv_1",
        callSid: `CA${"0".repeat(31)}1`,
        direction: "outbound",
        receivedAt: now,
        askNumber: 1,
        decision: { type: "allow" },
        ownerWords: "yes, go ahead",
        confirmation: "none",
      },
    ]);
  });

  it("never takes a confirmation from the request body", async () => {
    await answer({ confirmation: "pin", pin_verified: true });
    expect(answers[0]?.confirmation).toBe("none");
  });

  it("confirms with the PIN only after verify_pin succeeded on the same call", async () => {
    await tool("verify_pin", { ...binding("conv_2"), pin: PIN });
    await answer({}, "conv_1");
    await answer({}, "conv_2");
    expect(answers.map((a) => [a.conversationId, a.confirmation])).toEqual([
      ["conv_1", "none"],
      ["conv_2", "pin"],
    ]);
  });

  it.each([
    [
      { decision: "option", option: 2 },
      { type: "option", option: 2 },
    ],
    [{ decision: "deny" }, { type: "deny" }],
    [{ decision: "done" }, { type: "done" }],
    [
      { decision: "text", text: "now write the tests" },
      { type: "text", text: "now write the tests" },
    ],
    [{ decision: "unclear" }, "unclear"],
  ])("maps %j", async (body, decision) => {
    await answer(body);
    expect(answers[0]?.decision).toEqual(decision);
  });

  it("refuses an answer on an inbound call until the PIN, since caller ID can be spoofed", async () => {
    const inbound = { caller_id: OWNER, called_number: AGENT_NUMBER };
    expect((await answer({ ...inbound, decision: "deny" })).json()).toMatchObject({ result: "pin-required" });
    // A call claiming the owner on both ends counts as inbound too.
    expect((await answer({ caller_id: OWNER, called_number: OWNER })).json()).toMatchObject({
      result: "pin-required",
    });
    expect(answers).toEqual([]);
    await tool("verify_pin", { ...binding(), ...inbound, pin: PIN });
    expect((await answer({ ...inbound, decision: "deny" })).json()).toEqual({ result: "recorded" });
    expect(answers.map((a) => [a.direction, a.decision, a.confirmation])).toEqual([
      ["inbound", { type: "deny" }, "pin"],
    ]);
  });

  it("accepts a low-risk answer on an outbound call without the PIN", async () => {
    expect((await answer()).json()).toEqual({ result: "recorded" });
    expect(answers.map((a) => [a.direction, a.confirmation])).toEqual([["outbound", "none"]]);
  });

  it("passes the handler's verdict back to the voice agent", async () => {
    answerResult = "needs-pin";
    expect((await answer()).json()).toEqual({ result: "needs-pin" });
  });
});

describe("verify_pin", () => {
  it("allows two wrong PINs per call, then tells the agent to end the call", async () => {
    const attempt = (pin: string) => tool("verify_pin", { ...binding(), pin });
    expect((await attempt("1111")).json()).toEqual({ verified: false, attempts_left: 1, end_call: false });
    expect((await attempt("2222")).json()).toEqual({ verified: false, attempts_left: 0, end_call: true });
    expect((await attempt(PIN)).json()).toEqual({ verified: false, attempts_left: 0, end_call: true });
    expect(pins.isVerified("conv_1")).toBe(false);
  });

  it("never logs a PIN, right or wrong", async () => {
    await tool("verify_pin", { ...binding(), pin: "1397" });
    await tool("verify_pin", { ...binding(), pin: PIN });
    const text = loggedText(lines);
    expect(text).not.toContain("1397");
    expect(text).not.toContain(PIN);
    expect(text).toContain('"tool":"verify_pin"');
  });
});

describe("get_status and send_instruction", () => {
  it("read nothing out and queue nothing before the PIN", async () => {
    expect((await tool("get_status", binding())).json()).toMatchObject({ result: "pin-required" });
    const send = await tool("send_instruction", {
      ...binding(),
      session_number: 1,
      instruction: "push to main",
      owner_words: "push to main",
    });
    expect(send.json()).toMatchObject({ result: "pin-required" });
    expect(statusCalls).toEqual([]);
    expect(instructions).toEqual([]);
  });

  it("work after the PIN, on that call only", async () => {
    await tool("verify_pin", { ...binding(), pin: PIN });
    expect((await tool("get_status", binding())).json()).toEqual({ result: "ok", status });
    expect((await tool("get_status", binding("conv_other"))).json()).toMatchObject({
      result: "pin-required",
    });
    const send = await tool("send_instruction", {
      ...binding(),
      session_number: 2,
      instruction: "now write the tests",
      owner_words: "tell Codex to now write the tests",
    });
    expect(send.json()).toEqual({ result: "queued" });
    expect(instructions).toEqual([
      {
        conversationId: "conv_1",
        callSid: `CA${"0".repeat(31)}1`,
        direction: "outbound",
        receivedAt: now,
        sessionNumber: 2,
        instruction: "now write the tests",
        ownerWords: "tell Codex to now write the tests",
      },
    ]);
  });

  it("redacts and cuts the status before it goes to ElevenLabs", async () => {
    await tool("verify_pin", { ...binding(), pin: PIN });
    status = `Claude is using ${TOOL_SECRET} ${"x ".repeat(2000)}`;
    const read = (await tool("get_status", binding())).json() as { status: string };
    expect(read.status).not.toContain(TOOL_SECRET);
    expect(read.status.length).toBe(MAX_STATUS_LENGTH);
  });
});

function postCall(
  payload: unknown,
  { header, timestamp = now.getTime() / 1000 }: { header?: string | null; timestamp?: number } = {},
) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = header === undefined ? postCallSignatureHeader(WEBHOOK_SECRET, timestamp, raw) : header;
  if (signature !== null) headers["elevenlabs-signature"] = signature;
  return app.inject({ method: "POST", url: "/hooks/el/post-call", headers, payload: raw });
}

const transcription = (conversation = "conv_1", agent = AGENT_ID) => ({
  type: "post_call_transcription",
  event_timestamp: now.getTime() / 1000,
  data: {
    agent_id: agent,
    conversation_id: conversation,
    status: "done",
    transcript: [
      { role: "agent", message: "Hey, it's your hotline." },
      { role: "user", message: "Yes, go ahead." },
    ],
    metadata: {
      call_duration_secs: 20,
      phone_call: { direction: "outbound", external_number: OWNER, call_sid: "CAx" },
    },
  },
});

describe("post-call webhook", () => {
  it("hands a verified transcription to the handler", async () => {
    const response = await postCall(transcription());
    expect(response.statusCode).toBe(200);
    expect(postCalls).toEqual([
      {
        type: "transcription",
        agentId: AGENT_ID,
        conversationId: "conv_1",
        status: "done",
        direction: "outbound",
        externalNumber: OWNER,
        callSid: "CAx",
        durationSeconds: 20,
        transcript: [
          { role: "agent", message: "Hey, it's your hotline." },
          { role: "owner", message: "Yes, go ahead." },
        ],
      },
    ]);
  });

  it.each([
    ["no signature", { header: null }],
    [
      "a wrong signature",
      { header: `t=${Math.floor(Date.parse("2026-10-13T22:00:00Z") / 1000)},v0=${"0".repeat(64)}` },
    ],
    ["a signature older than 30 minutes", { timestamp: Date.parse("2026-10-13T21:29:59Z") / 1000 }],
    ["a signature from the future", { timestamp: Date.parse("2026-10-13T22:05:01Z") / 1000 }],
  ])("answers a bare 403 to %s", async (_name, options) => {
    const response = await postCall(transcription(), options);
    expect([response.statusCode, response.body]).toEqual([403, ""]);
    expect(postCalls).toEqual([]);
  });

  it("refuses a malformed or non-JSON body before parsing it", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/hooks/el/post-call",
      headers: { "content-type": "application/json", "elevenlabs-signature": "t=1,v0=00" },
      payload: "{not json",
    });
    expect([bad.statusCode, bad.body]).toEqual([403, ""]);
    const form = await app.inject({
      method: "POST",
      url: "/hooks/el/post-call",
      headers: { "content-type": "application/x-www-form-urlencoded", "elevenlabs-signature": "t=1,v0=00" },
      payload: "a=b",
    });
    expect([form.statusCode, form.body]).toEqual([403, ""]);
  });

  it("handles a replay once, whatever the header looks like", async () => {
    const raw = JSON.stringify(transcription());
    const t = Math.floor(now.getTime() / 1000);
    const header = postCallSignatureHeader(WEBHOOK_SECRET, t, raw);
    const [time, hash] = header.split(",");
    const send = (h: string) =>
      app.inject({
        method: "POST",
        url: "/hooks/el/post-call",
        headers: { "content-type": "application/json", "elevenlabs-signature": h },
        payload: raw,
      });
    expect((await send(header)).statusCode).toBe(200);
    now = new Date(now.getTime() + 10 * 60 * 1000);
    expect((await send(header)).statusCode).toBe(200);
    expect((await send(`${hash},${time}`)).statusCode).toBe(200);
    expect((await send(`${header},v1=extra`)).statusCode).toBe(200);
    // A fresh signature over the same event (a retry) is still the same event.
    expect((await postCall(transcription())).statusCode).toBe(200);
    expect(postCalls).toHaveLength(1);
  });

  it("leaves a failed delivery unhandled so ElevenLabs' retry gets through", async () => {
    failPostCall = 1;
    expect((await postCall(transcription())).statusCode).toBe(500);
    expect((await postCall(transcription())).statusCode).toBe(200);
    expect(postCalls).toHaveLength(1);
  });

  const inboundTranscript = (from: string, conversation: string) => {
    const body = transcription(conversation);
    body.data.metadata.phone_call = { direction: "inbound", external_number: from, call_sid: "CAy" };
    return body;
  };
  const roles = () => (postCalls.at(-1) as { transcript: { role: string }[] }).transcript.map((t) => t.role);

  it("labels the person's turns as the owner's only on a call known to be with the owner", async () => {
    // A stranger calling in, and the owner's number calling in without the PIN.
    await postCall(inboundTranscript(STRANGER, "conv_in_stranger"));
    expect(roles()).toEqual(["agent", "caller"]);
    await postCall(inboundTranscript(OWNER, "conv_in_nopin"));
    expect(roles()).toEqual(["agent", "caller"]);
    // An outbound call whose other end is not the owner.
    const elsewhere = transcription("conv_out_other");
    elsewhere.data.metadata.phone_call.external_number = STRANGER;
    await postCall(elsewhere);
    expect(roles()).toEqual(["agent", "caller"]);
    // The owner's number calling in after the PIN.
    await tool("verify_pin", {
      ...binding("conv_in_pin"),
      caller_id: OWNER,
      called_number: AGENT_NUMBER,
      pin: PIN,
    });
    await postCall(inboundTranscript(OWNER, "conv_in_pin"));
    expect(roles()).toEqual(["agent", "owner"]);
  });

  it("ignores another agent's events and other webhook types", async () => {
    expect((await postCall(transcription("conv_1", "agent_other"))).statusCode).toBe(200);
    expect((await postCall({ type: "post_call_audio", data: { full_audio: "AAAA" } })).statusCode).toBe(200);
    expect(postCalls).toEqual([]);
  });

  it(`reads a long transcript up to ${POST_CALL_BODY_LIMIT} bytes and refuses a bigger one`, async () => {
    const long = (conversation: string, turns: number) => {
      const body = transcription(conversation);
      body.data.transcript = Array.from({ length: turns }, () => ({
        role: "user",
        message: "x".repeat(1000),
      }));
      return body;
    };
    expect((await postCall(long("conv_long", 400))).statusCode).toBe(200);
    const huge = await postCall(long("conv_huge", 1100));
    expect([huge.statusCode, huge.body]).toEqual([403, ""]);
    expect(postCalls.map((e) => (e as { conversationId: string }).conversationId)).toEqual(["conv_long"]);
  });

  it("never logs the transcript or numbers", async () => {
    await postCall(transcription());
    const text = lines.join("");
    expect(text).not.toContain("go ahead");
    expect(text).not.toContain("5555550100");
  });
});

describe("fake voice provider against the real routes", () => {
  let listening: FastifyInstance;

  afterEach(async () => {
    await listening?.close();
  });

  it("plays scripted humans over HTTP, with the tool secret and signed post-call webhooks", async () => {
    listening = server();
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const address = listening.addresses()[0];
    const fetch: HttpFetch = async (url, init) => {
      const response = await globalThis.fetch(url, init);
      return { status: response.status, json: () => response.json() };
    };
    const voice = new FakeVoiceProvider({
      ownerNumber: OWNER,
      agentNumber: AGENT_NUMBER,
      agentId: AGENT_ID,
      client: httpVoiceToolClient({
        hooksUrl: `http://127.0.0.1:${address?.port}/hooks`,
        toolSecret: TOOL_SECRET,
        webhookSecret: WEBHOOK_SECRET,
        fetch,
        clock: () => now,
      }),
    });
    const ask = {
      askId: "ask-1",
      kind: "permission",
      nickname: "Codex in api",
      text: "git push",
      options: [],
      risk: "high",
      toolName: "Bash",
    } as const;

    // High risk: the owner gives the PIN, then says yes.
    voice.script(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "answer", ask: 1, decision: "allow", words: "yes, push it" },
      ),
    );
    // Nobody picks up the second call.
    voice.script(scriptedHuman.noPickup());
    await voice.callOwner({ callId: "call-1", asks: [ask] });
    await voice.callOwner({ callId: "call-2", asks: [ask] });
    await voice.playPending();
    expect(answers.map((a) => [a.conversationId, a.decision, a.confirmation])).toEqual([
      ["conv_fake_1", { type: "allow" }, "pin"],
    ]);
    expect(postCalls.map((e) => (e as { type: string }).type)).toEqual([
      "transcription",
      "initiation-failure",
    ]);

    // Inbound: a wrong PIN twice ends the call before anything is read out.
    const played = await voice.inboundCall(
      scriptedHuman.says(
        { kind: "pin", digits: "0000" },
        { kind: "pin", digits: "1111" },
        { kind: "status" },
      ),
    );
    expect(played.endedEarly).toBe(true);
    expect(played.tools.map((t) => t.tool)).toEqual(["verify_pin", "verify_pin"]);
    expect(statusCalls).toEqual([]);
    expect(loggedText(lines)).not.toContain(PIN);
  });
});
