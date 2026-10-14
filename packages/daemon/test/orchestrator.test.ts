// CallOrchestrator against a real store with in-process providers: crash
// recovery, message claims and deadlines that the end-to-end tests cannot reach.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ask, parseConfig, policySettings } from "@hotline/core";
import {
  FakeSmsProvider,
  type OutboundCall,
  type PlacedCall,
  type SmsProvider,
  type VoiceProvider,
} from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CallOrchestrator,
  type CallOrchestratorOptions,
  type HotlineStore,
  ORCHESTRATOR_STATE_KEY,
  openStore,
  RATE_STATE_KEY,
} from "../src/index.js";

const OWNER = "+15555550100";
const START = new Date("2026-10-13T21:58:00.000Z");
const MINUTE = 60_000;
/** The owner reads a text before replying; quicker replies are not bound to it. */
const READ_MS = 15_000;
const PIN_HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;
/** Quiet hours all day, so every ask is texted. */
const settings = policySettings(
  parseConfig({
    version: 1,
    owner: { phoneNumber: OWNER, pinHash: PIN_HASH },
    quietHours: { timeZone: "America/Toronto", start: "00:00", end: "23:59" },
  }),
);

let dir: string;
let store: HotlineStore;
let clock: { now: Date };
const running: CallOrchestrator[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-orchestrator-"));
  store = await openStore(join(dir, "hotline.db"));
  clock = { now: START };
  store.putSession({
    id: "s1",
    agent: "claude-code",
    cwd: "/work/demo-app",
    nickname: "Claude in demo-app",
    state: "working",
    registeredAt: START.toISOString(),
    lastSeenAt: START.toISOString(),
  });
});

