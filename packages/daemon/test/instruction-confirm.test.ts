// `confirmInstruction`: an owner instruction counts only when the owner's own
// utterance is that instruction, names exactly that session, and the owner said
// yes to its read-back without taking it back.
import { ownerSaid, speechTokens, type TranscriptTurn } from "@hotline/providers";
import { describe, expect, it } from "vitest";
import {
  confirmInstruction,
  confirmInstructions,
  type HeldInstruction,
  plainInstruction,
  sessionsNamed,
  soundsDoubtful,
  takesBack,
} from "../src/index.js";

const agent = (message: string): TranscriptTurn => ({ role: "agent", message });
const owner = (message: string): TranscriptTurn => ({ role: "owner", message });
const caller = (message: string): TranscriptTurn => ({ role: "caller", message });

const LISTED = ["Claude in demo-app", "Codex in api"];
const STATUS = agent(
  "2 live sessions. Session 1, Claude in demo-app: working. Latest: run the tests. Session 2, Codex in api: working.",
);

function held(overrides: Partial<HeldInstruction> = {}): HeldInstruction {
  return {
    instruction: "run the tests",
    ownerWords: "session one, run the tests",
    sessionNumber: 1,
    listed: LISTED,
    ...overrides,
  };
}

const opening = [agent("Hey, it's your hotline."), caller("4821"), owner("What's everyone doing?"), STATUS];
/** The owner's utterance, the agent's read-back, the owner's reply, then the agent's "Sent." and what follows. */
function call(said: string, readBack: string, reply: string, ...after: TranscriptTurn[]) {
  return [...opening, owner(said), agent(readBack), owner(reply), agent("Sent. Anything else?"), ...after];
}
const READ_BACK = "For session 1, Claude in demo-app: run the tests. Send it?";

