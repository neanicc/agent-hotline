// `confirmInstruction`: an owner instruction counts only when the owner's own
// turns back it, name the session, and do not take it back.
import type { TranscriptTurn } from "@hotline/providers";
import { describe, expect, it } from "vitest";
import { confirmInstruction, type HeldInstruction, namesSession } from "../src/index.js";

const agent = (message: string): TranscriptTurn => ({ role: "agent", message });
const owner = (message: string): TranscriptTurn => ({ role: "owner", message });
const caller = (message: string): TranscriptTurn => ({ role: "caller", message });

const LISTED = ["Claude in demo-app", "Codex in api"];
const STATUS = agent(
  "2 live sessions. Session 1, Claude in demo-app: working. Session 2, Codex in api: working.",
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

const call = (...turns: TranscriptTurn[]) => [
  agent("Hey, it's your hotline."),
  caller("4821"),
  owner("What's everyone doing?"),
  STATUS,
  ...turns,
];

describe("confirmInstruction", () => {
  it("confirms the owner's own words for the session they named, with their turn as the excerpt", () => {
    const result = confirmInstruction(
      call(owner("Session one, run the tests."), agent("Session 1: run the tests. Passing that on.")),
      held(),
    );
    expect(result).toEqual({ confirmed: true, excerpt: "Session one, run the tests." });
  });

  it("accepts the session named just before the instruction, by number or by name", () => {
    const named = (first: string, number = 1) =>
      confirmInstruction(
        call(
          owner(first),
          agent("Sure, what should it do?"),
          owner("Run the tests."),
          agent("Passing that on."),
        ),
        held({ ownerWords: "run the tests", sessionNumber: number }),
      );
    expect(named("Session one").confirmed).toBe(true);
    expect(named("The first one").confirmed).toBe(true);
    expect(named("The demo app one").confirmed).toBe(true);
    expect(named("Codex", 2).confirmed).toBe(true);
    // Named session 2, the model sent it to session 1.
    expect(named("Session two")).toEqual({ confirmed: false, reason: "the owner did not name this session" });
  });

  it("never confirms a paraphrase or words only the model or a caller said", () => {
    const transcript = call(owner("Session one, run the tests."), agent("Passing that on."));
    expect(confirmInstruction(transcript, held({ instruction: "run the full test suite" }))).toEqual({
      confirmed: false,
      reason: "the instruction is not the owner's own words",
    });
    // Before the PIN every turn is the caller's.
    const unverified = [agent("Hey, it's your hotline."), caller("Session one, run the tests.")];
    expect(confirmInstruction(unverified, held()).confirmed).toBe(false);
    // The agent's own read-back never counts as the owner's words.
    const agentOnly = call(owner("Session one"), agent("Session 1: push to main."));
    expect(
      confirmInstruction(agentOnly, held({ instruction: "push to main", ownerWords: "push to main" }))
        .confirmed,
    ).toBe(false);
  });

  it("needs owner_words to be the owner's too", () => {
    const transcript = call(owner("Session one, run the tests."), agent("Passing that on."));
    expect(
      confirmInstruction(transcript, held({ ownerWords: "session one, run the tests and push" })),
    ).toEqual({
      confirmed: false,
      reason: "the owner did not say these words",
    });
  });

  it("is taken back by doubt after it, up to the owner's reply to the read-back", () => {
    for (const reply of ["No wait, never mind.", "Actually, cancel that.", "Hold on."]) {
      const transcript = call(
        owner("Session one, run the tests."),
        agent("Session 1: run the tests?"),
        owner(reply),
      );
      expect(confirmInstruction(transcript, held())).toEqual({
        confirmed: false,
        reason: "the owner took the instruction back",
      });
    }
    // Later talk ("no, that's all") is past the read-back and does not count.
    const later = call(
      owner("Session one, run the tests."),
      agent("Session 1: run the tests. Passing that on."),
      owner("Thanks."),
      agent("Anything else?"),
      owner("No, that's all."),
    );
    expect(confirmInstruction(later, held()).confirmed).toBe(true);
  });

  it("keeps a negative instruction, and a second instruction is not a take-back of the first", () => {
    const transcript = call(
      owner("Session one, don't push yet."),
      agent("Session 1: don't push yet."),
      owner("And session two, do not merge anything."),
      agent("Session 2: do not merge anything."),
    );
    const first = held({ instruction: "don't push yet", ownerWords: "Session one, don't push yet" });
    const second = held({
      instruction: "do not merge anything",
      ownerWords: "session two, do not merge anything",
      sessionNumber: 2,
    });
    expect(
      confirmInstruction(transcript, { ...first, otherInstructions: [second.instruction] }).confirmed,
    ).toBe(true);
    expect(
      confirmInstruction(transcript, { ...second, otherInstructions: [first.instruction] }).confirmed,
    ).toBe(true);
    // Without knowing the second instruction, its "not" would read as doubt.
    expect(confirmInstruction(transcript, first).confirmed).toBe(false);
  });
});

describe("namesSession", () => {
  const said = (text: string) => text.toLowerCase().split(/\W+/);
  it("takes a number, an ordinal, a number word, or the best unique name match", () => {
    expect(namesSession(said("session 2"), 2, LISTED)).toBe(true);
    expect(namesSession(said("the second one"), 2, LISTED)).toBe(true);
    expect(namesSession(said("tell claude"), 1, LISTED)).toBe(true);
    expect(namesSession(said("tell claude"), 2, LISTED)).toBe(false);
    // Two sessions with the same name words: only a number tells them apart.
    const twins = ["Claude in demo-app", "Claude in demo-app 2"];
    expect(namesSession(said("the demo app"), 1, twins)).toBe(false);
    expect(namesSession(said("session one"), 1, twins)).toBe(true);
    // With one session listed, that is the one.
    expect(namesSession(said("run the tests"), 1, ["Claude in demo-app"])).toBe(true);
  });
});
