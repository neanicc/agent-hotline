// Fuzz tests for the voice reply fast path (HL-13): `replyVerdict` decides a
// reply to a read-back at once only when it is a clear yes or no. A reply that
// holds any refusal, negation, condition or hedge is never "agreed", and random
// replies are agreed only when they are made of plain yes words.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkedVerdict, replyVerdict, soundsDoubtful } from "../src/index.js";

const READ_BACK = "Allow pnpm test in demo-app? Yes?";
const ASK_WORDS = new Set(["pnpm", "test", "demo", "app"]);
const verdict = (reply: readonly string[]) => replyVerdict(reply, READ_BACK, ASK_WORDS);

const YES = [
  "yes",
  "yeah",
  "yep",
  "sure",
  "okay",
  "ok",
  "go ahead",
  "do it",
  "of course",
  "absolutely",
  "mm-hmm",
  "uh-huh",
];
const DOUBT = [
  "if the tests pass",
  "but not on main",
  "unless it deletes things",
  "maybe",
  "probably",
  "I think",
  "I guess",
  "wait",
  "hold on",
  "no",
  "not yet",
  "don't",
  "never mind",
  "actually",
  "hmm",
  "huh",
  "what does it do",
  "why",
  "later",
  "I'm not sure",
  "I wouldn't",
  "can't",
  "skip it",
  "decline it",
  "nope",
  "I'd rather not",
];
const FILLER = ["um", "uh", "er", "oh", "well", "so", "and", "then", "please", "now", "right", ""];

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

describe("voice reply fast path fuzzing", { timeout: 60_000 }, () => {
  it("never agrees with a reply that holds a refusal, negation, condition or hedge", () => {
    const reply = fc
      .tuple(
        fc.array(fc.constantFrom(...YES, ...FILLER), { maxLength: 3 }),
        fc.constantFrom(...DOUBT),
        fc.array(fc.constantFrom(...YES, ...FILLER), { maxLength: 3 }),
        fc.constantFrom(" ", ", ", ". ", "? ", "! ", " - "),
        fc.boolean(),
      )
      .map(([before, doubt, after, joint, split]) => {
        const text = [...before, doubt, ...after].filter((part) => part !== "").join(joint);
        // As one turn, or as the owner's separate turns.
        return split ? [...before, doubt, ...after].filter((part) => part !== "") : [text];
      });
    fc.assert(
      fc.property(reply, (turns) => {
        expect(verdict(turns), JSON.stringify(turns)).not.toBe("agreed");
      }),
      { numRuns: 4000 },
    );
  });

  it("agrees with a random reply only when it is plain yes words, with no doubt marker", () => {
    const reply = fc.array(
      fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.string({ unit: "grapheme", maxLength: 12 }),
        fc
          .array(fc.constantFrom(...YES, ...DOUBT, ...FILLER, "[inaudible]", "pnpm test", "allow", "?"), {
            maxLength: 5,
          })
          .map((parts) => parts.join(" ")),
      ),
      { minLength: 1, maxLength: 3 },
    );
    fc.assert(
      fc.property(reply, (turns) => {
        if (verdict(turns) !== "agreed") return;
        const text = turns.join(" ");
        expect(soundsDoubtful(text), JSON.stringify(turns)).toBe(false);
        expect(text.normalize("NFKC")).not.toMatch(/n't|n’t|\?|\b(?:if|unless|but|not|no)\b/i);
        expect(words(text.normalize("NFKC")).length).toBeGreaterThan(0);
      }),
      { numRuns: 4000 },
    );
  });

  it("still agrees with clear yeses, so the properties above are not vacuous", () => {
    for (const yes of ["yes", "yeah, go ahead", "of course", "mm-hmm", "okay yes"]) {
      expect(verdict([yes])).toBe("agreed");
    }
  });
});

// The model-backed judge (HL-09d) decides replies the fast path cannot. Its
// "agreed" passes a post-check that only takes approvals away: whatever the
// model says, a reply with a condition, correction or negation is not agreed.
describe("reply judge post-check fuzzing", { timeout: 60_000 }, () => {
  const VETOED = [
    "if the tests pass",
    "but not on main",
    "unless it deletes things",
    "only after lunch",
    "as long as it is quick",
    "wait",
    "hold on",
    "actually",
    "instead",
    "never mind",
    "no",
    "nope",
    "not yet",
    "don't",
    "I wouldn't",
    "can't",
    "never",
  ];
  const AGREED = { verdict: "agreed", conditional: false, retracted: false } as const;

  it("never lets a model's agreed through for a reply with a condition, correction or negation", () => {
    const reply = fc
      .tuple(
        fc.array(fc.constantFrom(...YES, ...FILLER, "no problem", "why not"), { maxLength: 3 }),
        fc.constantFrom(...VETOED),
        fc.array(fc.constantFrom(...YES, ...FILLER), { maxLength: 3 }),
        fc.constantFrom(" ", ", ", ". ", "? ", " - "),
        fc.boolean(),
      )
      .map(([before, vetoed, after, joint, split]) => {
        const parts = [...before, vetoed, ...after].filter((part) => part !== "");
        return split ? parts : [parts.join(joint)];
      });
    fc.assert(
      fc.property(reply, (turns) => {
        expect(checkedVerdict(AGREED, turns), JSON.stringify(turns)).toBe("unclear");
      }),
      { numRuns: 4000 },
    );
  });

  it("keeps a model's agreed for a plain yes, so the property above is not vacuous", () => {
    expect(checkedVerdict(AGREED, ["no problem, go ahead"])).toBe("agreed");
    expect(checkedVerdict(AGREED, ["yes"])).toBe("agreed");
  });
});
