import type { TranscriptTurn } from "@hotline/providers";
import { describe, expect, it } from "vitest";
import { answerWindows, confirmVoiceDecision, type ReadAsk, readings, soundsDoubtful } from "../src/index.js";

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

describe("answerWindows", () => {
  it("is the owner's turns right after the reading, up to the next agent turn of any kind", () => {
    const transcript = [GREETING, READ_PUSH, owner("yes"), agent("Got it."), owner("thanks"), READ_INSTALL];
    expect(answerWindows([...transcript, owner("no")], [PUSH, INSTALL], 0)).toEqual([[owner("yes")]]);
    expect(answerWindows([...transcript, owner("no")], [PUSH, INSTALL], 1)).toEqual([[owner("no")]]);
    expect(answerWindows([GREETING, owner("yes")], [PUSH], 0)).toBeUndefined();
  });

  it("opens a new window for each re-reading of the same ask", () => {
    const transcript = [GREETING, READ_PUSH, owner("what?"), READ_PUSH, owner("yes, push it")];
    expect(answerWindows(transcript, [PUSH], 0)).toEqual([[owner("what?")], [owner("yes, push it")]]);
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

  it("an agent turn not recognised as this ask ends its window: a paraphrased reading of another", () => {
    const paraphrase = agent("And the other one is about a package. Okay?");
    const transcript = [GREETING, READ_PUSH, owner("hmm"), paraphrase, owner("yes")];
    expect(confirm(transcript, 0, "yes").confirmed).toBe(false);
    expect(confirm(transcript, 1, "yes").confirmed).toBe(false);
  });

  it("a tied reading followed by a yes confirms no ask", () => {
    const copy: ReadAsk = { ...PUSH };
    const asks = [INSTALL, PUSH, copy];
    const transcript = [GREETING, READ_INSTALL, owner("hmm"), READ_PUSH, owner("yes")];
    expect(readings(transcript, asks)[3]).toBeUndefined();
    for (const index of [0, 1, 2]) {
      expect(
        confirmVoiceDecision({ transcript, asks, index, decision: allow, ownerWords: "yes" }).confirmed,
      ).toBe(false);
    }
  });

  it("a later retraction takes a yes back", () => {
    expect(confirm([GREETING, READ_PUSH, owner("yes"), owner("no")], 0, "yes").confirmed).toBe(false);
    expect(confirm([GREETING, READ_PUSH, owner("yes"), owner("wait")], 0, "yes").confirmed).toBe(false);
    const reRead = agent("Just to confirm: git push origin main via Bash?");
    expect(confirm([GREETING, READ_PUSH, owner("yes"), reRead, owner("no, don't")], 0, "yes").confirmed).toBe(
      false,
    );
  });

  it("is strict about a change of mind: 'no... okay, yes' is not an approval", () => {
    const reRead = agent("Just to confirm: git push origin main via Bash?");
    expect(
      confirm([GREETING, READ_PUSH, owner("no"), reRead, owner("okay yes")], 0, "okay yes").confirmed,
    ).toBe(false);
  });

  it("needs the owner's last words about the ask to be a yes", () => {
    const reRead = agent("Just to confirm: git push origin main via Bash?");
    expect(confirm([GREETING, READ_PUSH, owner("yes"), reRead, owner("hmm")], 0, "yes").confirmed).toBe(
      false,
    );
    expect(confirm([GREETING, READ_PUSH, owner("yes"), reRead], 0, "yes").confirmed).toBe(false);
    expect(
      confirm([GREETING, READ_PUSH, owner("what?"), reRead, owner("yes, push it")], 0, "yes push it")
        .confirmed,
    ).toBe(true);
  });

  it("takes a refusal from the owner's words whatever else was said", () => {
    const deny = { type: "deny" } as never;
    expect(confirm([GREETING, READ_PUSH, owner("no"), owner("okay yes")], 0, "no", deny).confirmed).toBe(
      true,
    );
  });

  it.each(["never mind", "actually, pin the older one", "no, cancel that"])(
    "a free-text answer taken back with %j is not confirmed",
    (later) => {
      const transcript = [
        GREETING,
        agent("Claude asks: pin the older ONNX version or skip Windows?"),
        owner("skip windows"),
        owner(later),
      ];
      const result = confirmVoiceDecision({
        transcript,
        asks: [QUESTION],
        index: 0,
        decision: { type: "text", text: "skip windows" },
        ownerWords: "skip windows",
      });
      expect(result).toEqual({ confirmed: false, reason: "the owner took the answer back" });
    },
  );

  it.each([
    "Okay, I wouldn't do that",
    "sure, I can't let it",
    "yes, I shouldn't say",
    "ok it won't hurt",
    "yes isn't it",
    "yes didn't",
    "yes doesn't",
    "yes couldn't",
    "yes haven't",
    "yes ain't",
    "okay, I wouldn’t",
    "sure, can‘t",
    "yes wonʼt",
    "yes isn`t",
    "yes didn´t",
    "yes don′t",
    "ok wouldnt",
    "ok cant",
    "ok wont",
    "ok shouldnt",
    "ok isnt",
    "ok didnt",
    "yes cannot",
    "yes, hang on",
    "okay hold on",
    "yes not yet",
    "yes, later",
    "negative, yes",
    "yes abort",
    "no way, yes",
    "yes dont do it",
  ])("%j is never a clear yes", (said) => {
    expect(soundsDoubtful(said)).toBe(true);
    expect(confirm([GREETING, READ_PUSH, owner(said)], 0, said).confirmed).toBe(false);
  });

  it.each(["yes go ahead", "sure", "okay push it", "yep, do it"])("%j sounds like a plain yes", (said) => {
    expect(soundsDoubtful(said)).toBe(false);
  });
});
