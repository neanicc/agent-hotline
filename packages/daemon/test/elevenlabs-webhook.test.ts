import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ConversationRecord,
  FakeVoiceProvider,
  type HttpFetch,
  httpVoiceToolClient,
  PullError,
  parseConversation,
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
  type HotlineStore,
  InboundLine,
  type LogOptions,
  MAX_POST_CALLS_IN_FLIGHT,
  MAX_PROCESSING_RETRIES,
  MAX_STATUS_LENGTH,
  MAX_TOOL_CALLS_IN_FLIGHT,
  MAX_TOOL_DELIVERIES,
  memoryPostCallWaits,
  openStore,
  PinGate,
  POST_CALL_BODY_LIMIT,
  type SubmitAnswerResult,
  storedPinFailures,
  storedPostCallWaits,
  storedToolDeliveries,
  type ToolCall,
  type VoiceAnswer,
  type VoiceHandlers,
  type VoiceInstruction,
} from "../src/index.js";
import { send } from "./http.js";

const OWNER = "+15555550100";
const AGENT_NUMBER = "+15555550101";
const STRANGER = "+15555550199";
const TOOL_SECRET = "fake-tool-secret-for-tests-0001";
const WEBHOOK_SECRET = "fake-webhook-secret-for-tests-01";
const AGENT_ID = "agent_fake";
/** `config.voice.agentPhoneNumberId`; the fake voice provider's default. */
const PHONE_ID = "phnum_fake";
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
/** Conversations Hotline did not place; every other id counts as placed. */
let unplaced: Set<string>;
/**
 * ElevenLabs' conversations, as the routes pull them (HL-13a). `tool` and
 * `postCall` add the call they claim to come from, as ElevenLabs would have it,
 * unless told the conversation does not exist there.
 */
let conversations: Map<string, ConversationRecord>;
let unverified: { what: string; forgery: boolean; reason: string }[];

const notFound = () => new PullError("ElevenLabs has no such record (HTTP 404)", "not-found", 404);

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
      agentPhoneNumberId: PHONE_ID,
      ownerNumber: OWNER,
      placedCall: (conversationId) => !unplaced.has(conversationId),
      pins,
      clock: () => now,
      redact: (text) => redactor.text(text),
      handlers,
      conversation: async (id) => {
        const record = conversations.get(id);
        if (record === undefined) throw notFound();
        return structuredClone(record);
      },
      onUnverified: (what, failure) => {
        unverified.push({ what, ...failure });
      },
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
  unplaced = new Set();
  conversations = new Map();
  unverified = [];
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
  /** The conversation does not exist at ElevenLabs: a forged tool call. */
  unknownAtElevenLabs?: boolean;
}

/**
 * ElevenLabs' record of the live call a tool call's binding describes: outbound
 * when it dialled the owner, inbound otherwise.
 */
function liveRecord(body: Record<string, unknown>): ConversationRecord {
  const caller = body.caller_id as string | undefined;
  const called = body.called_number as string | undefined;
  const outbound = called === OWNER && caller !== OWNER;
  return {
    agent_id: AGENT_ID,
    conversation_id: body.conversation_id as string,
    status: "in-progress",
    transcript: [],
    metadata: {
      start_time_unix_secs: Math.floor(now.getTime() / 1000) - 60,
      phone_call: {
        direction: outbound ? "outbound" : "inbound",
        external_number: outbound ? called : caller,
        agent_number: outbound ? caller : called,
        phone_number_id: PHONE_ID,
        ...(typeof body.call_sid === "string" ? { call_sid: body.call_sid } : {}),
      },
    },
  };
}

