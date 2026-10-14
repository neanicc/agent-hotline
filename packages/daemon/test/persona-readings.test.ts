// HL-14b: the persona prompt tells the voice agent to read each ask on its own
// turn, in the ask's own words, and to submit free text verbatim. The fake voice
// provider plays exactly that, so these tests check that the daemon's reading
// match (`readings`) recognises such readings for one, two and four asks, that
// the owner's answers to them confirm, and that a turn reading two asks at once
// reads neither (fails closed, as designed).
import type { Decision } from "@hotline/core";
import {
  FakeVoiceProvider,
  type HumanStep,
  parsePostCallEvent,
  scriptedHuman,
  type TranscriptTurn,
  type VoiceAsk,
  type VoiceToolClient,
} from "@hotline/providers";
import { describe, expect, it } from "vitest";
import { confirmVoiceDecision, type ReadAsk, readings } from "../src/index.js";

const OWNER = "+15555550100";

/** Four asks of every answerable kind, from two sessions, as the daemon would queue them. */
const ASKS: readonly VoiceAsk[] = [
  {
    askId: "ask-1",
    kind: "permission",
    nickname: "Claude in demo-app",
    text: "git push origin main",
    options: [],
    risk: "low",
    toolName: "Bash",
  },
  {
    askId: "ask-2",
    kind: "question",
    nickname: "Codex in api-server",
    text: "Pin the older ONNX runtime or skip the Windows build?",
    options: ["Pin ONNX 1.17", "Skip Windows"],
    risk: "low",
  },
  {
    askId: "ask-3",
    kind: "permission",
    nickname: "Claude in demo-app",
    text: "rm -rf dist and rebuild the release bundle",
    options: [],
    risk: "high",
    toolName: "Bash",
  },
  {
    askId: "ask-4",
    kind: "stop",
    nickname: "Codex in api-server",
    text: "Finished the database migration. What should I do next?",
    options: [],
    risk: "low",
  },
];

/** What the owner says to each ask, and the decision the voice agent submits for it. */
const ANSWERS: readonly { words: string; decision: Decision }[] = [
  { words: "yes, go ahead", decision: { type: "allow" } },
  { words: "the second one, skip Windows", decision: { type: "option", option: 2 } },
  { words: "no, don't do that", decision: { type: "deny" } },
  {
    words: "write the tests for the new endpoint",
    decision: { type: "text", text: "write the tests for the new endpoint" },
  },
];

/** The ask as the daemon's orchestrator rebuilds it for the check (`#readAsk`). */
const readAsk = (ask: VoiceAsk): ReadAsk => ({
  text: ask.text,
  nickname: ask.nickname,
  options: ask.options,
  ...(ask.toolName === undefined ? {} : { toolName: ask.toolName }),
});

const step = (ask: number, { words, decision }: (typeof ANSWERS)[number]): HumanStep => ({
  kind: "answer",
  ask,
  words,
  decision: decision.type,
  ...(decision.type === "option" ? { option: decision.option } : {}),
  ...(decision.type === "text" ? { text: decision.text } : {}),
});

/**
 * As `step`, but an allow is played the definition v4 way (HL-14c): the owner
 * says yes, the agent reads the request back, and the owner's `words` are the
 * reply to it. HL-09c confirms an allow only from that reply.
 */
const v4Step = (ask: number, answer: (typeof ANSWERS)[number]): HumanStep =>
  answer.decision.type === "allow"
    ? { kind: "read-back", ask, words: "sure", reply: answer.words, decision: "allow" }
    : step(ask, answer);

/** Plays one call with the fake voice agent and returns the transcript as the daemon parses it. */
async function playCall(asks: readonly VoiceAsk[], steps: readonly HumanStep[]): Promise<TranscriptTurn[]> {
  const postCalls: Record<string, unknown>[] = [];
  const client: VoiceToolClient = {
    async tool() {
      return { result: "recorded" };
    },
    async postCall(payload) {
      postCalls.push(payload);
    },
  };
  const voice = new FakeVoiceProvider({ ownerNumber: OWNER, client });
  voice.script(scriptedHuman.says(...steps));
  await voice.callOwner({ callId: "call-hl14b", asks });
  await voice.playPending();
  const event = parsePostCallEvent(postCalls[0], {
    ownerNumber: OWNER,
    pinVerifiedAt: () => undefined,
    placedCall: () => true,
  });
  if (event?.type !== "transcription") throw new Error("the fake sent no transcript");
  return event.transcript;
}

