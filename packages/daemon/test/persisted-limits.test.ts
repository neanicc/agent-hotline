// Limits and memories that must hold across a daemon restart (HL-13b): the
// PinGate's failure budgets, the forgery alarm's and the lockout text's hourly
// limits, and the server-tool delivery memory. Each test closes the store and
// opens the same database file again, as a restart does; the whole daemon
// restarting is in `restart-limits.test.ts`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSmsProvider } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORGERY_TEXT,
  ForgeryAlarm,
  type HotlineStore,
  InboundLine,
  MIGRATIONS,
  openStore,
  PIN_FAILURES_PER_DAY,
  PIN_FAILURES_PER_HOUR,
  type PinFailureLog,
  PinGate,
  storedPinFailures,
  storedToolDeliveries,
} from "../src/index.js";

const OWNER = "+15555550100";
const PIN = "4821";
const HOUR = 60 * 60 * 1000;
const START = new Date("2026-10-13T22:00:00.000Z");

let dir: string;
let path: string;
let store: HotlineStore;
let now: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-hl13b-"));
  path = join(dir, "hotline.db");
  store = await openStore(path);
  now = START;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Closes the database and opens the same file again, as a daemon restart does. */
async function reopen(): Promise<HotlineStore> {
  store.close();
  store = await openStore(path);
  return store;
}

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

describe("the HL-13b migration", () => {
  it("upgrades a database from before it and keeps its data", async () => {
    store.close();
    await rm(path);
    const old = await openStore(path, { migrations: MIGRATIONS.slice(0, 4) });
    old.putState("orchestrator", { kept: true });
    old.close();
    store = await openStore(path);
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(store.getState("orchestrator")).toEqual({ kept: true });
    expect(store.pinFailureTimes("inbound")).toEqual([]);
    expect(store.listInboundCalls()).toEqual([]);
    expect(store.countToolDeliveries(now.getTime())).toBe(0);
  });

  it("refuses a PIN failure for a direction that does not exist", () => {
    expect(() => store.addPinFailure("sideways" as "inbound", now.getTime())).toThrow();
  });
});

describe("PinGate budgets in SQLite", () => {
  const gate = (events: string[] = []) =>
    new PinGate({
      check: async (pin) => pin === PIN,
      clock: () => now,
      failures: storedPinFailures(store),
      onLockout: (direction) => events.push(direction),
    });

  /** One call that gives two wrong PINs. */
  async function wrongCall(pins: PinGate, id: string, direction: "inbound" | "outbound" = "inbound") {
    await pins.attempt(id, "0000", direction);
    await pins.attempt(id, "1111", direction);
  }

  it(`a restart does not reset the hourly budget of ${PIN_FAILURES_PER_HOUR}`, async () => {
    const first = gate();
    for (let call = 0; call < PIN_FAILURES_PER_HOUR / 2; call++) await wrongCall(first, `conv_${call}`);
    expect(store.pinFailureTimes("inbound")).toHaveLength(PIN_FAILURES_PER_HOUR);
    await reopen();
    const events: string[] = [];
    const next = gate(events);
    // Even the right PIN is refused, on a call the new run never saw.
    expect(await next.attempt("conv_new", PIN, "inbound")).toEqual({
      verified: false,
      attemptsLeft: 0,
      endCall: true,
    });
    expect(next.isVerified("conv_new")).toBe(false);
    // The other direction's budget is its own.
    expect((await next.attempt("conv_out", PIN, "outbound")).verified).toBe(true);
    advance(HOUR);
    expect((await gate().attempt("conv_later", PIN, "inbound")).verified).toBe(true);
  });

  it(`a restart does not reset the daily cap of ${PIN_FAILURES_PER_DAY}`, async () => {
    let call = 0;
    // Six in the first hour, then four more an hour later, restarting between every call.
    for (let i = 0; i < PIN_FAILURES_PER_HOUR / 2; i++) {
      await wrongCall(gate(), `conv_${call++}`);
      await reopen();
    }
    advance(HOUR);
    for (let i = 0; i < (PIN_FAILURES_PER_DAY - PIN_FAILURES_PER_HOUR) / 2; i++) {
      await wrongCall(gate(), `conv_${call++}`);
      await reopen();
    }
    expect(store.pinFailureTimes("inbound")).toHaveLength(PIN_FAILURES_PER_DAY);
    // Hours later, after another restart, the day's cap still holds.
    advance(5 * HOUR);
    await reopen();
    expect((await gate().attempt("conv_late", PIN, "inbound")).endCall).toBe(true);
    // A day after the first guesses, the oldest have aged out.
    advance(19 * HOUR);
    await reopen();
    expect((await gate().attempt("conv_next_day", PIN, "inbound")).verified).toBe(true);
  });

  it("takes back the attempt a right PIN counted, and forgets attempts older than a day", async () => {
    const pins = gate();
    await pins.attempt("conv_1", "0000", "inbound");
    expect(await pins.attempt("conv_2", PIN, "inbound")).toMatchObject({ verified: true });
    expect(store.pinFailureTimes("inbound")).toEqual([now.getTime()]);
    advance(24 * HOUR);
    await gate().attempt("conv_3", PIN, "inbound");
    expect(store.pinFailureTimes("inbound")).toEqual([]);
  });

  it("calls the lockout once the stored budget is spent", async () => {
    for (let call = 0; call < 2; call++) await wrongCall(gate(), `conv_${call}`);
    await reopen();
    const events: string[] = [];
    await wrongCall(gate(events), "conv_last");
    expect(events).toEqual(["inbound"]);
  });

  it("refuses every PIN, unchecked, when the failure log cannot be used", async () => {
    const checked: string[] = [];
    const broken: PinFailureLog = {
      add: () => {
        throw new Error("database is locked");
      },
      remove: () => {},
      times: () => [],
      prune: () => {},
    };
    const pins = new PinGate({
      check: async (pin) => {
        checked.push(pin);
        return pin === PIN;
      },
      clock: () => now,
      failures: broken,
    });
    expect(await pins.attempt("conv_1", PIN, "inbound")).toEqual({
      verified: false,
      attemptsLeft: 0,
      endCall: true,
    });
    expect(checked).toEqual([]);
    expect(pins.isVerified("conv_1")).toBe(false);
    store.close();
    const closed = new PinGate({
      check: async () => true,
      clock: () => now,
      failures: storedPinFailures(store),
    });
    expect((await closed.attempt("conv_2", PIN, "inbound")).verified).toBe(false);
    store = await openStore(path);
  });
});

