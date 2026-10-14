import type { Ask } from "@hotline/core";
import { describe, expect, it } from "vitest";
import { MIN_REPLY_DELAY_MS, planTextReply, textFor, type WaitingText } from "../src/index.js";

const SENT = new Date("2026-10-13T22:00:00.000Z");
const LATER = new Date(SENT.getTime() + 60_000);
const SID = `SM${"1".repeat(32)}`;

function ask(fields: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    sessionId: "s1",
    kind: "question",
    text: "Which database?",
    options: [],
    risk: "low",
    urgent: false,
    createdAt: new Date(SENT.getTime() - 60_000).toISOString(),
    expiresAt: new Date(SENT.getTime() + 30 * 60_000).toISOString(),
    status: "in-flight",
    ...fields,
  };
}

const plan = (body: string, waiting: WaitingText[], firstSeenAt = LATER, receivedAt = LATER) =>
  planTextReply({ body, messageSid: SID, receivedAt, firstSeenAt, optedOut: false, waiting });

describe("planTextReply", () => {
  it("answers the one waiting question with free text first seen well after it was texted", () => {
    expect(plan("postgres", [{ ask: ask(), sentAt: SENT }])).toMatchObject({
      type: "answer",
      answer: { decision: { type: "text", text: "postgres" } },
    });
  });

  it("never answers a question with a reply first seen before, or right after, it was texted", () => {
    const waiting = [{ ask: ask(), sentAt: SENT }];
    // A stale reply: first seen before the question went out, even if (re)delivered later.
    expect(plan("postgres", waiting, new Date(SENT.getTime() - 1_000))).toEqual({ type: "too-soon" });
    expect(plan("postgres", waiting, new Date(SENT.getTime() + MIN_REPLY_DELAY_MS - 1))).toEqual({
      type: "too-soon",
    });
    // An unknown send time fails closed.
    expect(plan("postgres", [{ ask: ask() }])).toEqual({ type: "too-soon" });
  });

  it("approves a permission request of any risk only with its code", () => {
    for (const risk of ["low", "high"] as const) {
      const waiting = [
        {
          ask: ask({ kind: "permission", toolName: "Bash", risk, text: "npm install" }),
          code: "482913",
          sentAt: SENT,
        },
      ];
      expect(plan("yes", waiting)).toMatchObject({ type: "not-an-answer" });
      expect(plan("yes 482913", waiting)).toMatchObject({
        type: "answer",
        answer: { decision: { type: "allow" }, confirmation: "text" },
        codeUsed: true,
      });
      expect(plan("no", waiting)).toMatchObject({ type: "answer", answer: { decision: { type: "deny" } } });
    }
  });

  it("does not let a code from an older request match a newer one", () => {
    const waiting = [
      {
        ask: ask({ kind: "permission", toolName: "Bash", text: "npm install" }),
        code: "111111",
        sentAt: SENT,
      },
    ];
    expect(plan("yes 482913", waiting)).toEqual({ type: "code-mismatch" });
  });
});

describe("textFor", () => {
  it("puts the code in every permission text", () => {
    const low = ask({ kind: "permission", toolName: "Bash", text: "npm install" });
    expect(textFor(low, "Claude in demo-app", "482913")).toBe(
      "Hotline: Claude in demo-app wants to use Bash: npm install\nReply YES 482913 to allow, or NO to deny.",
    );
    expect(textFor({ ...low, risk: "high" }, "Claude in demo-app", "482913")).toContain(
      "HIGH RISK. Reply YES 482913 to allow",
    );
    expect(textFor(low, "Claude in demo-app", undefined)).toContain("It can only be approved on a call.");
  });
});
