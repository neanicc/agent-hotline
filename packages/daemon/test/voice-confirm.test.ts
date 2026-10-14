import type { TranscriptTurn } from "@hotline/providers";
import { describe, expect, it } from "vitest";
import {
  answerWindows,
  confirmVoiceDecision,
  hasCasualYes,
  isAffirmative,
  MAX_REPLY_WORDS,
  REQUIRE_CASUAL_YES,
  type ReadAsk,
  readings,
  soundsDoubtful,
} from "../src/index.js";

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
/** The one-sentence read-back the persona says before an allow (definition v4). */
const BACK_PUSH = agent("Allow Bash to git push origin main for Claude in demo-app? Yes?");
const SORRY_PUSH = agent(
  "Sorry, is that a yes or a no? Allow Bash to git push origin main for Claude in demo-app? Yes?",
);
const BACK_INSTALL = agent("Allow Bash to npm install left-pad for Codex in api-server? Yes?");

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

  it("recognises a paraphrased reading that keeps most key words", () => {
    const paraphrase = agent("Codex in api-server wants to add left-pad with npm install. Okay?");
    expect(readings([GREETING, paraphrase], [PUSH, INSTALL])).toEqual([undefined, 1]);
  });

  it("recognises no ask in a reading that drops most key words, so nothing confirms", () => {
    const vague = agent("The other one is about a package. Okay?");
    const transcript = [GREETING, vague, owner("yes")];
    expect(readings(transcript, [PUSH, INSTALL])).toEqual([undefined, undefined, undefined]);
    for (const index of [0, 1]) {
      expect(
        confirmVoiceDecision({ transcript, asks: [PUSH, INSTALL], index, decision: allow, ownerWords: "yes" })
          .confirmed,
      ).toBe(false);
    }
  });

  it("reads none when one turn reads two different asks equally, so a yes confirms neither", () => {
    const both = agent("Two things: git push origin main, and npm install left-pad.");
    const transcript = [GREETING, both, owner("yes")];
    expect(readings(transcript, [PUSH, INSTALL])[1]).toBeUndefined();
    for (const index of [0, 1]) {
      expect(
        confirmVoiceDecision({ transcript, asks: [PUSH, INSTALL], index, decision: allow, ownerWords: "yes" })
          .confirmed,
      ).toBe(false);
    }
  });

  it("needs most of an ask's key words", () => {
    expect(readings([GREETING, agent("Claude has a question.")], [QUESTION])).toEqual([undefined, undefined]);
  });

  it("reads the ask a read-back names, not another ask from the same session it half matches", () => {
    const sameSession: ReadAsk = { text: "pnpm test", nickname: "Claude in demo-app", toolName: "Bash" };
    expect(readings([GREETING, BACK_PUSH], [sameSession, PUSH])).toEqual([undefined, 1]);
    // Two asks that differ only by tool: the read-back that names the tool reads that one.
    const read: ReadAsk = { text: "the deploy config", nickname: "Claude in demo-app", toolName: "Read" };
    const write: ReadAsk = { ...read, toolName: "Write" };
    const backs = [
      agent("Allow Read to the deploy config for Claude in demo-app? Yes?"),
      agent("Allow Write to the deploy config for Claude in demo-app? Yes?"),
    ];
    expect(readings([GREETING, ...backs], [read, write])).toEqual([undefined, 0, 1]);
  });
});