function tool(
  name: string,
  body: Record<string, unknown>,
  { secret = TOOL_SECRET, contentType, raw, unknownAtElevenLabs = false }: ToolOptions = {},
) {
  const id = body.conversation_id;
  if (!unknownAtElevenLabs && typeof id === "string" && !conversations.has(id)) {
    conversations.set(id, liveRecord(body));
  }
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

  it("refuses a wrong secret before the body is read", async () => {
    const response = await tool("submit_answer", { ...binding(), ask_number: 1 }, { secret: "wrong-secret" });
    expect([response.statusCode, response.body]).toEqual([403, ""]);
    const reasons = lines.map((line) => (JSON.parse(line) as { reason?: string }).reason).filter(Boolean);
    expect(reasons).toEqual(["precheck failed"]);
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
    // A call with the owner on both ends is not on a Hotline number at all.
    expect((await answer({ caller_id: OWNER, called_number: OWNER }, "conv_both")).json()).toEqual({
      result: "refused",
      end_call: true,
    });
    expect(answers).toEqual([]);
    await tool("verify_pin", { ...binding(), ...inbound, pin: PIN });
    expect((await answer({ ...inbound, decision: "deny" })).json()).toEqual({ result: "recorded" });
    expect(answers.map((a) => [a.direction, a.decision, a.confirmation])).toEqual([
      ["inbound", { type: "deny" }, "pin"],
    ]);
  });

  it("treats a conversation Hotline did not place as inbound, whatever its numbers say", async () => {
    unplaced.add("conv_stray");
    expect((await answer({}, "conv_stray")).json()).toMatchObject({ result: "pin-required" });
    expect(answers).toEqual([]);
    await tool("verify_pin", { ...binding("conv_stray"), pin: PIN });
    await answer({}, "conv_stray");
    expect(answers.map((a) => [a.direction, a.confirmation])).toEqual([["inbound", "pin"]]);
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

describe("repeated tool calls", () => {
  it("run a state-changing handler once and answer a repeat from memory", async () => {
    const first = await answer();
    const again = await answer();
    expect(again.json()).toEqual(first.json());
    expect(answers).toHaveLength(1);
    await answer({ owner_words: "yes, really, go ahead" });
    expect(answers).toHaveLength(2);
  });

  it("run an identical answer again after the PIN when the first got needs-pin", async () => {
    answerResult = "needs-pin";
    expect((await answer()).json()).toEqual({ result: "needs-pin" });
    await tool("verify_pin", { ...binding(), pin: PIN });
    answerResult = "recorded";
    expect((await answer()).json()).toEqual({ result: "recorded" });
    expect(answers.map((a) => a.confirmation)).toEqual(["none", "pin"]);
  });

  it("run an answer again when the handler did not record it", async () => {
    answerResult = "not-recorded";
    await answer();
    await answer();
    expect(answers).toHaveLength(2);
  });

  it("never spend a PIN attempt on a repeated guess", async () => {
    const guess = () => tool("verify_pin", { ...binding(), pin: "1111" });
    expect((await guess()).json()).toMatchObject({ attempts_left: 1 });
    expect((await guess()).json()).toMatchObject({ attempts_left: 1 });
    expect((await tool("verify_pin", { ...binding(), pin: PIN })).json()).toMatchObject({ verified: true });
  });

  it("forget a delivery once its memory window has passed", async () => {
    await answer();
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 1);
    await answer();
    expect(answers).toHaveLength(2);
  });

  it(`never evict a live delivery: past ${MAX_TOOL_DELIVERIES} they refuse new ones instead`, async () => {
    for (let i = 0; i < MAX_TOOL_DELIVERIES; i += 1) await answer({ owner_words: `yes ${i}` });
    expect(answers).toHaveLength(MAX_TOOL_DELIVERIES);
    expect((await answer({ owner_words: "one too many" })).json()).toEqual({ result: "busy" });
    // The oldest delivery is still remembered, so its replay does not run again.
    await answer({ owner_words: "yes 0" });
    expect(answers).toHaveLength(MAX_TOOL_DELIVERIES);
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 1);
    expect((await answer({ owner_words: "one too many" })).json()).toEqual({ result: "recorded" });
  });

  it("answer a replay from the store after a restart, without running the tool again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotline-hl13b-tools-"));
    const path = join(dir, "hotline.db");
    let store = await openStore(path);
    try {
      const restart = async () => {
        await app.close();
        store.close();
        store = await openStore(path);
        // A new run: a fresh PinGate, with the stored budgets.
        pins = new PinGate({
          check: async (pin) => pin === PIN,
          clock: () => now,
          failures: storedPinFailures(store),
        });
        app = server({ deliveries: storedToolDeliveries(store) });
      };
      await restart();
      await tool("verify_pin", {
        ...binding("conv_in"),
        caller_id: OWNER,
        called_number: AGENT_NUMBER,
        pin: PIN,
      });
      const instruction = () =>
        tool("send_instruction", {
          ...binding("conv_in"),
          caller_id: OWNER,
          called_number: AGENT_NUMBER,
          session_number: 1,
          instruction: "run the tests",
          owner_words: "session 1, run the tests",
        });
      const guess = () => tool("verify_pin", { ...binding(), pin: "1111" });
      expect((await instruction()).json()).toEqual({ result: "queued" });
      expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
      expect(instructions).toHaveLength(1);
      await restart();
      // The replays get the first responses: no second instruction, no second guess counted.
      expect((await instruction()).json()).toEqual({ result: "queued" });
      expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
      expect(instructions).toHaveLength(1);
      expect(store.pinFailureTimes("outbound")).toHaveLength(1);
      // Past the memory window the replayed instruction runs again, and now needs the PIN.
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 1);
      expect((await instruction()).json()).toMatchObject({ result: "pin-required" });
      expect(instructions).toHaveLength(1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuse a delivery, rather than risk running it twice, when the memory cannot be read", async () => {
    await app.close();
    app = server({
      deliveries: {
        get: () => {
          throw new Error("database is locked");
        },
        put: () => {},
        size: () => 0,
        prune: () => {},
      },
    });
    expect((await answer()).json()).toEqual({ result: "busy" });
    expect(answers).toEqual([]);
  });

  it("still remember a delivery for this run when the store cannot keep it", async () => {
    await app.close();
    app = server({
      deliveries: {
        get: () => undefined,
        put: () => {
          throw new Error("disk full");
        },
        size: () => 0,
        prune: () => {},
      },
    });
    await answer();
    await answer();
    expect(answers).toHaveLength(1);
  });

  it("answer PIN repeats from this run's memory when the store cannot keep them, spending nothing", async () => {
    await app.close();
    app = server({
      deliveries: {
        get: () => undefined,
        put: () => {
          throw new Error("disk full");
        },
        size: () => 0,
        prune: () => {},
      },
    });
    const guess = () => tool("verify_pin", { ...binding(), pin: "1111" });
    expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
    expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
    // A right PIN is remembered too, and this run's gate has the call verified, so no recheck runs.
    const right = () => tool("verify_pin", { ...binding(), pin: PIN });
    expect((await right()).json()).toMatchObject({ verified: true, attempts_left: 1 });
    expect((await right()).json()).toMatchObject({ verified: true, attempts_left: 1 });
    expect(pins.isVerified("conv_1")).toBe(true);
  });

  it("keep reading the status on every request", async () => {
    await tool("verify_pin", { ...binding(), pin: PIN });
    await tool("get_status", binding());
    await tool("get_status", binding());
    expect(statusCalls).toHaveLength(2);
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
        // When this call passed the PIN, saved with the held instruction (HL-13b).
        pinVerifiedAt: now,
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

/** Makes `payload`'s conversation, finished, what ElevenLabs has: the webhook is genuine. */
function recordAtElevenLabs(payload: unknown): void {
  const data = (payload as { type?: unknown; data?: unknown } | null)?.data;
  if ((payload as { type?: unknown } | null)?.type !== "post_call_transcription") return;
  const record = parseConversation(structuredClone(data));
  if (record !== undefined) conversations.set(record.conversation_id, record);
}

function postCall(
  payload: unknown,
  {
    header,
    timestamp = now.getTime() / 1000,
    unknownAtElevenLabs = false,
  }: { header?: string | null; timestamp?: number; unknownAtElevenLabs?: boolean } = {},
) {
  if (!unknownAtElevenLabs) recordAtElevenLabs(payload);
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = header === undefined ? postCallSignatureHeader(WEBHOOK_SECRET, timestamp, raw) : header;
  if (signature !== null) headers["elevenlabs-signature"] = signature;
  return app.inject({ method: "POST", url: "/hooks/el/post-call", headers, payload: raw });
}

/** A fresh, well-formed signature header with a made-up hash: passes the precheck, fails the HMAC. */
const forgedHeader = () => `t=${Math.floor(now.getTime() / 1000)},v0=${"0".repeat(64)}`;

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
      phone_call: {
        direction: "outbound",
        external_number: OWNER,
        agent_number: AGENT_NUMBER,
        phone_number_id: PHONE_ID,
        call_sid: "CAx",
      },
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

  it.each([
    ["a stale timestamp", () => `t=${Math.floor(now.getTime() / 1000) - 31 * 60},v0=${"0".repeat(64)}`],
    ["a short hash", () => `t=${Math.floor(now.getTime() / 1000)},v0=00`],
    ["no timestamp", () => `v0=${"0".repeat(64)}`],
  ])("refuses a header with %s before reading the body", async (_name, make) => {
    const response = await app.inject({
      method: "POST",
      url: "/hooks/el/post-call",
      headers: { "content-type": "application/json", "elevenlabs-signature": make() },
      payload: JSON.stringify(transcription()),
    });
    expect([response.statusCode, response.body]).toEqual([403, ""]);
    const reasons = lines.map((line) => (JSON.parse(line) as { reason?: string }).reason).filter(Boolean);
    expect(reasons).toEqual(["precheck failed"]);
  });

  it("refuses a malformed or non-JSON body before parsing it", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/hooks/el/post-call",
      headers: { "content-type": "application/json", "elevenlabs-signature": forgedHeader() },
      payload: "{not json",
    });
    expect([bad.statusCode, bad.body]).toEqual([403, ""]);
    const form = await app.inject({
      method: "POST",
      url: "/hooks/el/post-call",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "elevenlabs-signature": forgedHeader(),
      },
      payload: "a=b",
    });
    expect([form.statusCode, form.body]).toEqual([403, ""]);
  });

  it("handles a replay once, whatever the header looks like", async () => {
    const raw = JSON.stringify(transcription());
    recordAtElevenLabs(JSON.parse(raw));
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

  /** An inbound call that started a minute ago, with the person's words `spokeAt` seconds in. */
  const inboundTranscript = (from: string, conversation: string, spokeAt = 90) => {
    const body = transcription(conversation);
    const start = now.getTime() / 1000 - 60;
    return {
      ...body,
      data: {
        ...body.data,
        transcript: [
          { role: "agent", message: "Hey, it's your hotline.", time_in_call_secs: 0 },
          { role: "user", message: "Yes, go ahead.", time_in_call_secs: spokeAt },
        ],
        metadata: {
          start_time_unix_secs: start,
          call_duration_secs: 120,
          phone_call: {
            direction: "inbound",
            external_number: from,
            agent_number: AGENT_NUMBER,
            phone_number_id: PHONE_ID,
            call_sid: "CAy",
          },
        },
      },
    };
  };
  const roles = () => (postCalls.at(-1) as { transcript: { role: string }[] }).transcript.map((t) => t.role);

  it("labels the person's turns as the owner's only on a call known to be with the owner", async () => {
    // A stranger calling in: the call is handed on, with nothing they said.
    unplaced.add("conv_in_stranger");
    await postCall(inboundTranscript(STRANGER, "conv_in_stranger"));
    expect(postCalls.at(-1)).toMatchObject({
      direction: "inbound",
      externalNumber: STRANGER,
      transcript: [],
    });
    // The owner's number calling in without the PIN.
    unplaced.add("conv_in_nopin");
    await postCall(inboundTranscript(OWNER, "conv_in_nopin"));
    expect(roles()).toEqual(["agent", "caller"]);
    // An outbound call Hotline placed whose other end is not the owner confirms nothing at all.
    const elsewhere = transcription("conv_out_other");
    elsewhere.data.metadata.phone_call.external_number = STRANGER;
    await postCall(elsewhere);
    expect(postCalls.at(-1)).toEqual({
      type: "initiation-failure",
      agentId: AGENT_ID,
      conversationId: "conv_out_other",
      reason: "unknown",
    });
    unplaced.add("conv_in_pin");
    unplaced.add("conv_in_early");
    // The owner's number calling in after the PIN.
    await tool("verify_pin", {
      ...binding("conv_in_pin"),
      caller_id: OWNER,
      called_number: AGENT_NUMBER,
      pin: PIN,
    });
    await postCall(inboundTranscript(OWNER, "conv_in_pin"));
    expect(roles()).toEqual(["agent", "owner"]);
    // Words said before the PIN was verified (30 s into a call that began 60 s ago) never count.
    await tool("verify_pin", {
      ...binding("conv_in_early"),
      caller_id: OWNER,
      called_number: AGENT_NUMBER,
      pin: PIN,
    });
    await postCall(inboundTranscript(OWNER, "conv_in_early", 30));
    expect(roles()).toEqual(["agent", "caller"]);
  });

  it("hands on nothing said on an outbound call Hotline did not place", async () => {
    unplaced.add("conv_stray");
    await postCall(transcription("conv_stray"));
    expect(postCalls.at(-1)).toMatchObject({ conversationId: "conv_stray", transcript: [] });
  });

  it("asks ElevenLabs to retry rather than forget a live event when its memory is full", async () => {
    for (let i = 0; i < 1000; i += 1) {
      expect((await postCall(transcription(`conv_many_${i}`))).statusCode).toBe(200);
    }
    const full = await postCall(transcription("conv_one_more"));
    expect([full.statusCode, full.body]).toEqual([503, ""]);
    // The oldest event is still remembered, so its replay is not handled again.
    expect((await postCall(transcription("conv_many_0"))).statusCode).toBe(200);
    expect(postCalls).toHaveLength(1000);
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

describe("post-call webhook under load", () => {
  let listening: FastifyInstance | undefined;

  afterEach(async () => {
    await listening?.close();
  });

  it(`reads at most ${MAX_POST_CALLS_IN_FLIGHT} unverified bodies at once`, async () => {
    listening = server();
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const port = listening.addresses()[0]?.port ?? 0;
    const headers = { "content-type": "application/json", "elevenlabs-signature": forgedHeader() };
    // Senders that start a body and never finish it.
    const stalled = Array.from({ length: MAX_POST_CALLS_IN_FLIGHT }, () => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/hooks/el/post-call",
        method: "POST",
        agent: false,
        headers: { ...headers, "content-length": "1000" },
      });
      req.on("error", () => {});
      req.write("{");
      return req;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = JSON.stringify(transcription("conv_load"));
    recordAtElevenLabs(JSON.parse(raw));
    const signed = {
      "content-type": "application/json",
      "elevenlabs-signature": postCallSignatureHeader(WEBHOOK_SECRET, now.getTime() / 1000, raw),
    };
    const refused = await send({
      port,
      method: "POST",
      path: "/hooks/el/post-call",
      headers: signed,
      body: raw,
    });
    expect([refused.status, refused.body]).toEqual([403, ""]);
    for (const req of stalled) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const accepted = await send({
      port,
      method: "POST",
      path: "/hooks/el/post-call",
      headers: signed,
      body: raw,
    });
    expect(accepted.status).toBe(200);
    expect(postCalls).toHaveLength(1);
  });

  it("cuts off senders that do not finish their body in time, freeing their slots", async () => {
    listening = server({ postCallBodyTimeoutMs: 200 });
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const port = listening.addresses()[0]?.port ?? 0;
    const closed: boolean[] = [];
    const stalled = Array.from({ length: MAX_POST_CALLS_IN_FLIGHT }, () => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/hooks/el/post-call",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "elevenlabs-signature": forgedHeader(),
          "content-length": "1000",
        },
      });
      req.on("error", () => closed.push(true));
      req.write("{");
      return req;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const raw = JSON.stringify(transcription("conv_after_timeout"));
    recordAtElevenLabs(JSON.parse(raw));
    const accepted = await send({
      port,
      method: "POST",
      path: "/hooks/el/post-call",
      headers: {
        "content-type": "application/json",
        "elevenlabs-signature": postCallSignatureHeader(WEBHOOK_SECRET, now.getTime() / 1000, raw),
      },
      body: raw,
    });
    expect(accepted.status).toBe(200);
    expect(closed).toHaveLength(MAX_POST_CALLS_IN_FLIGHT);
    for (const req of stalled) req.destroy();
  });
});

describe("server tools under load", () => {
  let listening: FastifyInstance | undefined;

  afterEach(async () => {
    await listening?.close();
  });

  /** Senders with the tool secret that start a `verify_pin` body and never finish it. */
  function stall(port: number, closed: boolean[] = []) {
    return Array.from({ length: MAX_TOOL_CALLS_IN_FLIGHT }, () => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/hooks/el/tools/verify_pin",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "x-hotline-tool-secret": TOOL_SECRET,
          "content-length": "1000",
        },
      });
      req.on("error", () => closed.push(true));
      req.write("{");
      return req;
    });
  }

  async function verify(port: number) {
    const body = { ...binding(), pin: PIN };
    conversations.set(body.conversation_id, liveRecord(body));
    return send({
      port,
      method: "POST",
      path: "/hooks/el/tools/verify_pin",
      headers: { "content-type": "application/json", "x-hotline-tool-secret": TOOL_SECRET },
      body: JSON.stringify(body),
    });
  }

  it(`reads at most ${MAX_TOOL_CALLS_IN_FLIGHT} calls of one tool at once`, async () => {
    listening = server();
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const port = listening.addresses()[0]?.port ?? 0;
    const stalled = stall(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await verify(port);
    expect([refused.status, refused.body]).toEqual([403, ""]);
    expect(pins.isVerified("conv_1")).toBe(false);
    for (const req of stalled) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await verify(port)).status).toBe(200);
    expect(pins.isVerified("conv_1")).toBe(true);
  });

  it("cuts off tool senders that do not finish their body in time, freeing their slots", async () => {
    listening = server({ toolBodyTimeoutMs: 200 });
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const port = listening.addresses()[0]?.port ?? 0;
    const closed: boolean[] = [];
    const stalled = stall(port, closed);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await verify(port)).status).toBe(200);
    expect(closed).toHaveLength(MAX_TOOL_CALLS_IN_FLIGHT);
    for (const req of stalled) req.destroy();
  });
});

