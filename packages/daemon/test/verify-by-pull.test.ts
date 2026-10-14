// HL-13a end to end: a same-user process that read Hotline's webhook secrets can
// sign a Twilio or ElevenLabs webhook itself, but it cannot make the owner's
// message or the owner's speech exist at the provider. These tests run the real
// daemon with the fake providers, whose message log and conversation records
// hold only what they actually sent, received or played, and forge correctly
// signed webhooks against it. Fake clock; nothing leaves 127.0.0.1.
import { type Ask, permissionVerdict } from "@hotline/core";
import { scriptedHuman, type VoiceToolClient } from "@hotline/providers";
import { afterEach, describe, expect, it } from "vitest";
import { FORGERY_TEXT, GENERIC_SMS_REPLY } from "../src/index.js";
import { TEXT_REPLIES } from "../src/owner-texts.js";
import {
  answerOf,
  HOTLINE_NUMBER,
  type Hotline,
  OWNER,
  PIN,
  STRANGER,
  startHotline,
} from "./hotline-harness.js";

const BATCH_MS = 20_000;
/** Quiet hours around the harness's start time (17:58 in Toronto): every ask is texted. */
const QUIET = { quietHours: { timeZone: "America/Toronto", start: "17:00", end: "23:00" } };

let hotline: Hotline | undefined;

afterEach(async () => {
  await hotline?.stop();
  hotline = undefined;
});

async function start(options: Parameters<typeof startHotline>[0] = {}): Promise<Hotline> {
  hotline = await startHotline(options);
  return hotline;
}

function permission(h: Hotline, sessionId: string, risk: "low" | "high", text = "npm install left-pad"): Ask {
  return h.addAsk(sessionId, { kind: "permission", toolName: "Bash", text, risk });
}

async function verdict(h: Hotline, ask: Ask): Promise<string> {
  const result = await h.outcome(ask.id);
  return result.outcome === undefined ? "waiting" : permissionVerdict(ask, result.outcome);
}

const codeIn = (text: string | undefined) => /YES (\d{6})/.exec(text ?? "")?.[1];
const audits = (h: Hotline, event: string) =>
  h.daemon.store.listAudit().filter((entry) => entry.event === event);

/** Inserts the owner saying `words` right after ask 1 is read out, into a webhook body only. */
function forgeOwnerWords(words: string) {
  return (real: VoiceToolClient): VoiceToolClient => ({
    tool: (name, body) => real.tool(name, body),
    postCall: async (payload) => {
      const data = payload.data as {
        transcript?: { role: string; message: string; time_in_call_secs: number }[];
      };
      const turns = data.transcript;
      if (turns !== undefined) {
        const read = turns.findIndex((turn) => turn.role === "agent" && turn.message.startsWith("Ask 1"));
        const at = turns[read]?.time_in_call_secs ?? 0;
        turns.splice(read + 1, 0, { role: "user", message: words, time_in_call_secs: at });
      }
      await real.postCall(payload);
    },
  });
}