describe("readings of long asks", () => {
  const LONG: ReadAsk = {
    text: "Run the database migration for the billing service, then seed the staging tables with the anonymised fixtures and restart the worker pool",
    nickname: "Claude in demo-app",
    toolName: "Bash",
  };
  const OTHER_LONG: ReadAsk = {
    ...LONG,
    text: "Run the database migration for the billing service, then seed the staging tables from production snapshots and page the on-call engineer",
  };
  /** The same long text as a question: no command tokens to name. */
  const LONG_QUESTION: ReadAsk = { text: LONG.text, nickname: "Codex in api-server", kind: "question" };
  const SHORT_BACK = agent(
    "Allow Bash to run the billing migration and seed staging for Claude in demo-app? Yes?",
  );

  it("recognises a short read-back that names a few of a long ask's words", () => {
    // It names 8 of the ask's 17 key words, under half, but 4 of them come from the text.
    expect(readings([GREETING, SHORT_BACK], [LONG])).toEqual([undefined, 0]);
    // A long question next to another ask: four of its own words are enough.
    const question = agent("So, billing migration, seed staging, worker pool: which one?");
    expect(readings([GREETING, question], [PUSH, LONG_QUESTION])).toEqual([undefined, 1]);
  });

  it("next to another ask, a long permission request needs every command word the other lacks", () => {
    // The short read-back leaves out "anonymised", "fixtures", "restart", ...: it reads nothing.
    expect(readings([GREETING, SHORT_BACK], [PUSH, LONG])).toEqual([undefined, undefined]);
    const full = agent(`Allow Bash to ${LONG.text} for Claude in demo-app? Yes?`);
    expect(readings([GREETING, full], [PUSH, LONG])).toEqual([undefined, 1]);
  });

  it("never reads a long ask from its session name and tool alone, or from too few of its words", () => {
    const vague = agent("Claude in demo-app has another Bash request?");
    expect(readings([GREETING, vague], [LONG])).toEqual([undefined, undefined]);
    // Three of its text's key words are not enough.
    const three = agent("Allow the billing migration and seed?");
    expect(readings([GREETING, three], [LONG])).toEqual([undefined, undefined]);
  });

  it("reads none when a short read-back matches two long asks equally", () => {
    expect(readings([GREETING, SHORT_BACK], [LONG, OTHER_LONG])).toEqual([undefined, undefined]);
    // Naming everything only one of them has tells them apart.
    const named = agent(
      "Allow the billing migration, seed staging with the anonymised fixtures and restart the worker pool, for Claude in demo-app? Yes?",
    );
    expect(readings([GREETING, named], [LONG, OTHER_LONG])).toEqual([undefined, 0]);
    // One of its words is not enough.
    const one = agent(
      "Allow the billing migration, seed staging with the fixtures, for Claude in demo-app? Yes?",
    );
    expect(readings([GREETING, one], [LONG, OTHER_LONG])).toEqual([undefined, undefined]);
  });

  it("approves a long ask after its short read-back", () => {
    const reading = agent(`Claude in demo-app wants to use Bash: ${LONG.text}. Okay?`);
    const transcript = [GREETING, reading, owner("sure"), SHORT_BACK, owner("yep, do it")];
    expect(
      confirmVoiceDecision({ transcript, asks: [LONG], index: 0, decision: allow, ownerWords: "yep do it" }),
    ).toEqual({ confirmed: true, excerpt: "yep, do it" });
  });
});