describe("fake voice provider against the real routes", () => {
  let listening: FastifyInstance;

  afterEach(async () => {
    await listening?.close();
  });

  it("plays scripted humans over HTTP, with the tool secret and signed post-call webhooks", async () => {
    // The routes pull every conversation from the fake, which records what it played.
    let voice: FakeVoiceProvider | undefined;
    listening = server({ conversation: (id) => (voice as FakeVoiceProvider).fetchConversation(id) });
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const address = listening.addresses()[0];
    const fetch: HttpFetch = async (url, init) => {
      const response = await globalThis.fetch(url, init);
      return { status: response.status, json: () => response.json() };
    };
    voice = new FakeVoiceProvider({
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

describe("verify by pull (HL-13a)", () => {
  const inboundBinding = (conversation: string) => ({
    ...binding(conversation),
    caller_id: OWNER,
    called_number: AGENT_NUMBER,
  });

  it("never counts a verify_pin for a conversation ElevenLabs does not have", async () => {
    for (let i = 0; i < 12; i += 1) {
      const response = await tool(
        "verify_pin",
        { ...inboundBinding(`conv_forged_${i}`), pin: i === 11 ? PIN : "0000" },
        { unknownAtElevenLabs: true },
      );
      expect(response.json()).toEqual({ result: "refused", end_call: true });
    }
    expect(pins.isVerified("conv_forged_11")).toBe(false);
    expect(unverified).toHaveLength(12);
    expect(unverified[0]).toEqual({
      what: "verify_pin",
      forgery: true,
      reason: "the provider has no such record",
    });
    // Nothing was spent: a real call still has both attempts, and the budget is whole.
    expect((await tool("verify_pin", { ...inboundBinding("conv_real"), pin: "1111" })).json()).toEqual({
      verified: false,
      attempts_left: 1,
      end_call: false,
    });
    expect((await tool("verify_pin", { ...inboundBinding("conv_real"), pin: PIN })).json()).toMatchObject({
      verified: true,
    });
  });

  it.each([
    ["a finished call", (r: ConversationRecord) => Object.assign(r, { status: "done" })],
    ["another agent's call", (r: ConversationRecord) => Object.assign(r, { agent_id: "agent_other" })],
    [
      "a call with someone else's number",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.external_number = STRANGER;
        return r;
      },
    ],
    [
      "a call on another Hotline number",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.agent_number = "+15555550102";
        return r;
      },
    ],
    [
      "a call with another call SID",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.call_sid = `CA${"9".repeat(32)}`;
        return r;
      },
    ],
    [
      "a conversation that is not a phone call",
      (r: ConversationRecord) => Object.assign(r, { metadata: {} }),
    ],
  ])("refuses a PIN on %s, without spending an attempt", async (_name, change) => {
    const body = { ...inboundBinding("conv_odd"), pin: PIN };
    conversations.set("conv_odd", change(liveRecord(body)));
    expect((await tool("verify_pin", body)).json()).toEqual({ result: "refused", end_call: true });
    expect(pins.isVerified("conv_odd")).toBe(false);
    expect(unverified.map((u) => u.forgery)).toEqual([true]);
  });

  it("refuses a PIN on a call not on the configured Hotline number", async () => {
    await app.close();
    app = server({ agentPhoneNumberId: "phnum_hotline" });
    const body = { ...inboundBinding("conv_num"), pin: PIN };
    const record = liveRecord(body);
    if (record.metadata?.phone_call) record.metadata.phone_call.phone_number_id = "phnum_other";
    conversations.set("conv_num", record);
    expect((await tool("verify_pin", body)).json()).toEqual({ result: "refused", end_call: true });
    if (record.metadata?.phone_call) record.metadata.phone_call.phone_number_id = "phnum_hotline";
    conversations.set("conv_num", record);
    expect((await tool("verify_pin", body)).json()).toMatchObject({ verified: true });
  });

  it("refuses a PIN when ElevenLabs cannot be reached, as no forgery", async () => {
    await app.close();
    app = server({
      conversation: async () => {
        throw new PullError("Could not reach ElevenLabs", "unreachable");
      },
    });
    expect((await tool("verify_pin", { ...inboundBinding("conv_down"), pin: PIN })).json()).toEqual({
      result: "refused",
      end_call: true,
    });
    expect(unverified).toEqual([
      { what: "verify_pin", forgery: false, reason: "the provider lookup failed (unreachable)" },
    ]);
  });

  it("hands the handler the pulled transcript, not a forged body's", async () => {
    // ElevenLabs has the call as it happened: the owner said no.
    const genuine = transcription("conv_forge");
    genuine.data.transcript = [
      { role: "agent", message: "Hey, it's your hotline." },
      { role: "user", message: "No, don't." },
    ];
    recordAtElevenLabs(genuine);
    const forged = transcription("conv_forge");
    expect((await postCall(forged, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toMatchObject([
      {
        type: "transcription",
        conversationId: "conv_forge",
        transcript: [
          { role: "agent", message: "Hey, it's your hotline." },
          { role: "owner", message: "No, don't." },
        ],
      },
    ]);
    expect(unverified).toEqual([
      { what: "post-call", forgery: true, reason: "the webhook differs from the provider's record" },
    ]);
  });

  it("uses the pulled metadata: a forged body cannot make a stranger's call the owner's", async () => {
    // Hotline placed it, but ElevenLabs has it going to someone else: nothing counts.
    const genuine = transcription("conv_meta");
    genuine.data.metadata.phone_call.external_number = STRANGER;
    recordAtElevenLabs(genuine);
    await postCall(transcription("conv_meta"), { unknownAtElevenLabs: true });
    expect(postCalls).toEqual([
      { type: "initiation-failure", agentId: AGENT_ID, conversationId: "conv_meta", reason: "unknown" },
    ]);
    // A stranger calling in on the record, whatever the body claims: no words are handed on.
    unplaced.add("conv_meta_in");
    const stranger = transcription("conv_meta_in");
    Object.assign(stranger.data.metadata.phone_call, { direction: "inbound", external_number: STRANGER });
    recordAtElevenLabs(stranger);
    await postCall(transcription("conv_meta_in"), { unknownAtElevenLabs: true });
    expect(postCalls.at(-1)).toMatchObject({ externalNumber: STRANGER, transcript: [] });
  });

  /** Changes the finished record's phone call. */
  const phone =
    (change: Record<string, unknown>) =>
    (r: ConversationRecord): ConversationRecord => {
      if (r.metadata?.phone_call) Object.assign(r.metadata.phone_call, change);
      return r;
    };

  it.each([
    ["ElevenLabs has no such conversation", undefined, "the provider has no such record"],
    [
      "the conversation is another agent's",
      (r: ConversationRecord) => Object.assign(r, { agent_id: "agent_other" }),
      "the conversation belongs to another agent",
    ],
    [
      "the conversation is not a phone call",
      (r: ConversationRecord) => Object.assign(r, { metadata: { call_duration_secs: 20 } }),
      "the conversation is not a phone call",
    ],
    ["the call has no direction", phone({ direction: null }), "the call has no direction"],
    [
      "the call is on another ElevenLabs number",
      phone({ phone_number_id: "phnum_other" }),
      "the call is not on the Hotline number",
    ],
    [
      "the Hotline end is the owner's number",
      phone({ agent_number: OWNER }),
      "the call is not on a Hotline number",
    ],
    [
      "the Hotline end is not an E.164 number",
      phone({ agent_number: "15555550101" }),
      "the call is not on a Hotline number",
    ],
    [
      "the owner's number is in another form",
      phone({ external_number: "+1 555 555 0100" }),
      "the call has no other number",
    ],
    [
      "the call Hotline placed is inbound at ElevenLabs",
      phone({ direction: "inbound" }),
      "the provider has a call Hotline placed as inbound",
    ],
  ])("gives a failed call, so no answer, when %s", async (_name, change, reason) => {
    const body = transcription("conv_gone");
    if (change !== undefined) {
      recordAtElevenLabs(body);
      conversations.set("conv_gone", change(conversations.get("conv_gone") as ConversationRecord));
    }
    expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toEqual([
      { type: "initiation-failure", agentId: AGENT_ID, conversationId: "conv_gone", reason: "unknown" },
    ]);
    expect(unverified).toEqual([{ what: "post-call", forgery: true, reason }]);
  });

  it("asks ElevenLabs to send the event again while it cannot be reached, then uses the record", async () => {
    let down = true;
    await app.close();
    app = server({
      conversation: async (id) => {
        if (down) throw new PullError("ElevenLabs refused the lookup (HTTP 503)", "refused", 503);
        return structuredClone(conversations.get(id) as ConversationRecord);
      },
    });
    const response = await postCall(transcription("conv_down"));
    expect([response.statusCode, response.body]).toEqual([503, ""]);
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual([
      { what: "post-call", forgery: false, reason: "the provider lookup failed (refused)" },
    ]);
    // ElevenLabs' retry, once the lookup works: the genuine transcript is not lost.
    down = false;
    expect((await postCall(transcription("conv_down"))).statusCode).toBe(200);
    expect(postCalls).toMatchObject([
      { type: "transcription", conversationId: "conv_down", transcript: [{}, { role: "owner" }] },
    ]);
  });

  it("leaves an event for a call still going on unhandled, so the genuine one counts", async () => {
    conversations.set("conv_live", liveRecord(binding("conv_live")));
    expect((await postCall(transcription("conv_live"), { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual([
      { what: "post-call", forgery: true, reason: "the call is not over at the provider" },
    ]);
    // The call ends; ElevenLabs' own webhook arrives and is handled once.
    expect((await postCall(transcription("conv_live"))).statusCode).toBe(200);
    expect((await postCall(transcription("conv_live"))).statusCode).toBe(200);
    expect(postCalls).toHaveLength(1);
  });
});

describe("a record still processing is asked for again, a bounded number of times (HL-13c)", () => {
  const STILL = {
    what: "post-call",
    forgery: false,
    reason: "the call is still being processed at the provider",
  };
  const GAVE_UP = {
    what: "post-call",
    forgery: false,
    reason: "the provider did not finish processing the call",
  };

  /** ElevenLabs has the finished call the event describes, still `processing`. */
  function processing(conversation: string) {
    const body = transcription(conversation);
    recordAtElevenLabs(body);
    const record = conversations.get(conversation) as ConversationRecord;
    conversations.set(conversation, { ...record, status: "processing" });
    return body;
  }

  const finish = (conversation: string) => {
    const record = conversations.get(conversation) as ConversationRecord;
    conversations.set(conversation, { ...record, status: "done" });
  };

  it("answers 503 while the record is processing, then takes the genuine transcript once it is done", async () => {
    const body = processing("conv_lag");
    for (let i = 0; i < MAX_PROCESSING_RETRIES; i++) {
      const response = await postCall(body, { unknownAtElevenLabs: true });
      expect([response.statusCode, response.body]).toEqual([503, ""]);
    }
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual(Array(MAX_PROCESSING_RETRIES).fill(STILL));
    // ElevenLabs' last retry finds the record done: the owner's answer is not lost.
    finish("conv_lag");
    expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toMatchObject([
      { type: "transcription", conversationId: "conv_lag", transcript: [{}, { role: "owner" }] },
    ]);
  });

  it("ends a call whose record never finishes processing as no answer, never with its words", async () => {
    const body = processing("conv_stuck");
    for (let i = 0; i < MAX_PROCESSING_RETRIES; i++) {
      expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(503);
    }
    const last = await postCall(body, { unknownAtElevenLabs: true });
    expect(last.statusCode).toBe(200);
    // A failed call: every ask on it ends as no answer, the words in the body count for nothing.
    expect(postCalls).toEqual([
      { type: "initiation-failure", agentId: AGENT_ID, conversationId: "conv_stuck", reason: "unknown" },
    ]);
    expect(unverified.at(-1)).toEqual(GAVE_UP);
    // A later delivery, even once the record is done, does not reopen it.
    finish("conv_stuck");
    expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toHaveLength(1);
  });

  it("counts each conversation on its own", async () => {
    const first = processing("conv_a");
    const second = processing("conv_b");
    for (let i = 0; i < MAX_PROCESSING_RETRIES; i++) {
      expect((await postCall(first, { unknownAtElevenLabs: true })).statusCode).toBe(503);
    }
    expect((await postCall(second, { unknownAtElevenLabs: true })).statusCode).toBe(503);
    expect(postCalls).toEqual([]);
  });

  it("still never retries an event for a call going on, which ElevenLabs never sends", async () => {
    conversations.set("conv_live", liveRecord(binding("conv_live")));
    for (let i = 0; i < MAX_PROCESSING_RETRIES + 2; i++) {
      expect((await postCall(transcription("conv_live"), { unknownAtElevenLabs: true })).statusCode).toBe(
        200,
      );
    }
    // Forged events during the call neither end it nor use up its processing retries.
    expect(postCalls).toEqual([]);
    expect(unverified.every((u) => u.reason === "the call is not over at the provider")).toBe(true);
  });

  it("keeps the count across a restart, in the store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotline-hl13c-waits-"));
    try {
      const path = join(dir, "hotline.db");
      let store = await openStore(path);
      await app.close();
      app = server({ processingWaits: storedPostCallWaits(store) });
      const body = processing("conv_restart");
      for (let i = 0; i < MAX_PROCESSING_RETRIES - 1; i++) {
        expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(503);
      }
      // The daemon restarts: a new run, the same store.
      await app.close();
      store.close();
      store = await openStore(path);
      app = server({ processingWaits: storedPostCallWaits(store) });
      expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(503);
      expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
      expect(postCalls).toEqual([expect.objectContaining({ type: "initiation-failure" })]);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands out no extra retries when the store fails for a while and then recovers", async () => {
    await app.close();
    const stored = memoryPostCallWaits();
    let failures = 1;
    app = server({
      processingWaits: {
        add: (conversationId, nowMs, expires) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("database is locked");
          }
          return stored.add(conversationId, nowMs, expires);
        },
      },
    });
    const body = processing("conv_flaky");
    for (let i = 0; i < MAX_PROCESSING_RETRIES; i++) {
      expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(503);
    }
    expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toEqual([expect.objectContaining({ type: "initiation-failure" })]);
  });

  it("keeps the bound for this run when the store cannot count", async () => {
    await app.close();
    app = server({
      processingWaits: {
        add: () => {
          throw new Error("database is locked");
        },
      },
    });
    const body = processing("conv_broken");
    for (let i = 0; i < MAX_PROCESSING_RETRIES; i++) {
      expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(503);
    }
    expect((await postCall(body, { unknownAtElevenLabs: true })).statusCode).toBe(200);
    expect(postCalls).toEqual([expect.objectContaining({ type: "initiation-failure" })]);
  });
});

describe("call initiation failures are checked against ElevenLabs' record (HL-13a)", () => {
  const initiationFailure = (conversation: string, reason = "no-answer") => ({
    type: "call_initiation_failure",
    event_timestamp: now.getTime() / 1000,
    data: { agent_id: AGENT_ID, conversation_id: conversation, failure_reason: reason },
  });
  /** ElevenLabs' record of Hotline's outbound call to the owner that never connected. */
  const failedRecord = (conversation: string): ConversationRecord => ({
    agent_id: AGENT_ID,
    conversation_id: conversation,
    status: "failed",
    transcript: [],
    metadata: {
      start_time_unix_secs: Math.floor(now.getTime() / 1000),
      call_duration_secs: 0,
      phone_call: {
        direction: "outbound",
        external_number: OWNER,
        agent_number: AGENT_NUMBER,
        phone_number_id: PHONE_ID,
        call_sid: "CAfail",
      },
    },
  });

  it("acts on a failure ElevenLabs' record shows, with the reason it gave", async () => {
    conversations.set("conv_busy", failedRecord("conv_busy"));
    expect((await postCall(initiationFailure("conv_busy", "busy"))).statusCode).toBe(200);
    expect(postCalls).toEqual([
      { type: "initiation-failure", agentId: AGENT_ID, conversationId: "conv_busy", reason: "busy" },
    ]);
    expect(unverified).toEqual([]);
  });

  it("never ends a call that is going on at ElevenLabs, and still takes its real transcript", async () => {
    // The owner is on the line: ElevenLabs has the call in progress.
    conversations.set("conv_live", liveRecord(binding("conv_live")));
    expect((await postCall(initiationFailure("conv_live"))).statusCode).toBe(200);
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual([
      { what: "post-call", forgery: true, reason: "the call is going on at the provider" },
    ]);
    // The answer the owner gives on that call still counts when the call ends.
    expect((await answer({}, "conv_live")).json()).toEqual({ result: "recorded" });
    expect((await postCall(transcription("conv_live"))).statusCode).toBe(200);
    expect(postCalls).toMatchObject([{ type: "transcription", conversationId: "conv_live" }]);
  });

  it.each([
    ["ElevenLabs has no such conversation", undefined, true, "the provider has no such record"],
    [
      "the call ended normally",
      (r: ConversationRecord) => Object.assign(r, { status: "done" }),
      true,
      "the call did not fail at the provider",
    ],
    [
      "someone spoke on the call",
      (r: ConversationRecord) => Object.assign(r, { transcript: [{ role: "user", message: "hello?" }] }),
      true,
      "the call was answered at the provider",
    ],
    [
      "the call is inbound",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.direction = "inbound";
        return r;
      },
      true,
      "the failed call is not outbound",
    ],
    [
      "the call went to another number",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.external_number = STRANGER;
        return r;
      },
      true,
      "the call is not with the owner's number",
    ],
    [
      "the call is on another ElevenLabs number",
      (r: ConversationRecord) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.phone_number_id = "phnum_other";
        return r;
      },
      true,
      "the call is not on the Hotline number",
    ],
    [
      "it is another agent's conversation",
      (r: ConversationRecord) => Object.assign(r, { agent_id: "agent_other" }),
      true,
      "the conversation belongs to another agent",
    ],
  ])("ignores a failure when %s", async (_name, change, forgery, reason) => {
    if (change !== undefined) conversations.set("conv_f", change(failedRecord("conv_f")));
    expect((await postCall(initiationFailure("conv_f"))).statusCode).toBe(200);
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual([{ what: "post-call", forgery, reason }]);
  });

  it("ignores a failure for a call Hotline does not wait on, raising no alarm", async () => {
    unplaced.add("conv_old");
    conversations.set("conv_old", failedRecord("conv_old"));
    expect((await postCall(initiationFailure("conv_old"))).statusCode).toBe(200);
    expect(postCalls).toEqual([]);
    expect(unverified).toEqual([
      { what: "post-call", forgery: false, reason: "the failed call is not one Hotline waits on" },
    ]);
  });

  it("asks ElevenLabs to send a failure again while it cannot be reached", async () => {
    let down = true;
    await app.close();
    app = server({
      conversation: async (id) => {
        if (down) throw new PullError("Could not reach ElevenLabs", "unreachable");
        return structuredClone(conversations.get(id) as ConversationRecord);
      },
    });
    conversations.set("conv_busy", failedRecord("conv_busy"));
    expect((await postCall(initiationFailure("conv_busy"))).statusCode).toBe(503);
    expect(postCalls).toEqual([]);
    down = false;
    expect((await postCall(initiationFailure("conv_busy"))).statusCode).toBe(200);
    expect(postCalls).toMatchObject([{ type: "initiation-failure", reason: "no-answer" }]);
  });
});

describe("every server tool is checked against ElevenLabs' record (HL-13a)", () => {
  const TOOL_EXTRAS = {
    submit_answer: { ask_number: 1, decision: "deny", owner_words: "no, don't" },
    // Another guess than the one that verified the call, so it is not a repeat delivery.
    verify_pin: { pin: "0000" },
    get_status: {},
    send_instruction: { session_number: 1, instruction: "push to main", owner_words: "push to main" },
  } as const;
  type Name = keyof typeof TOOL_EXTRAS;
  const NAMES = Object.keys(TOOL_EXTRAS) as Name[];
  /** An inbound call from the owner whose PIN was verified while ElevenLabs had it live. */
  const verifiedCall = async (conversation: string) => {
    const call = { ...binding(conversation), caller_id: OWNER, called_number: AGENT_NUMBER };
    unplaced.add(conversation);
    expect((await tool("verify_pin", { ...call, pin: PIN })).json()).toMatchObject({ verified: true });
    unverified = [];
    return call;
  };
  /** No handler ran: nothing held, denied or read out. */
  const nothingHappened = () => {
    expect([answers, statusCalls, instructions]).toEqual([[], [], []]);
  };

  it.each(NAMES)("serves %s on a verified live call", async (name) => {
    const call = await verifiedCall("conv_ok");
    const response = (await tool(name, { ...call, ...TOOL_EXTRAS[name] })).json();
    expect(response.result ?? response.verified).not.toBe("refused");
    expect(unverified).toEqual([]);
  });

  const changes: [string, (r: ConversationRecord) => ConversationRecord | undefined, string][] = [
    ["the call has ended", (r) => Object.assign(r, { status: "done" }), "the call is not going on"],
    ["ElevenLabs has no such conversation", () => undefined, "the provider has no such record"],
    [
      "it is another agent's conversation",
      (r) => Object.assign(r, { agent_id: "agent_other" }),
      "the conversation belongs to another agent",
    ],
    [
      "the call is with someone else",
      (r) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.external_number = STRANGER;
        return r;
      },
      "the call is not with the owner's number",
    ],
    [
      "the call is on another ElevenLabs number",
      (r) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.phone_number_id = "phnum_other";
        return r;
      },
      "the call is not on the Hotline number",
    ],
    [
      "the call has another call SID",
      (r) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.call_sid = `CA${"9".repeat(32)}`;
        return r;
      },
      "the call SID differs from the provider's",
    ],
    [
      "ElevenLabs has the call the other way round",
      (r) => {
        if (r.metadata?.phone_call) r.metadata.phone_call.direction = "outbound";
        return r;
      },
      "the numbers differ from the provider's",
    ],
  ];
  const cases = NAMES.flatMap((name) =>
    changes.map(([what, change, reason]) => [name, what, change, reason] as const),
  );

  it.each(cases)("refuses %s when %s, with no effect", async (name, _what, change, reason) => {
    const call = await verifiedCall("conv_odd");
    const changed = change(structuredClone(conversations.get("conv_odd") as ConversationRecord));
    if (changed === undefined) conversations.delete("conv_odd");
    else conversations.set("conv_odd", changed);
    const response = await tool(name, { ...call, ...TOOL_EXTRAS[name] }, { unknownAtElevenLabs: true });
    expect(response.json()).toEqual({ result: "refused", end_call: true });
    nothingHappened();
    expect(unverified).toEqual([{ what: name, forgery: true, reason }]);
  });

  it.each(NAMES)("refuses %s when ElevenLabs cannot be reached, as no forgery", async (name) => {
    const call = await verifiedCall("conv_down");
    await app.close();
    app = server({
      conversation: async () => {
        throw new PullError("Could not reach ElevenLabs", "unreachable");
      },
    });
    const response = await tool(name, { ...call, ...TOOL_EXTRAS[name] });
    expect(response.json()).toEqual({ result: "refused", end_call: true });
    nothingHappened();
    expect(unverified).toEqual([
      { what: name, forgery: false, reason: "the provider lookup failed (unreachable)" },
    ]);
  });

  it.each(NAMES)("refuses %s without the call SID or a number ElevenLabs has", async (name) => {
    const call = await verifiedCall("conv_partial");
    const { call_sid: _sid, ...noSid } = call;
    const { caller_id: _caller, ...noCaller } = call;
    for (const body of [noSid, noCaller, { ...call, call_sid: "" }]) {
      const response = await tool(name, { ...body, ...TOOL_EXTRAS[name] });
      expect(response.json()).toEqual({ result: "refused", end_call: true });
    }
    nothingHappened();
  });

  it("takes the direction from ElevenLabs' record, never the tool call's numbers", async () => {
    // Hotline placed conv_dir, but ElevenLabs has the owner calling in: an answer needs the PIN.
    const inbound = liveRecord({ ...binding("conv_dir"), caller_id: OWNER, called_number: AGENT_NUMBER });
    conversations.set("conv_dir", inbound);
    expect(
      (await answer({ caller_id: OWNER, called_number: AGENT_NUMBER }, "conv_dir")).json(),
    ).toMatchObject({
      result: "pin-required",
    });
    // Claiming Hotline dialled out instead does not match the record at all.
    expect((await answer({}, "conv_dir")).json()).toEqual({ result: "refused", end_call: true });
    expect(answers).toEqual([]);
  });

  it("never reads the status out or holds anything once the call is over, PIN or not", async () => {
    const call = await verifiedCall("conv_over");
    (conversations.get("conv_over") as ConversationRecord).status = "done";
    for (const name of NAMES) {
      expect((await tool(name, { ...call, ...TOOL_EXTRAS[name] })).json()).toEqual({
        result: "refused",
        end_call: true,
      });
    }
    nothingHappened();
  });
});