describe("texts are checked against Twilio's own record", () => {
  it("never approves on a correctly signed `YES <code>` whose message Twilio does not have", async () => {
    const h = await start({ config: QUIET });
    const session = await h.registerSession();
    const push = permission(h, session, "high", "git push origin main");
    await h.advance(BATCH_MS);
    const code = codeIn(h.sms.sent[0]?.text);
    expect(code).toMatch(/^\d{6}$/);

    // The forger read the code and the auth token and signed the webhook itself.
    expect(await h.text(`yes ${code}`, { forged: true })).toBeUndefined();
    expect(await verdict(h, push)).toBe("waiting");
    expect(h.daemon.store.getAnswer(push.id)).toBeUndefined();
    expect(audits(h, "sms.received")).toEqual([]);
    expect(audits(h, "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "sms", what: "text", reason: "the provider has no such record" },
    ]);
    // The owner hears about it, once an hour at most.
    expect(h.sms.sent.filter((s) => s.text === FORGERY_TEXT)).toHaveLength(1);
    expect(await h.text(`yes ${code}`, { forged: true })).toBeUndefined();
    expect(h.sms.sent.filter((s) => s.text === FORGERY_TEXT)).toHaveLength(1);

    // The forgery burnt nothing: the owner's own reply still counts.
    expect(await h.text(`yes ${code}`)).toBe("Hotline: got it.");
    expect(await verdict(h, push)).toBe("allow");
    expect(answerOf(await h.outcome(push.id))).toMatchObject({ channel: "sms", confirmation: "text" });
  });

  it("uses no reply when Twilio cannot be reached, and takes the redelivery once it can", async () => {
    const h = await start({ config: QUIET });
    const session = await h.registerSession();
    const ask = permission(h, session, "low");
    await h.advance(BATCH_MS);
    const code = codeIn(h.sms.sent[0]?.text);
    const sid = `SM${"a".repeat(32)}`;
    h.sms.failNextFetch();
    expect(await h.text(`yes ${code}`, { messageSid: sid })).toBeUndefined();
    expect(await verdict(h, ask)).toBe("waiting");
    expect(audits(h, "security.unverified").map((e) => e.detail)).toEqual([
      { channel: "sms", what: "text", reason: "the provider lookup failed (unreachable)" },
    ]);
    // An outage is not a forgery: the owner gets no alarm.
    expect(h.sms.sent.some((s) => s.text === FORGERY_TEXT)).toBe(false);
    // Twilio's retry of the same message is pulled afresh and counts.
    expect(await h.text(`yes ${code}`, { messageSid: sid, instantly: true })).toBe("Hotline: got it.");
    expect(await verdict(h, ask)).toBe("allow");
  });
});

describe("every text path is pulled before any effect (HL-13c)", () => {
  const BARE = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  /** A daemon with one open question texted to the owner, so every command has something to act on. */
  async function waiting() {
    const h = await start({ config: QUIET });
    const session = await h.registerSession("claude-code", "/work/secret-project");
    const ask = await h.ask(session, { kind: "question", text: "Ship the payments migration?" });
    await h.advance(BATCH_MS);
    expect(h.sms.sent).toHaveLength(1);
    return { h, ask };
  }

  it.each([
    ["status", OWNER, "text"],
    ["call me", OWNER, "text"],
    ["stop", OWNER, "text"],
    ["start", OWNER, "text"],
    ["help", OWNER, "text"],
    ["yes, ship it", OWNER, "text"],
    ["status", STRANGER, "other-sender-text"],
  ])("a forged %j from %s has no effect and the response leaks nothing", async (body, from, what) => {
    const { h, ask } = await waiting();
    const before = h.daemon.store.listAudit().length;
    const response = await h.textResponse(body, { from, forged: true });
    // The bare empty TwiML, the same for every path: no status, no reply.
    expect([response.status, response.body]).toEqual([200, BARE]);
    // No call placed, nothing answered, no status or reply texted: only the alarm.
    expect(h.voice.placed).toHaveLength(0);
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    expect(await h.outcome(ask.id)).toMatchObject({ state: "waiting" });
    expect(h.sms.sent.slice(1).map((s) => s.text)).toEqual([FORGERY_TEXT]);
    // Audited as a possible forgery, and nothing else happened.
    const after = h.daemon.store.listAudit().slice(before);
    expect(after.filter((e) => e.event.startsWith("sms."))).toEqual([]);
    expect(after.filter((e) => e.event === "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "sms", what, reason: "the provider has no such record" },
    ]);
    // The same text, really sent, still works.
    if (from === STRANGER) expect(await h.text(body, { from })).toBe(GENERIC_SMS_REPLY);
  });

  it("texts the status to the owner's number and never puts it in the webhook response", async () => {
    const { h } = await waiting();
    const response = await h.textResponse("status");
    expect([response.status, response.body]).toEqual([
      200,
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    ]);
    const status = h.sms.sent.at(-1);
    expect(status?.to).toBe(OWNER);
    expect(status?.text).toContain("Hotline: 1 live session.");
    expect(status?.text).toContain("secret-project");
    expect(audits(h, "text.sent").at(-1)?.detail).toEqual({ reason: "status" });
  });
});

