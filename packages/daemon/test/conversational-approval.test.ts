// HL-14c: the voice persona (definition v4) reads every allow back before it
// submits it, submits a clear no at once, and after two unclear replies says it
// will text and submits nothing. End to end through the real daemon with the
// fake voice provider playing those flows: a confirmed read-back is an allow, a
// no is a deny, and an ask left without a decision when the call ends goes out
// by text (the existing after-call path), never as an approval. HL-09c: the
// daemon now requires that read-back in the transcript, takes any natural yes
// in reply to it, and logs an owner who stayed unclear as `owner-unclear`.
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

  it.each(["of course", "absolutely", "do it", "go for it", "send it", "for sure"])(
    "allows on the clear reply %j to the read-back (HL-09c)",
    async (said) => {
      const h = await start();
      const session = await h.registerSession();
      const request = permission(h, session, "low", "pnpm test");
      await h.advance(BATCH_MS);
      h.voice.script(scriptedHuman.confirms(1, "sure", said));
      await h.voice.playPending();
      await h.settle();
      expect(await verdict(h, request)).toBe("allow");
      expect(answerOf(await h.outcome(request.id)).ownerExcerpt).toBe(said);
    },
  );

  it("allows a clear yes to 'is that a yes or a no?' after a hesitation (HL-09c)", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says(
        { kind: "unsure", ask: 1, words: "hmm" },
        { kind: "answer", ask: 1, decision: "allow", words: "yeah go ahead" },
      ),
    );
    await h.voice.playPending();
    await h.settle();
    expect(await verdict(h, request)).toBe("allow");
    expect(answerOf(await h.outcome(request.id)).ownerExcerpt).toBe("yeah go ahead");
  });

  it("never approves an allow submitted without a read-back: the ask is texted (HL-09c)", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    // A model on definition v3 or earlier: the owner says yes and it submits at once.
    h.voice.script(scriptedHuman.allows(1, "of course"));
    const [played] = await h.voice.playPending();
    await h.settle();
    expect(played?.tools.map((t) => t.response.result)).toEqual(["recorded"]);
    expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
    expect(
      h.daemon.store.listAudit({ askId: request.id }).find((e) => e.event === "voice.answer-unconfirmed")
        ?.detail,
    ).toEqual({ reason: "the request was not read back for a yes" });
    expect(h.sms.sent.map((s) => s.text)).toEqual([expect.stringContaining("pnpm test")]);
    expect(await verdict(h, request)).toBe("waiting");
    await h.advance(30 * MINUTE);
    expect(await verdict(h, request)).toBe("deny");
  });

  it.each(["of course, wait", "what does that do?", "sure, if the tests pass"])(
    "does not allow on %j in reply to the read-back (HL-09c)",
    async (said) => {
      const h = await start();
      const session = await h.registerSession();
      const request = permission(h, session, "low", "pnpm test");
      await h.advance(BATCH_MS);
      h.voice.script(scriptedHuman.confirms(1, "sure", said));
      await h.voice.playPending();
      await h.settle();
      expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
      expect(h.sms.sent).toHaveLength(1);
      expect(await verdict(h, request)).toBe("waiting");
    },
  );

  it("denies at once when the owner says no to the read-back but the model submits allow (HL-09c)", async () => {
    const h = await start();
    const session = await h.registerSession();
    const request = permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(scriptedHuman.confirms(1, "sure", "nope"));
    await h.voice.playPending();
    await h.settle();
    // Never approved, never texted for approval: the request ends as no answer, which denies it.
    expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
    expect(await verdict(h, request)).toBe("deny");
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
    // The call log tells "the owner stayed unclear" apart from a dropped call (HL-09c);
    // the queue still sees `dropped`, which is what texts the ask.
    expect(h.daemon.store.listAudit({ askId: request.id }).map((e) => e.event)).toContain(
      "voice.ask-unclear",
    );
    expect(h.daemon.store.listAudit().find((e) => e.event === "call.ended")?.detail).toMatchObject({
      result: "owner-unclear",
    });
    expect(h.daemon.store.listCalls()).toMatchObject([{ outcome: "answered" }]);
    // No reply: it expires as no answer, which denies the permission.
    await h.advance(30 * MINUTE);
    const result = await h.outcome(request.id);
    expect(result.outcome?.outcome).toBe("no-answer");
    expect(await verdict(h, request)).toBe("deny");
    expect(h.daemon.store.getAnswer(request.id)).toBeUndefined();
    expect(TEXT_INSTEAD).toContain("text you");
  });

  it("a call the owner hung up on before an ask was read is still logged as dropped", async () => {
    const h = await start();
    const session = await h.registerSession();
    permission(h, session, "low", "pnpm test");
    await h.advance(BATCH_MS);
    h.voice.script(scriptedHuman.says({ kind: "say", words: "hello, who is this" }, { kind: "hang-up" }));
    await h.voice.playPending();
    await h.settle();
    expect(h.daemon.store.listAudit().find((e) => e.event === "call.ended")?.detail).toMatchObject({
      result: "dropped",
    });
    expect(h.daemon.store.listAudit().map((e) => e.event)).not.toContain("voice.ask-unclear");
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
