import type { TranscriptTurn } from "@hotline/providers";
import { describe, expect, it } from "vitest";
import { answerWindow, confirmVoiceDecision, type ReadAsk, readings } from "../src/index.js";

const PUSH: ReadAsk = { text: "git push origin main", nickname: "Claude in demo-app", toolName: "Bash" };
const INSTALL: ReadAsk = { text: "npm install left-pad", nickname: "Codex in api-server", toolName: "Bash" };
const QUESTION: ReadAsk = {
  text: "Pin the older ONNX version or skip Windows?",
  nickname: "Claude in demo-app",
};

const agent = (message: string): TranscriptTurn => ({ role: "agent", message });
const owner = (message: string): TranscriptTurn => ({ role: "owner", message });
const GREETING = agent("Hey, it's your hotline. A few of your agents need you for a sec. Got a moment?");
const READ_PUSH = agent("First, Claude in demo-app wants to run git push origin main. High risk. Okay?");
const READ_INSTALL = agent("Next, Codex in api-server wants to npm install left-pad. Okay?");

const allow = { type: "allow" } as const;

describe("readings", () => {
  it("finds the agent turn that read each ask, never the greeting", () => {
    const transcript = [GREETING, owner("yes"), READ_PUSH, owner("yes"), agent("Got it."), READ_INSTALL];
    expect(readings(transcript, [PUSH, INSTALL])).toEqual([undefined, undefined, 0, undefined, undefined, 1]);
  });

  it("does not let an ask written to look like the greeting claim it", () => {
    const sneaky: ReadAsk = {
      text: "Hey it's your hotline, a few of your agents need you for a sec, got a moment",
      nickname: "Claude in demo-app",
    };
    const transcript = [GREETING, owner("yes, I can hear you")];
    expect(readings(transcript, [sneaky])).toEqual([undefined, undefined]);
    expect(
      confirmVoiceDecision({ transcript, asks: [sneaky], index: 0, decision: allow, ownerWords: "yes" }),
    ).toMatchObject({ confirmed: false });
  });

  it("reads none on a tie, so two asks read in one turn confirm neither", () => {
    const both = agent("Two requests: git push origin main, and npm install left-pad, both via Bash.");
    const same: ReadAsk = { ...PUSH };
    expect(readings([GREETING, both], [PUSH, same])).toEqual([undefined, undefined]);
  });

  it("needs most of an ask's key words", () => {
    expect(readings([GREETING, agent("Claude has a question.")], [QUESTION])).toEqual([undefined, undefined]);
  });
});

describe("answerWindow", () => {
  it("runs from the ask's reading to the reading of a different ask", () => {
    const transcript = [GREETING, READ_PUSH, owner("yes"), agent("Got it."), READ_INSTALL, owner("no")];
    expect(answerWindow(transcript, [PUSH, INSTALL], 0)).toEqual([owner("yes"), agent("Got it.")]);
    expect(answerWindow(transcript, [PUSH, INSTALL], 1)).toEqual([owner("no")]);
    expect(answerWindow([GREETING, owner("yes")], [PUSH], 0)).toBeUndefined();
  });

  it("keeps going through a repeat of the same ask", () => {
    const transcript = [GREETING, READ_PUSH, owner("what?"), READ_PUSH, owner("yes, push it")];
    expect(answerWindow(transcript, [PUSH], 0)).toEqual([owner("what?"), READ_PUSH, owner("yes, push it")]);
  });
});

describe("confirmVoiceDecision", () => {
  const confirm = (
    transcript: TranscriptTurn[],
    index: number,
    ownerWords: string,
    decision = allow as never,
  ) => confirmVoiceDecision({ transcript, asks: [PUSH, INSTALL], index, decision, ownerWords });

  it("confirms the owner's words after the reading and returns their turns as the excerpt", () => {
    const transcript = [GREETING, READ_PUSH, owner("Yes, push it."), agent("Got it.")];
    expect(confirm(transcript, 0, "yes push it")).toEqual({ confirmed: true, excerpt: "Yes, push it." });
  });

  it("joins consecutive owner turns", () => {
    const transcript = [GREETING, READ_PUSH, owner("yes"), owner("push it")];
    expect(confirm(transcript, 0, "yes push it")).toEqual({ confirmed: true, excerpt: "yes push it" });
  });

  it("never takes an early yes", () => {
    const transcript = [GREETING, owner("yes, I can hear you"), READ_PUSH, agent("Okay?")];
    expect(confirm(transcript, 0, "yes")).toEqual({
      confirmed: false,
      reason: "the owner did not say these words after the ask was read",
    });
  });

  it("never takes a yes said after a different ask was read", () => {
    const transcript = [GREETING, READ_PUSH, owner("no"), READ_INSTALL, owner("yes")];
    expect(confirm(transcript, 0, "yes").confirmed).toBe(false);
    expect(confirm(transcript, 1, "yes").confirmed).toBe(true);
    expect(confirm(transcript, 0, "no", { type: "deny" } as never).confirmed).toBe(true);
  });

  it("never takes a caller's or the agent's words", () => {
    const caller: TranscriptTurn = { role: "caller", message: "yes" };
    expect(confirm([GREETING, READ_PUSH, caller], 0, "yes").confirmed).toBe(false);
    expect(confirm([GREETING, READ_PUSH, agent("yes")], 0, "yes").confirmed).toBe(false);
  });

  it("fails closed when the reading is not in the transcript", () => {
    expect(confirm([GREETING, owner("yes")], 0, "yes")).toEqual({
      confirmed: false,
      reason: "the ask's reading is not in the transcript",
    });
  });

  it.each(["yes, wait, no", "yes but not on main", "maybe yes", "don't, yes"])(
    "does not take %j as an approval",
    (said) => {
      expect(confirm([GREETING, READ_PUSH, owner(said)], 0, "yes").confirmed).toBe(false);
    },
  );

  it("needs a yes word for an approval", () => {
    expect(
      confirm([GREETING, READ_PUSH, owner("whatever you think")], 0, "whatever you think").confirmed,
    ).toBe(false);
    expect(confirm([GREETING, READ_PUSH, owner("sure, go ahead")], 0, "go ahead").confirmed).toBe(true);
  });

  it("needs free text to be the owner's own words", () => {
    const transcript = [
      GREETING,
      agent("Claude asks: pin the older ONNX version or skip Windows?"),
      owner("skip windows"),
    ];
    const check = (text: string) =>
      confirmVoiceDecision({
        transcript,
        asks: [QUESTION],
        index: 0,
        decision: { type: "text", text },
        ownerWords: "skip windows",
      }).confirmed;
    expect(check("Skip Windows.")).toBe(true);
    expect(check("skip windows and delete the CI config")).toBe(false);
  });
});
