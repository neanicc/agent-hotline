// HL-14c: the voice persona (definition v4) reads every allow back before it
// submits it, submits a clear no at once, and after two unclear replies says it
// will text and submits nothing. End to end through the real daemon with the
// fake voice provider playing those flows: a confirmed read-back is an allow, a
// no is a deny, and an ask left without a decision when the call ends goes out
// by text (the existing after-call path), never as an approval.
import { type Ask, permissionVerdict } from "@hotline/core";
import { scriptedHuman, TEXT_INSTEAD } from "@hotline/providers";
import { afterEach, describe, expect, it } from "vitest";
import { answerOf, type Hotline, PIN, startHotline } from "./hotline-harness.js";

const BATCH_MS = 20_000;
const MINUTE = 60_000;

let hotline: Hotline | undefined;

afterEach(async () => {
  await hotline?.stop();
  hotline = undefined;
});

async function start(): Promise<Hotline> {
  hotline = await startHotline();
  return hotline;
}

function permission(h: Hotline, sessionId: string, risk: "low" | "high", text: string): Ask {
  return h.addAsk(sessionId, { kind: "permission", toolName: "Bash", text, risk });
}

async function verdict(h: Hotline, ask: Ask): Promise<string> {
  const result = await h.outcome(ask.id);
  return result.outcome === undefined ? "waiting" : permissionVerdict(ask, result.outcome);
}

describe("conversational approval by voice (HL-14c)", () => {
  it("allows after the owner confirms the read-back, storing the confirming reply", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(scriptedHuman.confirms(1, "yeah, go for it", "yes"));
    await h.voice.playPending();
    await h.settle();
    expect(await verdict(h, request)).toBe("allow");
    expect(answerOf(await h.outcome(request.id))).toMatchObject({
      decision: { type: "allow" },
      channel: "voice",
      ownerExcerpt: "yes",
    });
    expect(h.sms.sent).toHaveLength(0);
  });

  it("denies when the owner says no to the read-back", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({
        kind: "read-back",
        ask: 1,
        words: "sure",
        reply: "no, hold off",
        decision: "deny",
      }),
    );
    await h.voice.playPending();
    await h.settle();
    expect(await verdict(h, request)).toBe("deny");
    expect(answerOf(await h.outcome(request.id)).decision).toEqual({ type: "deny" });
  });

  it("allows a high-risk request after one PIN and a confirmed read-back", async () => {
    const h = await start();
    const session = await h.registerSession();
    const push = permission(h, session, "high", "git push origin main");
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says(
        { kind: "pin", digits: PIN },
        { kind: "read-back", ask: 1, words: "yep, push it", reply: "yes", decision: "allow" },
      ),
    );
    await h.voice.playPending();
    await h.settle();
    expect(await verdict(h, push)).toBe("allow");
    expect(answerOf(await h.outcome(push.id)).confirmation).toBe("pin");
  });

  it("two unclear replies: nothing is submitted, the ask is texted at once, and it is never approved", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(scriptedHuman.unsureTwice());
    const [played] = await h.voice.playPending();
    await h.settle();
    // The voice agent promised a text out loud and called no tool.
    expect(played?.tools).toEqual([]);
    expect(h.voice.placed).toHaveLength(1);
    // The call ended with the ask open: it goes out by text right away, not as "unclear".
    expect(h.sms.sent.map((s) => s.text)).toEqual([expect.stringContaining("pnpm test")]);
    expect(await verdict(h, request)).toBe("waiting");
    expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
    // No reply: it expires as no answer, which denies the permission.
    await h.advance(30 * MINUTE);
    const result = await h.outcome(request.id);
    expect(result.outcome?.outcome).toBe("no-answer");
    expect(await verdict(h, request)).toBe("deny");
    expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
    expect(TEXT_INSTEAD).toContain("text you");
  });

  it("two unclear replies to a question: the text the owner then answers is the answer", async () => {
    const h = await start();
    const session = await h.registerSession();
    const question = await h.ask(session, {
      kind: "question",
      text: "Pin the older ONNX runtime or skip the Windows build?",
      options: ["Pin ONNX", "Skip Windows"],
    });
    await h.advance(BATCH_MS);
    h.voice.script(scriptedHuman.unsureTwice());
    await h.voice.playPending();
    await h.settle();
    expect(h.sms.sent.map((s) => s.text)).toEqual([expect.stringContaining("skip the Windows build")]);
    expect(await h.text("2")).toBe("Hotline: got it.");
    expect(answerOf(await h.outcome(question.id))).toMatchObject({
      decision: { type: "option", option: 2 },
      channel: "sms",
    });
  });
});