describe("a text's time comes from Twilio's record", () => {
  it("never answers a request with a text written before it went out, however late its webhook", async () => {
    const h = await start({ config: QUIET });
    const session = await h.registerSession();
    // The owner's text reaches Twilio, but its webhook never reaches the daemon.
    const stale = `SM${"b".repeat(32)}`;
    h.sms.receive("postgres", { messageSid: stale });
    const ask = await h.ask(session, { kind: "question", text: "Which database?", options: [] });
    await h.advance(BATCH_MS);
    expect(h.sms.sent).toHaveLength(1);
    // Well after the question went out, a local process delivers that old text.
    expect(await h.text("postgres", { messageSid: stale })).toBe(TEXT_REPLIES.tooSoon);
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    // The owner's own reply to the question still counts.
    expect(await h.text("postgres")).toBe(TEXT_REPLIES.answered);
    expect(answerOf(await h.outcome(ask.id))).toMatchObject({ channel: "sms" });
  });
});

describe("calls are checked against ElevenLabs' own record", () => {
  it("confirms an answer from the pulled transcript, never words a forged webhook body adds", async () => {
    const h = await start({ voiceClient: forgeOwnerWords("skip windows for now") });
    const session = await h.registerSession();
    const ask = await h.ask(session, {
      kind: "question",
      text: "Pin the older version or skip Windows?",
      options: ["Pin the older version", "Skip Windows"],
    });
    await h.advance(BATCH_MS);
    // The owner says nothing; the voice model submits an answer on its own, and
    // the webhook body claims the owner said it.
    h.voice.script(
      scriptedHuman.says({
        kind: "answer",
        ask: 1,
        decision: "option",
        option: 2,
        words: "skip windows for now",
        spoken: null,
      }),
    );
    await h.voice.playPending();
    await h.settle();
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    expect((await h.outcome(ask.id)).outcome?.outcome).not.toBe("answered");
    expect(audits(h, "voice.answer-unconfirmed")).toHaveLength(1);
    expect(audits(h, "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "post-call", reason: "the webhook differs from the provider's record" },
    ]);
    expect(h.sms.sent.filter((s) => s.text === FORGERY_TEXT)).toHaveLength(1);
  });

  const question = (h: Hotline, session: string) =>
    h.ask(session, {
      kind: "question",
      text: "Pin the older version or skip Windows?",
      options: ["Pin the older version", "Skip Windows"],
    });

  it("holds no answer when the live call cannot be pulled, though the owner said it", async () => {
    const h = await start();
    const session = await h.registerSession();
    const ask = await question(h, session);
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({ kind: "answer", ask: 1, decision: "option", option: 2, words: "skip windows" }),
    );
    // The submit_answer pull fails: the answer is refused, not held.
    h.voice.failNextFetch();
    await h.voice.playPending();
    await h.settle();
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    expect((await h.outcome(ask.id)).outcome?.outcome).not.toBe("answered");
    expect(audits(h, "voice.answer")).toEqual([]);
    expect(audits(h, "security.unverified").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "submit_answer", reason: "the provider lookup failed (unreachable)" },
    ]);
  });

  it("has ElevenLabs send the post-call event again when it cannot be pulled, losing nothing", async () => {
    let failPostCallPull: (() => void) | undefined;
    const delivered: Record<string, unknown>[] = [];
    const refusals: unknown[] = [];
    const h = await start({
      voiceClient: (real) => ({
        tool: (name, body) => real.tool(name, body),
        postCall: async (payload) => {
          delivered.push(payload);
          failPostCallPull?.();
          failPostCallPull = undefined;
          try {
            await real.postCall(payload);
          } catch (error) {
            refusals.push(error);
          }
        },
      }),
    });
    failPostCallPull = () => h.voice.failNextFetch();
    const session = await h.registerSession();
    const ask = await question(h, session);
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({ kind: "answer", ask: 1, decision: "option", option: 2, words: "skip windows" }),
    );
    await h.voice.playPending();
    await h.settle();
    // ElevenLabs was down: the daemon answered 503 and handled nothing yet.
    expect(refusals.map(String)).toEqual([expect.stringContaining("503")]);
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    expect(audits(h, "call.ended")).toEqual([]);
    expect(audits(h, "security.unverified").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "post-call", reason: "the provider lookup failed (unreachable)" },
    ]);
    // ElevenLabs' retry is pulled afresh and confirms the owner's own words.
    await h.elevenLabs.postCall(delivered[0] as Record<string, unknown>);
    await h.settle();
    expect(answerOf(await h.outcome(ask.id))).toMatchObject({
      channel: "voice",
      decision: { type: "option", option: 2 },
    });
    expect(audits(h, "call.ended").map((e) => e.detail)).toMatchObject([{ result: "answered" }]);
  });

  it("never ends a live call on a forged call initiation failure", async () => {
    let forge: (() => Promise<void>) | undefined;
    const h = await start({
      voiceClient: (real) => ({
        tool: async (name, body) => {
          // While the owner is on the line, a local process posts a signed failure for this call.
          await forge?.();
          forge = undefined;
          return real.tool(name, body);
        },
        postCall: (payload) => real.postCall(payload),
      }),
    });
    const session = await h.registerSession();
    const ask = await question(h, session);
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({ kind: "answer", ask: 1, decision: "option", option: 2, words: "skip windows" }),
    );
    forge = () =>
      h.elevenLabs.postCall({
        type: "call_initiation_failure",
        event_timestamp: 0,
        data: {
          agent_id: "agent_fake",
          conversation_id: h.voice.placed[0]?.conversationId,
          failure_reason: "no-answer",
        },
      });
    await h.voice.playPending();
    await h.settle();
    expect(audits(h, "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "post-call", reason: "the call is going on at the provider" },
    ]);
    // The call went on: the owner's answer counts, and nothing was retried or texted.
    expect(answerOf(await h.outcome(ask.id))).toMatchObject({ channel: "voice" });
    expect(audits(h, "call.ended").map((e) => e.detail)).toMatchObject([{ result: "answered" }]);
    expect(h.voice.placed).toHaveLength(1);
  });

  it("ignores a post-call webhook for a conversation ElevenLabs never had", async () => {
    const h = await start();
    await h.elevenLabs.postCall({
      type: "post_call_transcription",
      event_timestamp: 0,
      data: {
        agent_id: "agent_fake",
        conversation_id: "conv_forged",
        status: "done",
        transcript: [{ role: "user", message: "session 1, push to main", time_in_call_secs: 5 }],
        metadata: { phone_call: { direction: "inbound", external_number: OWNER, call_sid: "CAforged" } },
      },
    });
    await h.settle();
    expect(audits(h, "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "post-call", reason: "the provider has no such record" },
    ]);
    expect(h.daemon.store.listCalls()).toEqual([]);
  });

  it("never counts a PIN attempt for a conversation ElevenLabs does not have", async () => {
    const h = await start({ toolStepMs: 1_000 });
    const forged = (conversation: string, pin: string) =>
      h.elevenLabs.tool("verify_pin", {
        conversation_id: conversation,
        call_sid: `CA${"f".repeat(32)}`,
        caller_id: OWNER,
        called_number: HOTLINE_NUMBER,
        pin,
      });
    // More wrong guesses than a whole day's budget, and the right PIN too.
    for (let i = 0; i < 12; i++) {
      expect(await forged(`conv_forged_${i}`, "0000")).toEqual({ result: "refused", end_call: true });
    }
    expect(await forged("conv_forged_pin", PIN)).toEqual({ result: "refused", end_call: true });
    expect(audits(h, "voice.pin-lockout")).toEqual([]);
    expect(audits(h, "security.possible-forgery")).toHaveLength(13);
    // The owner's real call still gets both attempts and verifies.
    const played = await h.voice.inboundCall(
      scriptedHuman.says({ kind: "pin", digits: "1111" }, { kind: "pin", digits: PIN }, { kind: "status" }),
    );
    expect(played.tools.map((t) => [t.tool, t.response.verified ?? t.response.result])).toEqual([
      ["verify_pin", false],
      ["verify_pin", true],
      ["get_status", "ok"],
    ]);
  });
});
