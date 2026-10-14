// HL-13b end to end: the real daemon (`runDaemon`, real routes, real store)
// with the fake providers, stopped and started again on the same hotline home.
// A restart must not hand a PIN guesser a fresh budget. (The lockout text's
// hourly limit across a restart is in `persisted-limits.test.ts`.) Fake clock;
// nothing leaves 127.0.0.1.
//
// Each run's fake ElevenLabs numbers its conversations from 1 again, so the
// wrong PINs differ from call to call: an identical tool call within two hours
// is a replay, answered from the stored delivery memory without counting.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HumanStep, scriptedHuman } from "@hotline/providers";
import { afterEach, describe, expect, it } from "vitest";
import { PIN_FAILURES_PER_DAY, PIN_FAILURES_PER_HOUR } from "../src/index.js";
import { type Hotline, PIN, startHotline } from "./hotline-harness.js";

const HOUR = 60 * 60 * 1000;
/** Longer than the server-tool replay memory (two hours). */
const PAST_REPLAY_MS = 2 * HOUR + 1;

let hotline: Hotline | undefined;
let dir: string | undefined;
let guesses = 0;

afterEach(async () => {
  await hotline?.stop();
  hotline = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Stops the running daemon (if any) and starts the next on the same home, where the clock left off. */
async function restart(): Promise<Hotline> {
  dir ??= await mkdtemp(join(tmpdir(), "hotline-hl13b-restart-"));
  const start = hotline?.clock.now;
  if (hotline !== undefined) expect(await hotline.stop()).toBe(0);
  hotline = await startHotline({ dir, toolStepMs: 1_000, ...(start === undefined ? {} : { start }) });
  return hotline;
}

const pin = (digits: string): HumanStep => ({ kind: "pin", digits });
/** A wrong PIN not used before in this file. */
const wrong = () => String(1000 + ++guesses);

/** An inbound call that tries `pins` in turn, then asks for the status; returns what each tool answered. */
async function call(h: Hotline, ...pins: string[]) {
  const played = await h.voice.inboundCall(scriptedHuman.says(...pins.map(pin), { kind: "status" }));
  await h.settle();
  return played.tools.map((t) => [t.tool, t.response.verified ?? t.response.result, t.response.end_call]);
}

/** A call that spends its two attempts on wrong PINs. */
const wrongCall = (h: Hotline) => call(h, wrong(), wrong());

const lockouts = (h: Hotline) => h.daemon.store.listAudit().filter((e) => e.event === "voice.pin-lockout");

describe("PIN budgets across a daemon restart", () => {
  it(`keep the hourly budget of ${PIN_FAILURES_PER_HOUR}`, async () => {
    let h = await restart();
    for (let i = 0; i < PIN_FAILURES_PER_HOUR / 2; i++) {
      expect((await wrongCall(h)).map(([, verified]) => verified)).toEqual([false, false]);
      h = await restart();
    }
    // The previous runs spent the hour's budget.
    expect(lockouts(h)).toHaveLength(1);
    // The right PIN on a new call to the new run is still refused, unchecked.
    expect(await call(h, PIN)).toEqual([["verify_pin", false, true]]);
    expect(await call(h, wrong())).toEqual([["verify_pin", false, true]]);
    expect(lockouts(h)).toHaveLength(1);
    // Once the hour has passed, the owner gets in again.
    await h.advance(PAST_REPLAY_MS);
    h = await restart();
    expect(await call(h, PIN)).toEqual([
      ["verify_pin", true, false],
      ["get_status", "ok", undefined],
    ]);
  });

  it(`keep the daily cap of ${PIN_FAILURES_PER_DAY}`, async () => {
    let h = await restart();
    for (let i = 0; i < PIN_FAILURES_PER_HOUR / 2; i++) await wrongCall(h);
    await h.advance(HOUR);
    h = await restart();
    for (let i = 0; i < (PIN_FAILURES_PER_DAY - PIN_FAILURES_PER_HOUR) / 2; i++) await wrongCall(h);
    await h.advance(3 * HOUR);
    h = await restart();
    // The hourly lockout in the first run, then the daily one in the second.
    expect(lockouts(h)).toHaveLength(2);
    expect(await call(h, PIN)).toEqual([["verify_pin", false, true]]);
  });

  it("answers a replayed guess after a restart from memory, without counting it", async () => {
    let h = await restart();
    await call(h, "1111");
    h = await restart();
    // The new run's first call is the same conversation id, call SID and PIN: a replay.
    expect(await call(h, "1111")).toEqual([
      ["verify_pin", false, false],
      ["get_status", "pin-required", undefined],
    ]);
    expect(h.daemon.store.pinFailureTimes("inbound")).toHaveLength(1);
  });
});
