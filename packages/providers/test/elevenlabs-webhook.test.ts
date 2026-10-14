import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ownerSaid,
  parsePostCallEvent,
  postCallSignature,
  postCallSignatureHeader,
  validPostCallSignature,
} from "../src/index.js";

// The algorithm is the one in the ElevenLabs SDK's `constructEvent`
// (https://github.com/elevenlabs/elevenlabs-js/blob/278c39c0984ef55590749b92e6d0ef947abcee96/src/wrapper/webhooks.ts):
// header "t=<seconds>,v0=<hex HMAC-SHA256(secret, `${t}.${body}`)>". The payload and
// secret are the SDK test's own (tests/custom/client.test.ts, "constructEvent"); the
// expected digest was computed independently with
//   printf '%s' '1760400000.{"eventType":"test_event","data":{"id":"123"}}' \
//     | openssl dgst -sha256 -hmac webhook_secret -hex
const SECRET = "webhook_secret";
const BODY = '{"eventType":"test_event","data":{"id":"123"}}';
const T = 1760400000;
const DIGEST = "d10811a7154bd216128f125f45b2be7b65c9dc288d0d88b19015a2eccbb4cec9";
const HEADER = `t=${T},v0=${DIGEST}`;

describe("post-call webhook signature", () => {
  it("reproduces the documented algorithm's test vector", () => {
    expect(postCallSignature(SECRET, String(T), BODY)).toBe(`v0=${DIGEST}`);
    expect(postCallSignatureHeader(SECRET, T + 0.9, BODY)).toBe(HEADER);
    // And the SDK test's own way of computing it.
    expect(createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex")).toBe(DIGEST);
  });

  it("accepts the vector within the tolerance, in either part order", () => {
    expect(validPostCallSignature(SECRET, BODY, HEADER, T)).toBe(true);
    expect(validPostCallSignature(SECRET, BODY, `v0=${DIGEST},t=${T}`, T + 30 * 60)).toBe(true);
    expect(validPostCallSignature(SECRET, BODY, HEADER, T - 5 * 60)).toBe(true);
  });

  it("refuses a timestamp older than 30 minutes or more than 5 minutes ahead", () => {
    expect(validPostCallSignature(SECRET, BODY, HEADER, T + 30 * 60 + 1)).toBe(false);
    expect(validPostCallSignature(SECRET, BODY, HEADER, T - 5 * 60 - 1)).toBe(false);
  });

  it.each([
    ["a changed body", SECRET, `${BODY} `, HEADER],
    ["a wrong secret", "other_secret", BODY, HEADER],
    ["an empty secret", "", BODY, HEADER],
    ["no header", SECRET, BODY, undefined],
    ["no timestamp", SECRET, BODY, `v0=${DIGEST}`],
    ["no v0 hash", SECRET, BODY, `t=${T}`],
    ["another scheme only", SECRET, BODY, `t=${T},v1=${DIGEST}`],
    ["two timestamps", SECRET, BODY, `t=${T},t=${T},v0=${DIGEST}`],
    ["two hashes", SECRET, BODY, `t=${T},v0=${DIGEST},v0=${DIGEST}`],
    ["a non-numeric timestamp", SECRET, BODY, `t=${T}x,v0=${DIGEST}`],
    ["an upper-case hash", SECRET, BODY, `t=${T},v0=${DIGEST.toUpperCase()}`],
    ["a timestamp the HMAC did not cover", SECRET, BODY, `t=${T + 1},v0=${DIGEST}`],
  ])("refuses %s", (_name, secret, body, header) => {
    expect(validPostCallSignature(secret, body, header, T)).toBe(false);
  });
});

// Shapes from https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
// and the SDK types (ConversationHistoryTwilioPhoneCallModel), with fake values.
const transcription = {
  type: "post_call_transcription",
  event_timestamp: T,
  data: {
    agent_id: "agent_fake",
    conversation_id: "conv_fake_1",
    status: "done",
    user_id: null,
    transcript: [
      { role: "agent", message: "Hey, it's your hotline.", time_in_call_secs: 0 },
      { role: "user", message: "Yes, go ahead.", time_in_call_secs: 4 },
      { role: "agent", message: null, tool_calls: [{ tool_name: "submit_answer" }], time_in_call_secs: 5 },
    ],
    metadata: {
      start_time_unix_secs: T,
      call_duration_secs: 31,
      cost: 120,
      phone_call: {
        direction: "outbound",
        phone_number_id: "phnum_fake",
        agent_number: "+15555550101",
        external_number: "+15555550100",
        type: "twilio",
        stream_sid: "MZfake",
        call_sid: "CAfake",
      },
    },
    analysis: { transcript_summary: "The owner approved." },
    conversation_initiation_client_data: { dynamic_variables: {} },
  },
};

const OWNER_CONTEXT = { ownerNumber: "+15555550100", pinVerified: (id: string) => id === "conv_pin" };

describe("parsePostCallEvent", () => {
  it("reduces a transcription to the fields the daemon uses", () => {
    expect(parsePostCallEvent(transcription, OWNER_CONTEXT)).toEqual({
      type: "transcription",
      agentId: "agent_fake",
      conversationId: "conv_fake_1",
      status: "done",
      direction: "outbound",
      externalNumber: "+15555550100",
      callSid: "CAfake",
      durationSeconds: 31,
      transcript: [
        { role: "agent", message: "Hey, it's your hotline." },
        { role: "owner", message: "Yes, go ahead." },
      ],
    });
  });

  const call = (direction: string, external: string, conversation = "conv_fake_1") => ({
    ...transcription,
    data: {
      ...transcription.data,
      conversation_id: conversation,
      metadata: { phone_call: { direction, external_number: external } },
    },
  });
  const personRoles = (body: unknown, context: typeof OWNER_CONTEXT | undefined = OWNER_CONTEXT) => {
    const event = parsePostCallEvent(body, context);
    return event?.type === "transcription"
      ? event.transcript.filter((t) => t.role !== "agent").map((t) => t.role)
      : [];
  };

  it.each([
    ["an outbound call to the owner", call("outbound", "+15555550100"), "owner"],
    ["an outbound call to another number", call("outbound", "+15555550199"), "caller"],
    [
      "an inbound call from the owner's number after the PIN",
      call("inbound", "+15555550100", "conv_pin"),
      "owner",
    ],
    ["an inbound call from the owner's number without the PIN", call("inbound", "+15555550100"), "caller"],
    [
      "an inbound call from a stranger, even with the PIN",
      call("inbound", "+15555550199", "conv_pin"),
      "caller",
    ],
    [
      "a call with no phone metadata",
      { ...transcription, data: { ...transcription.data, metadata: null } },
      "caller",
    ],
  ])("labels the person's turns on %s as %s", (_name, body, role) => {
    expect(personRoles(body)).toEqual([role]);
  });

  it("labels every person's turn a caller's without the owner context", () => {
    const event = parsePostCallEvent(transcription);
    expect(event?.type === "transcription" && event.transcript.map((t) => t.role)).toEqual([
      "agent",
      "caller",
    ]);
  });

  it("never lets a stranger's words confirm a decision", () => {
    const stranger = parsePostCallEvent(call("inbound", "+15555550199", "conv_pin"), OWNER_CONTEXT);
    expect(stranger?.type === "transcription" && ownerSaid("yes go ahead", stranger.transcript)).toBe(false);
    const owner = parsePostCallEvent(call("outbound", "+15555550100"), OWNER_CONTEXT);
    expect(owner?.type === "transcription" && ownerSaid("yes go ahead", owner.transcript)).toBe(true);
  });

  it.each([
    ["busy", "busy"],
    ["no-answer", "no-answer"],
    ["unknown", "unknown"],
    ["something-new", "unknown"],
  ])("maps a call initiation failure %s to %s", (failure_reason, reason) => {
    const body = {
      type: "call_initiation_failure",
      event_timestamp: T,
      data: {
        agent_id: "agent_fake",
        conversation_id: "conv_fake_2",
        failure_reason,
        metadata: { type: "twilio", body: {} },
      },
    };
    expect(parsePostCallEvent(body)).toEqual({
      type: "initiation-failure",
      agentId: "agent_fake",
      conversationId: "conv_fake_2",
      reason,
    });
  });

  it("acknowledges other webhook types without reading them", () => {
    expect(parsePostCallEvent({ type: "post_call_audio", data: { full_audio: "..." } })).toEqual({
      type: "other",
    });
  });

  it.each([
    ["not an object", "hello"],
    ["no type", { data: {} }],
    [
      "a transcription without a conversation id",
      { ...transcription, data: { agent_id: "a", status: "done" } },
    ],
    [
      "a failure without a reason",
      { type: "call_initiation_failure", event_timestamp: T, data: { agent_id: "a" } },
    ],
  ])("rejects %s", (_name, body) => {
    expect(parsePostCallEvent(body)).toBeUndefined();
  });
});

describe("ownerSaid", () => {
  const turns = [
    { role: "agent" as const, message: "Should Claude push to main? Say yes, go ahead." },
    { role: "owner" as const, message: "Hmm." },
    { role: "owner" as const, message: "Yes, go ahead!" },
  ];

  it("finds the owner's words, ignoring case and punctuation", () => {
    expect(ownerSaid("yes go ahead", turns)).toBe(true);
    expect(ownerSaid("Hmm. Yes, go ahead", turns)).toBe(true);
  });

  it("never counts the agent's own words or partial words", () => {
    expect(ownerSaid("Should Claude push to main", turns)).toBe(false);
    expect(ownerSaid("yes go ahea", turns)).toBe(false);
    expect(ownerSaid("es go ahead", turns)).toBe(false);
    expect(ownerSaid("...", turns)).toBe(false);
    expect(ownerSaid("yes", [{ role: "agent", message: "yes" }])).toBe(false);
    expect(ownerSaid("yes", [{ role: "caller", message: "yes" }])).toBe(false);
  });

  it("does not join owner turns across an agent turn", () => {
    const split = [
      { role: "owner" as const, message: "yes" },
      { role: "agent" as const, message: "Sorry?" },
      { role: "owner" as const, message: "go ahead" },
    ];
    expect(ownerSaid("yes go ahead", split)).toBe(false);
  });
});
