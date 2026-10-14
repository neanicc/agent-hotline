// Fuzz tests for text replies (HL-13): no reply approves a permission request
// unless it is a clear yes followed by that request's own confirmation code, and
// a conditional, negated or hedged yes never approves, whatever the code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ask, type AskKind, parseSmsReply, smsAnswer } from "../src/index.js";

const RECEIVED = new Date("2026-10-13T22:00:00.000Z");
const SID = `SM${"a".repeat(32)}`;

function ask(kind: AskKind, risk: "low" | "high" = "low"): Ask {
  return Ask.parse({
    id: "ask-1",
    sessionId: "session-1",
    kind,
    text: kind === "permission" ? "Run pnpm test" : "Which database?",
    ...(kind === "permission" ? { toolName: "Bash", risk } : {}),
    ...(kind === "question" ? { options: ["Postgres", "SQLite"] } : {}),
    createdAt: "2026-10-13T21:58:00.000Z",
    expiresAt: "2026-10-13T22:28:00.000Z",
    status: "in-flight",
  });
}

const ASKS = [ask("permission"), ask("permission", "high"), ask("question"), ask("stop"), ask("notify")];
const YES_WORDS = ["yes", "y", "yeah", "yep", "yup", "approve", "approved", "allow", "YES", "Yes"];
const code = fc.stringMatching(/^\d{6}$/);

function approves(body: string, kind: Ask, confirmationCode: string | undefined): boolean {
  const result = smsAnswer({ ask: kind, body, messageSid: SID, receivedAt: RECEIVED, confirmationCode });
  return result.outcome === "answered" && result.answer.decision.type === "allow";
}

/** Text replies built from the words that matter, plus noise. */
const vocabulary = (expected: string) =>
  fc.constantFrom(
    ...YES_WORDS,
    expected,
    `${expected}0`,
    expected.slice(1),
    "123456",
    "no",
    "not",
    "don't",
    "if",
    "but",
    "unless",
    "maybe",
    "wait",
    "only",
    "after",
    "tests",
    "pass",
    "?",
    "!",
    ".",
    ",",
    "#1",
    "1",
    "call me",
    "stop",
    "​",
    " ",
    "ｙｅｓ",
    "\n",
  );

describe("text reply fuzzing", () => {
  it("approves only a clear yes followed by the request's own code", () => {
    fc.assert(
      fc.property(
        code,
        fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.string({ unit: "grapheme", maxLength: 20 }),
          code.chain((expected) => fc.array(vocabulary(expected), { maxLength: 6 }).map((w) => w.join(" "))),
        ),
        fc.constantFrom(...ASKS),
        (expected, body, target) => {
          if (!approves(body, target, expected)) return;
          // Only a permission request, and only "<yes word> <its code>".
          expect(target.kind).toBe("permission");
          expect(parseSmsReply(body)).toEqual({ type: "yes", code: expected });
          const words = body.normalize("NFKC").toLowerCase().trim().split(/\s+/);
          expect(words.length).toBe(2);
          expect(words[1]?.replace(/[.!?]+$/, "")).toBe(expected);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("approves nothing when no code was sent", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 40 }),
          code.chain((c) => fc.array(vocabulary(c), { maxLength: 6 }).map((w) => w.join(" "))),
        ),
        fc.constantFrom(...ASKS),
        (body, target) => {
          expect(approves(body, target, undefined)).toBe(false);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never approves a conditional, negated, hedged or wrong-code yes", () => {
    const yes = fc.constantFrom(...YES_WORDS);
    const condition = fc.constantFrom(
      "if the tests pass",
      "but not on main",
      "unless it deletes files",
      "only after lunch",
      "no",
      "wait",
      "maybe",
      "?? no",
      "not yet",
      "later",
      "and also push",
    );
    const negation = fc.constantFrom("not", "don't", "no", "maybe", "never", "do not", "hmm");
    const reply = fc.oneof(
      fc.tuple(yes, code, condition).map(([y, c, tail]) => ({ body: `${y} ${c} ${tail}`, code: c })),
      fc.tuple(negation, yes, code).map(([n, y, c]) => ({ body: `${n} ${y} ${c}`, code: c })),
      fc.tuple(yes, condition, code).map(([y, tail, c]) => ({ body: `${y} ${tail} ${c}`, code: c })),
      fc
        .tuple(yes, code, code)
        .filter(([, sent, expected]) => sent !== expected)
        .map(([y, sent, expected]) => ({ body: `${y} ${sent}`, code: expected })),
      fc.tuple(yes, code).map(([y, c]) => ({ body: `${y}, ${c}, if that's safe`, code: c })),
    );
    fc.assert(
      fc.property(reply, fc.constantFrom(...ASKS), ({ body, code: expected }, target) => {
        expect(approves(body, target, expected), JSON.stringify(body)).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });
});