describe("strict, unique attribution between asks", () => {
  // An agent-written ask that shares another's words must never take over its reading.
  const TESTS: ReadAsk = { text: "pnpm test", nickname: "Claude in demo-app", toolName: "Bash" };
  const TESTS_AND_PUSH: ReadAsk = { ...TESTS, text: "pnpm test; also git push --force" };
  const READ_TESTS = agent("Claude in demo-app wants to use Bash: pnpm test. Okay?");
  const BACK_TESTS = agent("Allow Bash to pnpm test for Claude in demo-app? Yes?");
  const BACK_BOTH = agent("Allow Bash to pnpm test; also git push --force for Claude in demo-app? Yes?");

  it.each([
    ["the plain ask first", [TESTS, TESTS_AND_PUSH]],
    ["the longer ask first", [TESTS_AND_PUSH, TESTS]],
  ])("reads nothing when one ask contains another (%s)", (_, asks) => {
    for (const turn of [READ_TESTS, BACK_TESTS, BACK_BOTH]) {
      expect(readings([GREETING, turn], asks)).toEqual([undefined, undefined]);
    }
    // So no yes after any of them approves either ask.
    const transcript = [GREETING, READ_TESTS, owner("sure"), BACK_TESTS, owner("yes")];
    for (const index of [0, 1]) {
      expect(
        confirmVoiceDecision({ transcript, asks, index, decision: allow, ownerWords: "yes" }).confirmed,
      ).toBe(false);
    }
  });

  it.each([
    ["first", 0],
    ["second", 1],
  ])("never lets a read-back of the plain ask approve the forced push (it is %s)", (_, at) => {
    const push: ReadAsk = { ...TESTS, text: "git push --force" };
    const asks = at === 0 ? [push, TESTS] : [TESTS, push];
    const transcript = [GREETING, READ_TESTS, owner("sure"), BACK_TESTS, owner("yes")];
    expect(readings(transcript, asks)).toEqual([undefined, 1 - at, undefined, 1 - at, undefined]);
    expect(
      confirmVoiceDecision({ transcript, asks, index: at, decision: allow, ownerWords: "yes" }).confirmed,
    ).toBe(false);
  });

  it("needs every command token that tells the asks apart, short ones included", () => {
    const push: ReadAsk = { ...TESTS, text: "git push" };
    const force: ReadAsk = { ...TESTS, text: "git push -f" };
    // "f" is the only difference; a read-back without it reads nothing, and "git push" itself is contained.
    expect(
      readings([GREETING, agent("Allow Bash to git push -f for Claude in demo-app? Yes?")], [push, force]),
    ).toEqual([undefined, undefined]);
    const rm: ReadAsk = { ...TESTS, text: "rm -rf build" };
    const ls: ReadAsk = { ...TESTS, text: "ls build" };
    expect(
      readings([GREETING, agent("Allow Bash to rm -rf build for Claude in demo-app? Yes?")], [rm, ls]),
    ).toEqual([undefined, 0]);
    expect(
      readings([GREETING, agent("Allow Bash to remove build for Claude in demo-app? Yes?")], [rm, ls]),
    ).toEqual([undefined, undefined]);
  });

  it("needs every key word that tells the asks apart, the session name included", () => {
    // PUSH and INSTALL come from different sessions: a read-back must name the session too.
    const noName = agent("Allow git push origin main? Yes?");
    expect(readings([GREETING, noName], [PUSH, INSTALL])).toEqual([undefined, undefined]);
    // Alone on a call there is nothing to tell apart, so the share rule alone applies.
    expect(readings([GREETING, noName], [PUSH])).toEqual([undefined, 0]);
  });

  it("reads nothing from identical asks", () => {
    const transcript = [GREETING, READ_TESTS, owner("sure"), BACK_TESTS, owner("yes")];
    expect(readings(transcript, [TESTS, { ...TESTS }])).toEqual(transcript.map(() => undefined));
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

  it("confirms the owner's reply to the read-back and returns their turns as the excerpt", () => {
    const transcript = [
      GREETING,
      READ_PUSH,
      owner("sure"),
      BACK_PUSH,
      owner("Yes, push it."),
      agent("Got it."),
    ];
    expect(confirm(transcript, 0, "yes push it")).toEqual({ confirmed: true, excerpt: "Yes, push it." });
  });

  it("joins consecutive owner turns", () => {
    const transcript = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner("yes"), owner("push it")];
    expect(confirm(transcript, 0, "yes push it")).toEqual({ confirmed: true, excerpt: "yes push it" });
  });

  it("never takes an early yes", () => {
    const transcript = [GREETING, owner("yes, I can hear you"), READ_PUSH, agent("Okay?")];
    expect(confirm(transcript, 0, "yes")).toEqual({
      confirmed: false,
      reason: "the request was not read back for a yes",
    });
    // Not even when a read-back follows that the owner did not answer.
    const unanswered = [GREETING, owner("yes, I can hear you"), READ_PUSH, owner("hmm"), BACK_PUSH];
    expect(confirm(unanswered, 0, "yes")).toEqual({
      confirmed: false,
      reason: "the owner did not say these words in reply to the read-back",
    });
  });

  it("never takes a yes said after a different ask was read", () => {
    const transcript = [
      GREETING,
      READ_PUSH,
      owner("no"),
      READ_INSTALL,
      owner("sure"),
      BACK_INSTALL,
      owner("yes"),
    ];
    expect(confirm(transcript, 0, "yes").confirmed).toBe(false);
    expect(confirm(transcript, 1, "yes").confirmed).toBe(true);
    expect(confirm(transcript, 0, "no", { type: "deny" } as never).confirmed).toBe(true);
  });

  it.each([
    "of course",
    "absolutely",
    "do it",
    "go for it",
    "send it",
    "for sure",
    "yeah go ahead",
    "mm-hmm",
    "uh-huh",
    "you bet",
    "sounds good",
    "please do",
    "Yes.",
  ])("approves %j after the read-back, with no yes word needed", (said) => {
    const transcript = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said), agent("Got it.")];
    expect(confirm(transcript, 0, said)).toEqual({ confirmed: true, excerpt: said });
  });

  it.each(["of course", "absolutely", "do it", "go for it", "yes"])(
    "does not approve %j without a read-back",
    (said) => {
      const transcript = [GREETING, READ_PUSH, owner(said), agent("Got it.")];
      expect(confirm(transcript, 0, said)).toEqual({
        confirmed: false,
        reason: "the request was not read back for a yes",
      });
    },
  );

  it("does not approve when the owner takes the reply to the read-back back", () => {
    const transcript = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner("of course"), owner("wait")];
    expect(confirm(transcript, 0, "of course")).toEqual({
      confirmed: false,
      reason: "the owner's reply to the read-back is not a clear yes",
    });
    // Also when the doubt comes after a later reading of the same ask.
    const later = [
      GREETING,
      READ_PUSH,
      owner("sure"),
      BACK_PUSH,
      owner("of course"),
      READ_PUSH,
      owner("hold on"),
    ];
    expect(confirm(later, 0, "of course").confirmed).toBe(false);
  });

  it.each(["what does that do?", "what does that do", "sure, why?", "okay, which branch"])(
    "does not take a question back (%j) as a reply to the read-back",
    (said) => {
      const transcript = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said)];
      expect(confirm(transcript, 0, said).confirmed).toBe(false);
    },
  );

  it("never takes a read-back of a different ask as this one's", () => {
    const transcript = [
      GREETING,
      READ_PUSH,
      owner("sure"),
      READ_INSTALL,
      owner("okay"),
      BACK_INSTALL,
      owner("yes"),
    ];
    expect(confirm(transcript, 0, "yes").confirmed).toBe(false);
    expect(confirm(transcript, 1, "yes").confirmed).toBe(true);
    // A read-back of an ask that was never read first is not a read-back either.
    const unread = [GREETING, READ_PUSH, owner("sure"), BACK_INSTALL, owner("yes")];
    expect(confirm(unread, 0, "yes").confirmed).toBe(false);
    expect(confirm(unread, 1, "yes").confirmed).toBe(false);
  });

  it("never counts the first reading as its own read-back", () => {
    expect(confirm([GREETING, BACK_PUSH, owner("yes")], 0, "yes")).toEqual({
      confirmed: false,
      reason: "the request was not read back for a yes",
    });
  });

  it("needs the read-back to ask for a yes: a statement repeating the request is not one", () => {
    const statement = agent("Okay, Claude in demo-app will git push origin main with Bash.");
    const transcript = [GREETING, READ_PUSH, owner("sure"), statement, owner("great")];
    expect(confirm(transcript, 0, "great").confirmed).toBe(false);
  });

  it("approves a clear reply to 'is that a yes or a no?' after a hesitation", () => {
    const transcript = [
      GREETING,
      READ_PUSH,
      owner("hmm"),
      SORRY_PUSH,
      owner("yeah go ahead"),
      agent("Got it."),
    ];
    expect(confirm(transcript, 0, "yeah go ahead")).toEqual({ confirmed: true, excerpt: "yeah go ahead" });
    // A second read-back after an unclear reply to the first: the doubt came before the one answered.
    const twice = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner("hmm"), SORRY_PUSH, owner("yes")];
    expect(confirm(twice, 0, "yes").confirmed).toBe(true);
  });

  it("goes back to an earlier ask with a read-back after answering another", () => {
    const transcript = [
      GREETING,
      READ_PUSH,
      READ_INSTALL,
      owner("no"),
      agent("Got it."),
      BACK_PUSH,
      owner("yes"),
    ];
    expect(confirm(transcript, 0, "yes").confirmed).toBe(true);
    expect(confirm(transcript, 1, "no", { type: "deny" } as never).confirmed).toBe(true);
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
      const transcript = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said)];
      expect(confirm(transcript, 0, "yes").confirmed).toBe(false);
    },
  );

  it("needs no yes word after a read-back, but a hedge still blocks", () => {
    const after = (said: string) => [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said)];
    expect(confirm(after("whatever you think"), 0, "whatever you think").confirmed).toBe(false);
    expect(confirm(after("whatever"), 0, "whatever").confirmed).toBe(false);
    expect(confirm(after("sure, go ahead"), 0, "go ahead").confirmed).toBe(true);
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
    const backed = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner("yes")];
    expect(confirm([...backed, owner("no")], 0, "yes").confirmed).toBe(false);
    expect(confirm([...backed, owner("wait")], 0, "yes").confirmed).toBe(false);
    const reRead = agent("Just to confirm: git push origin main via Bash for Claude in demo-app?");
    expect(confirm([...backed, reRead, owner("no, don't")], 0, "yes").confirmed).toBe(false);
  });

  it("lets a question before the yes stand, but a question after it takes the yes back", () => {
    const reRead = agent("Just to confirm: git push origin main via Bash for Claude in demo-app?");
    expect(
      confirm(
        [GREETING, READ_PUSH, owner("what does it push?"), reRead, owner("yes, push it")],
        0,
        "yes push it",
      ).confirmed,
    ).toBe(true);
    const asked = [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner("yes"), owner("what does it push")];
    expect(confirm(asked, 0, "yes").confirmed).toBe(false);
  });

  it("counts doubt only from the read-back on: 'no', a read-back, then 'okay yes' approves", () => {
    const reRead = agent("Just to confirm: git push origin main via Bash for Claude in demo-app?");
    expect(
      confirm([GREETING, READ_PUSH, owner("no"), reRead, owner("okay yes")], 0, "okay yes").confirmed,
    ).toBe(true);
    // Without the read-back the same words approve nothing, and doubt after it still blocks.
    expect(confirm([GREETING, READ_PUSH, owner("no"), owner("okay yes")], 0, "okay yes").confirmed).toBe(
      false,
    );
    const after = [GREETING, READ_PUSH, owner("sure"), reRead, owner("okay yes"), owner("no")];
    expect(confirm(after, 0, "okay yes").confirmed).toBe(false);
  });

  it("doubt after the read-back blocks, and a read-back with no reply approves nothing", () => {
    const reRead = agent("Just to confirm: git push origin main via Bash for Claude in demo-app?");
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
    "hmm",
    "hm, okay",
    "huh",
    "whatever",
    "uh uh",
    "nuh uh",
  ])("%j is never a clear yes", (said) => {
    expect(soundsDoubtful(said)).toBe(true);
    expect(confirm([GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said)], 0, said).confirmed).toBe(
      false,
    );
  });

  it.each([
    "yes go ahead",
    "sure",
    "okay push it",
    "yep, do it",
    "of course",
    "mm-hmm",
    "uh-huh",
    "for sure",
  ])("%j sounds like a plain yes", (said) => {
    expect(soundsDoubtful(said)).toBe(false);
  });

  it.each([
    "I cannot approve this",
    "I'm unsure whether to approve this",
    "yes if the tests pass",
    "I think so, yes",
    "probably okay",
    "hmm, okay",
    "okay, what does it do",
    "okay, what does it do?",
    "fine, skip it",
    "go ahead and decline it",
    "I'd rather you didn't",
    "allow? why",
    "pass on that one, okay",
    "sure, which one is it",
  ])("refusals and hedges such as %j never approve", (said) => {
    expect(confirm([GREETING, READ_PUSH, owner(said)], 0, said).confirmed).toBe(false);
    expect(confirm([GREETING, READ_PUSH, owner("sure"), BACK_PUSH, owner(said)], 0, said).confirmed).toBe(
      false,
    );
  });
});