describe("a daemon restart in the middle of things (HL-13b)", () => {
  let dir: string;
  let path: string;
  let store: HotlineStore;
  let line: InboundLine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hotline-hl13b-routes-"));
    path = join(dir, "hotline.db");
    await start();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** One run: the store on `path`, a fresh PinGate and inbound line, and the routes wired as `runDaemon` wires them. */
  async function start() {
    await app.close();
    store = await openStore(path);
    pins = new PinGate({
      check: async (pin) => pin === PIN,
      clock: () => now,
      failures: storedPinFailures(store),
    });
    line = new InboundLine({ store, clock: () => now, redact: (text) => text });
    await line.recover();
    app = server({
      deliveries: storedToolDeliveries(store),
      savedPinVerification: (conversationId) => line.savedPin(conversationId),
      handlers: {
        submitAnswer: (answer) => {
          answers.push(answer);
          return "recorded";
        },
        getStatus: (call) => line.getStatus(call),
        sendInstruction: (instruction) => line.sendInstruction(instruction),
        postCall: (event, receivedAt) => line.postCall(event, receivedAt, false),
      },
    });
  }

  async function restart() {
    store.close();
    await start();
  }

  const inbound = (conversation: string) => ({
    ...binding(conversation),
    caller_id: OWNER,
    called_number: AGENT_NUMBER,
  });

  /**
   * An inbound call that began 60 s before the PIN (at T0): the owner names
   * session 1 at T0+10 s, the agent reads it back at T0+15 s, and the owner
   * says yes at T0+20 s. `send_instruction` arrives at `heldAt` seconds after
   * T0, the daemon restarts at `restartAt`, and with `pinAgainAt` the owner
   * gives the PIN again in the new run. Returns the instructions queued once
   * the real, signed post-call webhook has been handled.
   */
  async function heldAcrossRestart(
    heldAt: number,
    restartAt: number,
    pinAgainAt?: number,
    /** What ElevenLabs' record of the finished call says, when it differs. */
    record: { callSid?: string; durationSecs?: number } = {},
  ) {
    store.putSession({
      id: "s-1",
      agent: "claude-code",
      cwd: "/work/demo-app",
      nickname: "Claude in demo-app",
      state: "working",
      registeredAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    });
    unplaced.add("conv_r");
    const t0 = now.getTime();
    const at = (seconds: number) => {
      now = new Date(t0 + seconds * 1000);
    };
    expect((await tool("verify_pin", { ...inbound("conv_r"), pin: PIN })).json()).toMatchObject({
      verified: true,
    });
    expect((await tool("get_status", inbound("conv_r"))).json()).toMatchObject({ result: "ok" });
    at(heldAt);
    const held = await tool("send_instruction", {
      ...inbound("conv_r"),
      session_number: 1,
      instruction: "run the tests",
      owner_words: "session 1, run the tests",
    });
    expect(held.json()).toEqual({ result: "queued" });
    at(restartAt);
    await restart();
    if (pinAgainAt !== undefined) {
      at(pinAgainAt);
      // The same words, so a byte-identical body: checked again, not answered from memory.
      expect((await tool("verify_pin", { ...inbound("conv_r"), pin: PIN })).json()).toMatchObject({
        verified: true,
      });
    }
    at(90);
    const turn = (role: "agent" | "user", message: string, second: number) => ({
      role,
      message,
      time_in_call_secs: 60 + second,
    });
    const response = await postCall({
      type: "post_call_transcription",
      event_timestamp: now.getTime() / 1000,
      data: {
        agent_id: AGENT_ID,
        conversation_id: "conv_r",
        status: "done",
        transcript: [
          turn("agent", "Hey, it's your hotline.", -60),
          turn("user", "4821", -5),
          turn("agent", "One live session. Session 1, Claude in demo-app: working.", 2),
          turn("user", "session 1, run the tests", 10),
          turn("agent", "For session 1: run the tests. Send it?", 15),
          turn("user", "Yes.", 20),
          turn("agent", "Sent.", 25),
        ],
        metadata: {
          start_time_unix_secs: t0 / 1000 - 60,
          call_duration_secs: record.durationSecs ?? 90,
          phone_call: {
            direction: "inbound",
            external_number: OWNER,
            agent_number: AGENT_NUMBER,
            phone_number_id: PHONE_ID,
            call_sid: record.callSid ?? `CA${"0".repeat(31)}1`,
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    return store.listInstructions().map((i) => [i.sessionId, i.text, i.status]);
  }

  it("confirms an instruction held before the restart from the real post-call event", async () => {
    expect(await heldAcrossRestart(22, 30)).toEqual([["s-1", "run the tests", "queued"]]);
  });

  it("does not count words said after the restart as the owner's until the PIN is given again", async () => {
    // The yes comes after the restart, with no PIN in the new run: it is nobody's yes.
    expect(await heldAcrossRestart(11, 12)).toEqual([]);
  });

  it("counts words said after the PIN is given again in the new run", async () => {
    expect(await heldAcrossRestart(11, 12, 14)).toEqual([["s-1", "run the tests", "queued"]]);
  });

  it("uses a saved PIN time only for the call SID it was given on", async () => {
    expect(await heldAcrossRestart(22, 30, undefined, { callSid: `CA${"9".repeat(32)}` })).toEqual([]);
  });

  it("uses a saved PIN time only when it falls within the call", async () => {
    // The record says the call ended 30 s after it began, before the PIN time.
    expect(await heldAcrossRestart(22, 30, undefined, { durationSecs: 30 })).toEqual([]);
  });

  it("refuses a replayed submit_answer once the call is over, and never re-runs it while it goes on", async () => {
    await answer();
    expect(answers).toHaveLength(1);
    await restart();
    // The call still goes on: the first response, without running the handler again.
    expect((await answer()).json()).toEqual({ result: "recorded" });
    expect(answers).toHaveLength(1);
    // The call is over at ElevenLabs: the replay gets the refusal, not the remembered response.
    const record = conversations.get("conv_1");
    if (record === undefined) throw new Error("no record");
    conversations.set("conv_1", { ...record, status: "done" });
    expect((await answer()).json()).toEqual({ result: "refused", end_call: true });
    expect(answers).toHaveLength(1);
  });

  it("never reads out the status to a get_status replayed after the call ended", async () => {
    unplaced.add("conv_s");
    await tool("verify_pin", { ...inbound("conv_s"), pin: PIN });
    const read = await tool("get_status", inbound("conv_s"));
    expect(read.json()).toMatchObject({ result: "ok" });
    const record = conversations.get("conv_s");
    if (record === undefined) throw new Error("no record");
    conversations.set("conv_s", { ...record, status: "done" });
    const replay = await tool("get_status", inbound("conv_s"));
    expect(replay.json()).toEqual({ result: "refused", end_call: true });
    expect(replay.body).not.toContain("demo-app");
    expect(replay.body).not.toContain("session");
    // A status is never remembered.
    expect(store.countToolDeliveries(now.getTime())).toBe(1);
  });

  it("never lets the saved PIN time serve a live tool after a restart", async () => {
    store.putSession({
      id: "s-1",
      agent: "claude-code",
      cwd: "/work/demo-app",
      nickname: "Claude in demo-app",
      state: "working",
      registeredAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    });
    unplaced.add("conv_l");
    await tool("verify_pin", { ...inbound("conv_l"), pin: PIN });
    await tool("get_status", inbound("conv_l"));
    await tool("send_instruction", {
      ...inbound("conv_l"),
      session_number: 1,
      instruction: "run the tests",
      owner_words: "session 1, run the tests",
    });
    await restart();
    expect(line.savedPin("conv_l")).toEqual({ verifiedAt: now, callSid: `CA${"0".repeat(31)}1` });
    expect((await tool("get_status", inbound("conv_l"))).json()).toMatchObject({ result: "pin-required" });
  });

  it("checks the same right PIN again on the same call after a restart", async () => {
    unplaced.add("conv_p");
    const say = () => tool("verify_pin", { ...inbound("conv_p"), pin: PIN });
    expect((await say()).json()).toMatchObject({ verified: true });
    await restart();
    expect(pins.isVerified("conv_p")).toBe(false);
    expect((await say()).json()).toMatchObject({ verified: true });
    expect(pins.isVerified("conv_p")).toBe(true);
    expect((await tool("get_status", inbound("conv_p"))).json()).toMatchObject({ result: "ok" });
  });

  it("still answers a wrong guess from before the restart from memory, spending nothing", async () => {
    unplaced.add("conv_g");
    const guess = () => tool("verify_pin", { ...inbound("conv_g"), pin: "1111" });
    expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
    await restart();
    expect((await guess()).json()).toMatchObject({ verified: false, attempts_left: 1 });
    expect(store.pinFailureTimes("inbound")).toHaveLength(1);
  });

  it("never stores a key the PIN could be found from without the tool secret", async () => {
    unplaced.add("conv_k");
    const body = { ...inbound("conv_k"), pin: "7391" };
    await tool("verify_pin", body);
    store.close();
    const raw = new DatabaseSync(path);
    const stored = raw
      .prepare("SELECT key FROM tool_deliveries")
      .all()
      .map((row) => String(row.key));
    raw.close();
    const text = `verify_pin\0${JSON.stringify(body)}`;
    expect(stored).toEqual([createHmac("sha256", TOOL_SECRET).update(text, "utf8").digest("base64url")]);
    expect(stored).not.toContain(createHash("sha256").update(text, "utf8").digest("base64url"));
    await start();
  });

  it("refuses a delivery whose saved response is damaged, rather than run it again", async () => {
    await answer();
    expect(answers).toHaveLength(1);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE tool_deliveries SET response = 'not json'");
    raw.close();
    await start();
    expect((await answer()).json()).toEqual({ result: "busy" });
    expect(answers).toHaveLength(1);
  });
});