afterEach(async () => {
  for (const orchestrator of running.splice(0)) await orchestrator.stop();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function orchestrator(options: Partial<CallOrchestratorOptions> = {}): Promise<CallOrchestrator> {
  const created = new CallOrchestrator({
    store,
    settings,
    clock: () => clock.now,
    redact: (text) => text,
    autoTick: false,
    stopWaitMs: 50,
    ...options,
  });
  running.push(created);
  await created.start();
  return created;
}

let ids = 0;
function addAsk(fields: Partial<Ask> = {}): Ask {
  ids += 1;
  const ask: Ask = {
    id: `ask-${ids}`,
    sessionId: "s1",
    kind: "permission",
    text: `npm install package-${ids}`,
    toolName: "Bash",
    options: [],
    risk: "low",
    urgent: false,
    createdAt: clock.now.toISOString(),
    expiresAt: new Date(clock.now.getTime() + 30 * MINUTE).toISOString(),
    status: "pending",
    ...fields,
  };
  store.addAsk(ask);
  return ask;
}

async function advance(target: CallOrchestrator, ms: number): Promise<void> {
  await target.idle();
  clock.now = new Date(clock.now.getTime() + ms);
  await target.tick();
}

/** A provider whose sends never finish: the daemon died part way through. */
const hangingSms: SmsProvider = { name: "fake", sendToOwner: () => new Promise(() => {}) };
const hangingVoice: VoiceProvider = { name: "fake", callOwner: () => new Promise<PlacedCall>(() => {}) };
const sid = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;

describe("unreadable state", () => {
  it("keeps the saved call and text times, so the rate limits still hold", async () => {
    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const first = await orchestrator({ sms });
    // Use up the hourly text limit (10).
    for (let i = 0; i < 10; i++) addAsk({ kind: "notify", toolName: undefined, text: `note ${i}` });
    await advance(first, 20_000);
    expect(sms.sent).toHaveLength(10);
    await first.stop();
    store.putState(ORCHESTRATOR_STATE_KEY, { version: 99 });

    const second = await orchestrator({ sms });
    addAsk({ kind: "notify", toolName: undefined, text: "one more" });
    await advance(second, 20_000);
    expect(sms.sent).toHaveLength(10);
  });

  it("treats the hourly windows as full when the call and text times are unreadable too", async () => {
    store.putState(ORCHESTRATOR_STATE_KEY, { version: 99 });
    store.putState(RATE_STATE_KEY, "garbage");
    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const target = await orchestrator({ sms });
    addAsk();
    await advance(target, 20_000);
    expect(sms.sent).toHaveLength(0);
    expect(store.listAudit().map((e) => e.event)).toContain("orchestration.rates-reset");
    await advance(target, 60 * MINUTE);
    // The ask expired meanwhile, as no answer; nothing was ever sent in a burst.
    expect(sms.sent).toHaveLength(0);
  });
});

describe("crash recovery", () => {
  it("sends a text the last run decided on but never sent", async () => {
    const first = await orchestrator({ sms: hangingSms });
    const ask = addAsk();
    void advance(first, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The queue counts the ask as texted; the text never went out.
    expect(first.queue.open[0]?.texted).toBe(true);
    await first.stop();

    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const second = await orchestrator({ sms });
    expect(sms.sent.map((s) => s.text)).toEqual([expect.stringContaining(ask.text)]);
    expect(store.listAudit().map((e) => e.event)).toContain("orchestration.recovered");
    expect(store.getAsk(ask.id)?.status).toBe("in-flight");
    clock.now = new Date(clock.now.getTime() + READ_MS);
    expect(await second.ownerText({ messageSid: sid(1), body: "yes", receivedAt: clock.now })).toBe(
      "Hotline: got it.",
    );
    expect(store.getAnswer(ask.id)?.decision).toEqual({ type: "allow" });
  });

  it("re-sends a high-risk text with the code the owner may already have", async () => {
    const first = await orchestrator({ sms: hangingSms, newCode: () => "111111" });
    addAsk({ risk: "high", text: "git push origin main" });
    void advance(first, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.stop();

    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const second = await orchestrator({ sms, newCode: () => "222222" });
    expect(sms.sent.map((s) => s.text)).toEqual([expect.stringContaining("Reply YES 111111")]);
    clock.now = new Date(clock.now.getTime() + READ_MS);
    expect(await second.ownerText({ messageSid: sid(3), body: "yes 111111", receivedAt: clock.now })).toBe(
      "Hotline: got it.",
    );
  });

  it("treats a call that may never have been placed as failed, so the queue retries it", async () => {
    const awake = policySettings(
      parseConfig({
        version: 1,
        owner: { phoneNumber: OWNER, pinHash: PIN_HASH },
        quietHours: { timeZone: "America/Toronto", start: "03:00", end: "03:01" },
      }),
    );
    const first = await orchestrator({ settings: awake, voice: hangingVoice });
    addAsk();
    void advance(first, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.queue.call).toBeDefined();
    await first.stop();

    const placed: OutboundCall[] = [];
    const voice: VoiceProvider = {
      name: "fake",
      callOwner: async (call) => {
        placed.push(call);
        return { conversationId: `conv_${placed.length}` };
      },
    };
    const second = await orchestrator({ settings: awake, voice });
    expect(second.queue.call).toBeUndefined();
    expect(second.queue.open[0]?.lastFailure).toBe("failed");
    await advance(second, 2 * MINUTE);
    expect(placed).toHaveLength(1);
  });
});

describe("owner texts", () => {
  it("claims a message before acting on it, so a redelivery after a crash never answers another ask", async () => {
    const first = await orchestrator({ sms: new FakeSmsProvider({ ownerNumber: OWNER }) });
    const a = addAsk();
    await advance(first, 20_000);
    // B is due for its text when A's answer is handled; that send hangs (the crash).
    const b = addAsk();
    await first.idle();
    const hanging = new FakeSmsProvider({ ownerNumber: OWNER });
    hanging.sendToOwner = () => new Promise(() => {});
    await first.stop();

    const crashing = await orchestrator({ sms: hanging });
    clock.now = new Date(clock.now.getTime() + 20_000);
    void crashing.ownerText({ messageSid: sid(7), body: "yes", receivedAt: clock.now });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getAnswer(a.id)?.decision).toEqual({ type: "allow" });
    await crashing.stop();

    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const restarted = await orchestrator({ sms });
    // The owner is told the interrupted text may not have counted, and B's text goes
    // out on recovery. Twilio then redelivers the old "yes", which changes nothing.
    expect(sms.sent.map((s) => s.text)).toEqual([
      expect.stringContaining("restarted while handling a text from you"),
      expect.stringContaining(b.text),
    ]);
    expect(store.unfinishedInboundMessages()).toEqual([]);
    expect(
      await restarted.ownerText({ messageSid: sid(7), body: "yes", receivedAt: clock.now }),
    ).toBeUndefined();
    expect(store.getAnswer(b.id)).toBeUndefined();
  });
});

describe("owner texts that fail", () => {
  it("tells the owner when handling a text failed, and ignores Twilio's retry", async () => {
    const target = await orchestrator({ sms: new FakeSmsProvider({ ownerNumber: OWNER }) });
    const ask = addAsk();
    await advance(target, 20_000);
    clock.now = new Date(clock.now.getTime() + READ_MS);
    const append = store.appendAudit.bind(store);
    store.appendAudit = (event, ...rest) => {
      if (event === "sms.received") throw new Error("disk full");
      return append(event, ...rest);
    };
    const reply = await target.ownerText({ messageSid: sid(9), body: "yes", receivedAt: clock.now });
    store.appendAudit = append;
    expect(reply).toBe("Hotline: something went wrong and your text was not recorded. Please send it again.");
    expect(store.getAnswer(ask.id)).toBeUndefined();
    expect(store.unfinishedInboundMessages()).toEqual([]);
    expect(
      await target.ownerText({ messageSid: sid(9), body: "yes", receivedAt: clock.now }),
    ).toBeUndefined();
    // A fresh text works.
    expect(await target.ownerText({ messageSid: sid(10), body: "yes", receivedAt: clock.now })).toBe(
      "Hotline: got it.",
    );
  });
});

describe("a store that refuses an answer", () => {
  it("ends the ask at once as no answer instead of leaving the agent waiting", async () => {
    const target = await orchestrator({ sms: new FakeSmsProvider({ ownerNumber: OWNER }) });
    const ask = addAsk();
    await advance(target, 20_000);
    clock.now = new Date(clock.now.getTime() + READ_MS);
    const record = store.recordAnswer.bind(store);
    store.recordAnswer = () => {
      throw new Error("refused");
    };
    const reply = await target.ownerText({ messageSid: sid(11), body: "yes", receivedAt: clock.now });
    store.recordAnswer = record;
    expect(reply).toBe("Hotline: that answer could not be recorded.");
    expect(store.getAnswer(ask.id)).toBeUndefined();
    expect(store.getAsk(ask.id)?.status).toBe("expired");
    expect(store.askEndReason(ask.id)).toBe("failed");
  });
});

describe("deadlines", () => {
  it("does not send a text for an ask that expired while an earlier send was slow", async () => {
    const sent: string[] = [];
    const slow: SmsProvider = {
      name: "fake",
      sendToOwner: async (text) => {
        sent.push(text);
        // The first send takes long enough for the next ask to expire.
        if (sent.length === 1) clock.now = new Date(clock.now.getTime() + 10 * MINUTE);
        return { messageId: sid(sent.length) };
      },
    };
    const target = await orchestrator({ sms: slow });
    addAsk({ text: "first request" });
    const late = addAsk({
      text: "second request",
      expiresAt: new Date(clock.now.getTime() + 25_000).toISOString(),
    });
    await advance(target, 20_000);
    await target.idle();
    expect(sent).toEqual([expect.stringContaining("first request")]);
    expect(store.getAsk(late.id)?.status).toBe("expired");
    expect(store.askEndReason(late.id)).toBe("timeout");
  });
});
