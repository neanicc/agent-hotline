// HL-13a end to end: a same-user process that read Hotline's webhook secrets can
// sign a Twilio or ElevenLabs webhook itself, but it cannot make the owner's
// message or the owner's speech exist at the provider. These tests run the real
// daemon with the fake providers, whose message log and conversation records
// hold only what they actually sent, received or played, and forge correctly
// signed webhooks against it. Fake clock; nothing leaves 127.0.0.1.
import { type Ask, permissionVerdict } from "@hotline/core";
import { scriptedHuman, type VoiceToolClient } from "@hotline/providers";
import { afterEach, describe, expect, it } from "vitest";
import { FORGERY_TEXT, UNCONFIRMED_SMS_REPLY } from "../src/index.js";
import { answerOf, HOTLINE_NUMBER, type Hotline, OWNER, PIN, startHotline } from "./hotline-harness.js";

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
    expect(await h.text(`yes ${code}`, { forged: true })).toBe(UNCONFIRMED_SMS_REPLY);
    expect(await verdict(h, push)).toBe("waiting");
    expect(h.daemon.store.getAnswer(push.id)).toBeUndefined();
    expect(audits(h, "sms.received")).toEqual([]);
    expect(audits(h, "security.possible-forgery").map((e) => e.detail)).toEqual([
      { channel: "sms", what: "text", reason: "the provider has no such record" },
    ]);
    // The owner hears about it, once an hour at most.
    expect(h.sms.sent.filter((s) => s.text === FORGERY_TEXT)).toHaveLength(1);
    expect(await h.text(`yes ${code}`, { forged: true })).toBe(UNCONFIRMED_SMS_REPLY);
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
    expect(await h.text(`yes ${code}`, { messageSid: sid })).toBe(UNCONFIRMED_SMS_REPLY);
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

  it("gives no answer when the conversation cannot be pulled, though the owner said it", async () => {
    const h = await start();
    const session = await h.registerSession();
    const ask = await h.ask(session, {
      kind: "question",
      text: "Pin the older version or skip Windows?",
      options: ["Pin the older version", "Skip Windows"],
    });
    await h.advance(BATCH_MS);
    h.voice.script(
      scriptedHuman.says({ kind: "answer", ask: 1, decision: "option", option: 2, words: "skip windows" }),
    );
    // The outbound call needs no PIN, so the only pull is the post-call one.
    h.voice.failNextFetch();
    await h.voice.playPending();
    await h.settle();
    expect(h.daemon.store.getAnswer(ask.id)).toBeUndefined();
    expect((await h.outcome(ask.id)).outcome?.outcome).not.toBe("answered");
    expect(audits(h, "call.ended").map((e) => e.detail)).toMatchObject([{ result: "failed" }]);
    expect(audits(h, "security.unverified").map((e) => e.detail)).toEqual([
      { channel: "voice", what: "post-call", reason: "the provider lookup failed (unreachable)" },
    ]);
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