describe("confirmVoiceDecision for options and done", () => {
  const ask: ReadAsk = { ...QUESTION, options: ["Pin the older version", "Skip Windows"] };
  const reading = agent(
    "Claude in demo-app asks: pin the older ONNX version or skip Windows? Option 1, pin; option 2, skip.",
  );
  const option = (said: string, chosen: number) =>
    confirmVoiceDecision({
      transcript: [GREETING, reading, owner(said)],
      asks: [ask],
      index: 0,
      decision: { type: "option", option: chosen },
      ownerWords: said,
    }).confirmed;

  it.each([
    ["option two", 2],
    ["the second one", 2],
    ["2", 2],
    ["skip windows", 2],
    ["the first", 1],
    ["option one please", 1],
    ["pin the older version", 1],
  ])("%j confirms option %i", (said, chosen) => {
    expect(option(said, chosen)).toBe(true);
  });

  it.each([
    ["option two", 1],
    ["the second one", 1],
    ["skip windows", 1],
    ["not the first, the second", 1],
    ["not the first, the second", 2],
    ["whichever", 1],
  ])("%j does not confirm option %i", (said, chosen) => {
    expect(option(said, chosen)).toBe(false);
  });

  it("needs a word for done", () => {
    const stop: ReadAsk = { text: "Finished the migration. What next?", nickname: "Codex in api-server" };
    const done = (said: string) =>
      confirmVoiceDecision({
        transcript: [GREETING, agent("Codex in api-server finished the migration. What next?"), owner(said)],
        asks: [stop],
        index: 0,
        decision: { type: "done" },
        ownerWords: said,
      }).confirmed;
    expect(done("that's it for today")).toBe(true);
    expect(done("nothing, thanks")).toBe(true);
    expect(done("now write the tests")).toBe(false);
  });
});