describe("hourly text limits in SQLite", () => {
  it("the forgery alarm texts at most once an hour, across a restart", async () => {
    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const forgery = { forgery: true, reason: "the provider has no such record" };
    await new ForgeryAlarm({ store, clock: () => now, sms }).report("sms", "text", forgery);
    expect(sms.sent.map((s) => s.text)).toEqual([FORGERY_TEXT]);
    await reopen();
    advance(30 * 60 * 1000);
    await new ForgeryAlarm({ store, clock: () => now, sms }).report("voice", "post-call", forgery);
    expect(sms.sent).toHaveLength(1);
    // Every report is still audited.
    expect(store.listAudit().filter((e) => e.event === "security.possible-forgery")).toHaveLength(2);
    advance(HOUR);
    await reopen();
    await new ForgeryAlarm({ store, clock: () => now, sms }).report("sms", "text", forgery);
    expect(sms.sent).toHaveLength(2);
  });

  it("the forgery alarm still limits itself when the store cannot be written", async () => {
    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const alarm = new ForgeryAlarm({ store, clock: () => now, sms });
    store.close();
    const forgery = { forgery: true, reason: "the message text differs from the provider's" };
    await alarm.report("sms", "text", forgery);
    await alarm.report("sms", "text", forgery);
    expect(sms.sent).toHaveLength(1);
    store = await openStore(path);
  });

  it("the PIN lockout text goes out at most once an hour per direction, across a restart", async () => {
    const sms = new FakeSmsProvider({ ownerNumber: OWNER });
    const line = () => new InboundLine({ store, clock: () => now, redact: (text) => text, sms });
    await line().pinLockout("inbound");
    await reopen();
    advance(10 * 60 * 1000);
    await line().pinLockout("inbound");
    await line().pinLockout("outbound");
    expect(sms.sent.map((s) => s.text.slice(0, 40))).toEqual([
      "Hotline: too many wrong PINs were tried ",
      "Hotline: too many wrong PINs were given ",
    ]);
    advance(HOUR);
    await reopen();
    await line().pinLockout("inbound");
    expect(sms.sent).toHaveLength(3);
  });
});

describe("server-tool deliveries in SQLite", () => {
  it("are remembered until they expire, across a restart", async () => {
    const t = now.getTime();
    storedToolDeliveries(store).put("key-1", t + HOUR, { result: "queued" });
    await reopen();
    const deliveries = storedToolDeliveries(store);
    expect(deliveries.get("key-1", t + HOUR - 1)).toEqual({ result: "queued" });
    expect(deliveries.size(t)).toBe(1);
    expect(deliveries.get("key-2", t)).toBeUndefined();
    deliveries.prune(t);
    expect(deliveries.size(t)).toBe(1);
    expect(deliveries.get("key-1", t + HOUR)).toBeUndefined();
    deliveries.prune(t + HOUR);
    expect(store.countToolDeliveries(t)).toBe(0);
  });
});