describe("the fake voice agent's readings follow the persona and are recognised", () => {
  it.each([1, 2, 4])("recognises each of %i asks read on its own turn, in order", async (count) => {
    const asks = ASKS.slice(0, count);
    const transcript = await playCall(
      asks,
      asks.map((_, i) => v4Step(i + 1, ANSWERS[i] as (typeof ANSWERS)[number])),
    );
    const read = readings(transcript, asks.map(readAsk));
    // Every ask is read by an agent turn, in call order; the allow (ask 1) is
    // read a second time, by its read-back, right after its first reading.
    const readTurns = read.flatMap((ask, at) => (ask === undefined ? [] : [{ ask, at }]));
    expect(readTurns.map((turn) => turn.ask)).toEqual([0, 0, ...asks.slice(1).map((_, i) => i + 1)]);
    for (const { at } of readTurns) expect(transcript[at]?.role).toBe("agent");
    // And each answer the owner gave right after its reading confirms.
    asks.forEach((_, index) => {
      const answer = ANSWERS[index] as (typeof ANSWERS)[number];
      expect(
        confirmVoiceDecision({
          transcript,
          asks: asks.map(readAsk),
          index,
          decision: answer.decision,
          ownerWords: answer.words,
        }),
        `ask ${index + 1} of ${count}`,
      ).toEqual({ confirmed: true, excerpt: answer.words });
    });
  });

  it("recognises readings when the owner answers a later ask first", async () => {
    const asks = ASKS.slice(0, 2);
    const transcript = await playCall(asks, [
      step(2, ANSWERS[1] as (typeof ANSWERS)[number]),
      step(1, ANSWERS[0] as (typeof ANSWERS)[number]),
    ]);
    const read = readings(transcript, asks.map(readAsk));
    expect(read.filter((ask) => ask !== undefined)).toEqual([0, 1]);
  });

  it("confirms a free-text answer only when it is the owner's words verbatim", async () => {
    const asks = [ASKS[3] as VoiceAsk];
    const said = "write the tests for the new endpoint";
    const transcript = await playCall(asks, [step(1, ANSWERS[3] as (typeof ANSWERS)[number])]);
    const check = (text: string) =>
      confirmVoiceDecision({
        transcript,
        asks: asks.map(readAsk),
        index: 0,
        decision: { type: "text", text },
        ownerWords: said,
      }).confirmed;
    expect(check(said)).toBe(true);
    // A summary or a reworded instruction is not what the owner said.
    expect(check("add endpoint tests")).toBe(false);
    expect(check("write the tests for the new endpoint and deploy")).toBe(false);
  });

  it("recognises the read-back before an allow as the same ask, so the reply to it confirms (HL-14c)", async () => {
    const asks = ASKS.slice(0, 2);
    const transcript = await playCall(asks, [
      { kind: "read-back", ask: 1, words: "yeah, go for it", reply: "yes", decision: "allow" },
      step(2, ANSWERS[1] as (typeof ANSWERS)[number]),
    ]);
    const readBack = transcript.findIndex((turn) => turn.message.startsWith("Allow "));
    expect(transcript[readBack]?.message).toBe(
      "Allow Bash to git push origin main for Claude in demo-app? Yes?",
    );
    const read = readings(transcript, asks.map(readAsk));
    // The reading and the read-back both read ask 1, never ask 2.
    expect(read.flatMap((ask, at) => (ask === 0 ? [at] : []))).toEqual([readBack - 2, readBack]);
    expect(
      confirmVoiceDecision({
        transcript,
        asks: asks.map(readAsk),
        index: 0,
        decision: { type: "allow" },
        ownerWords: "yes",
      }),
    ).toEqual({ confirmed: true, excerpt: "yes" });
    // The next ask's answer still lands after its own reading.
    expect(
      confirmVoiceDecision({
        transcript,
        asks: asks.map(readAsk),
        index: 1,
        decision: { type: "option", option: 2 },
        ownerWords: "the second one, skip Windows",
      }).confirmed,
    ).toBe(true);
  });

  it("confirms an allow read back after the owner answered a later ask first (HL-09c)", async () => {
    const asks = ASKS.slice(0, 2);
    const transcript = await playCall(asks, [
      step(2, ANSWERS[1] as (typeof ANSWERS)[number]),
      { kind: "read-back", ask: 1, words: "and the first one, sure", reply: "of course", decision: "allow" },
    ]);
    expect(
      confirmVoiceDecision({
        transcript,
        asks: asks.map(readAsk),
        index: 0,
        decision: { type: "allow" },
        ownerWords: "of course",
      }),
    ).toEqual({ confirmed: true, excerpt: "of course" });
  });

  it("tells apart read-backs of two asks that differ only by tool", async () => {
    const base = ASKS[0] as VoiceAsk;
    const asks: VoiceAsk[] = [
      { ...base, askId: "ask-read", text: "the deploy config", toolName: "Read" },
      { ...base, askId: "ask-write", text: "the deploy config", toolName: "Write" },
    ];
    const transcript = await playCall(asks, [
      { kind: "read-back", ask: 1, words: "sure", reply: "yes", decision: "allow" },
      { kind: "read-back", ask: 2, words: "sure", reply: "yep", decision: "allow" },
    ]);
    const backs = transcript.flatMap((turn, at) => (turn.message.startsWith("Allow ") ? [at] : []));
    expect(backs.map((at) => transcript[at]?.message)).toEqual([
      "Allow Read to the deploy config for Claude in demo-app? Yes?",
      "Allow Write to the deploy config for Claude in demo-app? Yes?",
    ]);
    const read = readings(transcript, asks.map(readAsk));
    expect(backs.map((at) => read[at])).toEqual([0, 1]);
    asks.forEach((_, index) => {
      expect(
        confirmVoiceDecision({
          transcript,
          asks: asks.map(readAsk),
          index,
          decision: { type: "allow" },
          ownerWords: index === 0 ? "yes" : "yep",
        }),
        `ask ${index + 1}`,
      ).toEqual({ confirmed: true, excerpt: index === 0 ? "yes" : "yep" });
    });
  });

  it("recognises the yes-or-no question as the same ask, and the text promise as none", async () => {
    const asks = ASKS.slice(0, 1);
    const transcript = await playCall(asks, [
      { kind: "unsure", ask: 1, words: "hmm" },
      { kind: "unsure", ask: 1, words: "not sure" },
    ]);
    const read = readings(transcript, asks.map(readAsk));
    expect(transcript.map((turn, at) => [turn.role, read[at]])).toEqual([
      ["agent", undefined],
      ["agent", 0],
      ["owner", undefined],
      ["agent", 0],
      ["owner", undefined],
      ["agent", undefined],
    ]);
  });

  it("reads neither ask from a turn that combines two, so neither answer confirms", async () => {
    const asks = ASKS.slice(0, 2);
    const transcript = await playCall(
      asks,
      asks.map((_, i) => step(i + 1, ANSWERS[i] as (typeof ANSWERS)[number])),
    );
    const read = readings(transcript, asks.map(readAsk));
    const first = read.indexOf(0);
    const second = read.indexOf(1);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    // What a model that breaks the rule would say: both asks in one turn, then the owner's answers.
    const combined: TranscriptTurn[] = [
      ...transcript.slice(0, first),
      {
        role: "agent",
        message: `${transcript[first]?.message ?? ""} ${transcript[second]?.message ?? ""}`,
      },
      { role: "owner", message: ANSWERS[0]?.words ?? "" },
      { role: "owner", message: ANSWERS[1]?.words ?? "" },
    ];
    expect(readings(combined, asks.map(readAsk))).toEqual(combined.map(() => undefined));
    asks.forEach((_, index) => {
      const answer = ANSWERS[index] as (typeof ANSWERS)[number];
      expect(
        confirmVoiceDecision({
          transcript: combined,
          asks: asks.map(readAsk),
          index,
          decision: answer.decision,
          ownerWords: answer.words,
        }),
      ).toEqual({ confirmed: false, reason: "the ask's reading is not in the transcript" });
    });
  });
});