describe("noise in reply to a read-back is never a yes", () => {
  const reply = (...said: string[]) =>
    confirmVoiceDecision({
      transcript: [GREETING, READ_PUSH, owner("sure"), BACK_PUSH, ...said.map(owner), agent("Got it.")],
      asks: [PUSH, INSTALL],
      index: 0,
      decision: allow,
      ownerWords: said.join(" "),
    });

  it.each(["um", "uh", "hmm", "er", "mm", "um, uh", "Mm, hmm.", "oh"])("rejects the filler %j", (said) => {
    expect(reply(said).confirmed).toBe(false);
  });

  it.each(["[inaudible]", "(noise)", "<unk>", "yes [inaudible]", "[laughs] sure"])(
    "rejects a reply with the transcriber's marker %j",
    (said) => {
      expect(reply(said)).toEqual({
        confirmed: false,
        reason: "the owner's reply to the read-back was not made out",
      });
    },
  );

  it("rejects an empty reply", () => {
    expect(reply("").confirmed).toBe(false);
    expect(reply("   ").confirmed).toBe(false);
  });

  it(`rejects a reply longer than ${MAX_REPLY_WORDS} words`, () => {
    expect(reply("yeah sure go ahead and push it to main now")).toEqual({
      confirmed: false,
      reason: "the owner's reply to the read-back is too long to be a clear yes",
    });
    expect(reply("yeah sure go ahead and push it now").confirmed).toBe(true);
  });

  it.each(["git push origin main", "Claude in demo-app", "push", "allow bash to git push"])(
    "rejects a reply that only repeats the read-back: %j",
    (said) => {
      expect(reply(said)).toEqual({ confirmed: false, reason: "the owner only repeated the read-back" });
    },
  );

  it.each(["yes, push it", "yes", "okay, git push origin main"])(
    "takes %j, which says more than the read-back",
    (said) => {
      expect(reply(said).confirmed).toBe(true);
    },
  );

  it("takes unrelated chatter while a casual yes is not required (open decision for the owner)", () => {
    // REQUIRE_CASUAL_YES is off: only the negative checks apply, as the owner directed.
    expect(REQUIRE_CASUAL_YES).toBe(false);
    expect(reply("the dog is barking").confirmed).toBe(true);
  });
});