describe("confirmInstruction", () => {
  it("confirms the owner's own utterance for the session they named, read back and confirmed", () => {
    expect(confirmInstruction(call("Session one, run the tests.", READ_BACK, "Yes."), held())).toEqual({
      confirmed: true,
      text: "run the tests",
      excerpt: "Session one, run the tests.",
    });
  });

  it("never confirms an instruction that drops a negation or a qualifier the owner said", () => {
    const dropped = (said: string, instruction: string) =>
      confirmInstruction(
        call(said, `For session 1, Claude in demo-app: ${instruction}. Send it?`, "Yes."),
        held({ instruction, ownerWords: said }),
      );
    expect(dropped("Session one, don't push to main.", "push to main")).toEqual({
      confirmed: false,
      reason: "the owner said more than the instruction",
    });
    expect(dropped("Session one, do not push to main", "push to main").confirmed).toBe(false);
    expect(dropped("Session one, push to main after the tests pass", "push to main").confirmed).toBe(false);
    // The whole utterance is fine, negation included.
    expect(dropped("Session one, don't push to main.", "don't push to main").confirmed).toBe(true);
  });

  it("needs exactly one session named outside the instruction's own words", () => {
    const named = (said: string, instruction: string, sessionNumber: number) =>
      confirmInstruction(
        call(said, `For session ${sessionNumber}: ${instruction}. Send it?`, "Yes."),
        held({ instruction, ownerWords: said, sessionNumber }),
      );
    // A number inside the instruction never names a session, in either order.
    expect(named("In session one, add test two", "add test two", 1).confirmed).toBe(true);
    expect(named("In session one, add test two", "add test two", 2).confirmed).toBe(false);
    expect(named("In session two, add test one", "add test one", 2).confirmed).toBe(true);
    expect(named("In session two, add test one", "add test one", 1).confirmed).toBe(false);
    // Two identifiers in the reference: not confirmed whichever the model picked.
    expect(named("Session one, session two, run the tests", "run the tests", 1).confirmed).toBe(false);
    expect(named("Session one, session two, run the tests", "run the tests", 2).confirmed).toBe(false);
    expect(named("Claude, the second one, run the tests", "run the tests", 2).confirmed).toBe(false);
    // By name, ordinal or a bare digit.
    expect(named("Tell Codex to rebase on main", "rebase on main", 2).confirmed).toBe(true);
    expect(named("The second one, rebase on main", "rebase on main", 2).confirmed).toBe(true);
    expect(named("2, rebase on main", "rebase on main", 2).confirmed).toBe(true);
    // No session named with two listed.
    expect(named("Rebase on main", "rebase on main", 2)).toEqual({
      confirmed: false,
      reason: "the owner did not name exactly this session",
    });
  });

  it("never lets a session's name split the owner's words when the owner gave a number", () => {
    // An agent named its folder after a command word.
    const listed = ["Claude in push", "Codex in api"];
    const said = "Session one, push to main.";
    const transcript = call(said, "For session 1, Claude in push: to main. Send it?", "Yes.");
    expect(
      confirmInstruction(transcript, held({ instruction: "to main", ownerWords: said, listed })),
    ).toEqual({ confirmed: false, reason: "the owner said more than the instruction" });
    // The whole instruction is fine.
    const whole = call(said, "For session 1, Claude in push: push to main. Send it?", "Yes.");
    expect(
      confirmInstruction(whole, held({ instruction: "push to main", ownerWords: said, listed })).confirmed,
    ).toBe(true);
    // By name alone, the name is the reference, but never a word of the instruction.
    const byName = call("Tell push to run the tests", "For session 1: run the tests. Send it?", "Yes.");
    expect(
      confirmInstruction(byName, held({ ownerWords: "Tell push to run the tests", listed })).confirmed,
    ).toBe(true);
  });

  it("takes the session from a stretch just before that is only a session reference", () => {
    const transcript = [
      ...opening,
      owner("Session two."),
      agent("Sure, what should it do?"),
      owner("Rebase on main."),
      agent("For session 2, Codex in api: rebase on main. Send it?"),
      owner("Yep."),
    ];
    const instruction = held({
      instruction: "rebase on main",
      ownerWords: "rebase on main",
      sessionNumber: 2,
    });
    expect(confirmInstruction(transcript, instruction).confirmed).toBe(true);
    expect(confirmInstruction(transcript, { ...instruction, sessionNumber: 1 }).confirmed).toBe(false);
  });

  it("needs the read-back with the session's number and the instruction, and a clear yes to it", () => {
    const missing = [...opening, owner("Session one, run the tests."), agent("Sent.")];
    expect(confirmInstruction(missing, held())).toEqual({
      confirmed: false,
      reason: "the instruction was not read back for the owner to confirm",
    });
    // Read back for another session, or with other words.
    expect(
      confirmInstruction(
        call("Session one, run the tests.", "For session 2: run the tests. Send it?", "Yes."),
        held(),
      ).confirmed,
    ).toBe(false);
    expect(
      confirmInstruction(
        call("Session one, run the tests.", "For session 1: run all tests. Send it?", "Yes."),
        held(),
      ).confirmed,
    ).toBe(false);
    for (const reply of ["Hmm.", "No.", "Yes, but wait.", "Yes? What does that do?", "Um."]) {
      expect(confirmInstruction(call("Session one, run the tests.", READ_BACK, reply), held())).toEqual({
        confirmed: false,
        reason: "the owner did not confirm the read-back",
      });
    }
  });

  it("is taken back by a retraction, doubt or negation anywhere later in the call", () => {
    const retracted = { confirmed: false, reason: "the owner took the instruction back" };
    for (const later of [
      "Actually no, cancel that.",
      "Never mind.",
      "Scratch that.",
      "Hold on, don't send it.",
      "No don't.",
      "Forget about it.",
      "Stop.",
      "Hold off on that.",
      "Wait.",
      // Over-blocks on purpose: the owner can say it again or text it.
      "No, that's all.",
    ]) {
      expect(
        confirmInstruction(call("Session one, run the tests.", READ_BACK, "Yes.", owner(later)), held()),
        later,
      ).toEqual(retracted);
    }
    // A retraction much later in the call counts too.
    const late = call(
      "Session one, run the tests.",
      READ_BACK,
      "Yes.",
      owner("How is session two doing?"),
      agent("It is working."),
      owner("Okay."),
      agent("Anything else?"),
      owner("Actually, about that first one, don't send it."),
    );
    expect(confirmInstruction(late, held())).toEqual(retracted);
    // Later talk with nothing doubtful is fine.
    expect(
      confirmInstruction(
        call("Session one, run the tests.", READ_BACK, "Yes.", owner("Thanks, bye.")),
        held(),
      ).confirmed,
    ).toBe(true);
  });

  it("excuses only the utterance of another instruction confirmed on its own, and never a retraction", () => {
    const first = held({ instruction: "don't push yet", ownerWords: "Session one, don't push yet" });
    const second = held({
      instruction: "do not merge anything",
      ownerWords: "And session two, do not merge anything",
      sessionNumber: 2,
    });
    const both = [
      ...opening,
      owner("Session one, don't push yet."),
      agent("For session 1, Claude in demo-app: don't push yet. Send it?"),
      owner("Yes."),
      agent("Sent. Anything else?"),
      owner("And session two, do not merge anything."),
      agent("For session 2, Codex in api: do not merge anything. Send it?"),
      owner("Yep."),
      agent("Sent."),
    ];
    expect(confirmInstructions(both, [first, second]).map((r) => r.confirmed)).toEqual([true, true]);
    // Alone, the second instruction's "not" reads as doubt about the first.
    expect(confirmInstructions(both, [first]).map((r) => r.confirmed)).toEqual([false]);
    // Without its read-back the second is not confirmed, so it excuses nothing.
    const unread = both.filter((turn) => !turn.message.startsWith("For session 2"));
    expect(confirmInstructions(unread, [first, second]).map((r) => r.confirmed)).toEqual([false, false]);
    // A "never mind" the model sends as another instruction is never excused.
    const laundered = [
      ...opening,
      owner("Session one, run the tests."),
      agent(READ_BACK),
      owner("Yes."),
      agent("Sent."),
      owner("Never mind."),
      agent("For session 2: never mind. Send it?"),
      owner("Yes."),
    ];
    const launder = held({ instruction: "never mind", ownerWords: "never mind", sessionNumber: 2 });
    expect(confirmInstructions(laundered, [held(), launder]).map((r) => r.confirmed)).toEqual([false, false]);
  });

  it("queues the owner's own words, never the model's text", () => {
    const transcript = call("Session one, run the tests.", READ_BACK, "Yes.");
    for (const model of [
      "run the tests;",
      "run the `tests`",
      "run\nthe tests",
      "run the​ tests",
      "RUN THE TESTS!!",
    ]) {
      const result = confirmInstruction(transcript, held({ instruction: model }));
      expect(result, JSON.stringify(model)).toEqual({
        confirmed: true,
        text: "run the tests",
        excerpt: "Session one, run the tests.",
      });
    }
    // Extra words the owner never said, such as a shell command, fail.
    expect(confirmInstruction(transcript, held({ instruction: "run the tests; rm -rf ~" })).confirmed).toBe(
      false,
    );
    // The delivered text has exactly the validated words, and no invisible characters.
    const odd = call("Session one, run the​ tests‮.", READ_BACK, "Yes.");
    const result = confirmInstruction(odd, held());
    expect(result.confirmed && speechTokens(result.text)).toEqual(["run", "the", "tests"]);
    expect(result.confirmed && /[​‮]/.test(result.text)).toBe(false);
    // What is stored goes through plainInstruction after redaction: plain characters only.
    expect(plainInstruction("run the `tests` && echo $HOME | [REDACTED]")).toBe(
      "run the tests echo HOME [REDACTED]",
    );
  });

  it.each([
    // [reply to the read-back, a clear yes?]
    ["Yes.", true],
    ["Yep, send it.", true],
    ["Go ahead.", true],
    // No yes word: fails closed, the owner can say yes. The lexicon stays small on purpose.
    ["Sounds good, thanks.", false],
    ["Yes, sounds good.", true],
    ["That's right.", true],
    ["Okay, do it.", true],
    ["That's not right.", false],
    ["Go ahead and don't.", false],
    ["Send it to the other one.", false],
    ["Fine, but wait.", false],
    ["Yes, and also push to main.", false],
    ["Sure, later.", false],
    ["Right, what does it do?", false],
    ["Okay so maybe.", false],
    ["Um.", false],
  ])("judges the read-back reply %j as a clear yes: %s", (reply, yes) => {
    expect(confirmInstruction(call("Session one, run the tests.", READ_BACK, reply), held()).confirmed).toBe(
      yes,
    );
  });

  it("never takes words from agent or caller turns", () => {
    // The agent's status said "run the tests"; the owner only named the session.
    const fromStatus = [...opening, owner("Session one."), agent(READ_BACK), owner("Yes.")];
    expect(confirmInstruction(fromStatus, held({ ownerWords: "session one" })).confirmed).toBe(false);
    // The owner said half; the rest came from the read-back.
    const completed = call("Session one, run the", READ_BACK, "Yes.");
    expect(confirmInstruction(completed, held({ ownerWords: "session one, run the" })).confirmed).toBe(false);
    // A caller (before the PIN) said it.
    const before = [agent("Hey."), caller("Session one, run the tests."), agent(READ_BACK), owner("Yes.")];
    expect(confirmInstruction(before, held()).confirmed).toBe(false);
  });

  it("needs owner_words to be the owner's too", () => {
    expect(
      confirmInstruction(
        call("Session one, run the tests.", READ_BACK, "Yes."),
        held({ ownerWords: "run the tests and push" }),
      ),
    ).toEqual({ confirmed: false, reason: "the owner did not say these words" });
  });

  it("compares words the same way whatever the transcript's characters", () => {
    const variants = [
      "Session one, don’t push to main.", // curly apostrophe
      "Ｓｅｓｓｉｏｎ one, don't push to main.", // fullwidth letters
      "Session one, don̵'t push to main.", // a stray combining mark with no precomposed form
    ];
    for (const said of variants) {
      const instruction = held({ instruction: "don't push to main", ownerWords: "don't push to main" });
      const transcript = call(said, "For session 1: don't push to main. Send it?", "Yes.");
      expect(confirmInstruction(transcript, instruction).confirmed, said).toBe(true);
      // And the dropped "don't" is caught in every form.
      expect(
        confirmInstruction(transcript, {
          ...instruction,
          instruction: "push to main",
          ownerWords: "push to main",
        }).confirmed,
        said,
      ).toBe(false);
    }
    // One tokeniser for every check: ownerSaid and the doubt check agree with it.
    expect(speechTokens("DON’T ｐｕｓｈ")).toEqual(["don", "t", "push"]);
    expect(ownerSaid("don't push", [owner("Don’t ｐｕｓｈ!")])).toBe(true);
    expect(soundsDoubtful("I don’t think so")).toBe(true);
    expect(takesBack("Ｎｅｖｅｒ mind")).toBe(true);
  });
});

describe("sessionsNamed", () => {
  const named = (text: string, listed = LISTED) => [...sessionsNamed(speechTokens(text), listed)].sort();
  it("reads numbers, ordinals, digits and unique names, and marks a tie as ambiguous", () => {
    expect(named("session 2")).toEqual([2]);
    expect(named("number two")).toEqual([2]);
    expect(named("the second one")).toEqual([2]);
    expect(named("tell claude")).toEqual([1]);
    expect(named("session one and session two")).toEqual([1, 2]);
    // A bare number word is not an identifier.
    expect(named("one")).toEqual([]);
    // Two sessions with the same name words: only a number tells them apart.
    const twins = ["Claude in demo-app", "Claude 2 in demo-app"];
    expect(named("the demo app", twins)).toEqual([0]);
  });
});