describe("isAffirmative: the one switch for requiring a casual yes", () => {
  const NATURAL = [
    "of course",
    "absolutely",
    "do it",
    "go for it",
    "send it",
    "for sure",
    "yeah go ahead",
    "mm-hmm",
    "uh-huh",
    "mhm",
    "you bet",
    "sounds good",
    "please do",
    "yep",
    "ok",
  ];
  const CHATTER = ["the dog is barking", "I'm driving", "in a meeting", "the kids are home"];

  it.each([...NATURAL, ...CHATTER])("accepts %j today, when only the negative checks apply", (said) => {
    expect(isAffirmative(said)).toBe(true);
  });

  it.each(NATURAL)("with a casual yes required, still accepts %j", (said) => {
    expect(hasCasualYes(said)).toBe(true);
    expect(isAffirmative(said, true)).toBe(true);
  });

  it.each(CHATTER)("with a casual yes required, rejects %j", (said) => {
    expect(hasCasualYes(said)).toBe(false);
    expect(isAffirmative(said, false)).toBe(true);
    expect(isAffirmative(said, true)).toBe(false);
  });

  it("does not take a bare hmm or huh as the yes sound", () => {
    expect(hasCasualYes("hmm")).toBe(false);
    expect(hasCasualYes("huh")).toBe(false);
    expect(soundsDoubtful("mm, hmm")).toBe(true);
    expect(soundsDoubtful("mm-hmm")).toBe(false);
  });
});
