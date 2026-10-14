import { describe, expect, it } from "vitest";
import { hashPin, PIN_ATTEMPTS_PER_CALL, PIN_FAILURES_PER_HOUR, PinGate, verifyPin } from "../src/index.js";

describe("verifyPin", () => {
  it("accepts the PIN its hash was made from, and nothing else", async () => {
    const hash = await hashPin("4821");
    expect(hash).toMatch(/^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPin("4821", hash)).toBe(true);
    expect(await verifyPin("4822", hash)).toBe(false);
    expect(await verifyPin("48210", hash)).toBe(false);
  });

  it.each(["", "482", "123456789", "48 21", "four", "４８２１"])(
    "refuses the malformed PIN %j",
    async (pin) => {
      expect(await verifyPin(pin, await hashPin("4821"))).toBe(false);
    },
  );

  it("fails closed on a malformed or out-of-range hash", async () => {
    expect(await verifyPin("4821", "plain:4821")).toBe(false);
    expect(await verifyPin("4821", `scrypt$14$8$1$${"s".repeat(22)}$${"h".repeat(43)}`)).toBe(false);
  });

  it("refuses to hash a malformed PIN", async () => {
    await expect(hashPin("12")).rejects.toThrow(TypeError);
  });
});

function gate(pin = "4821", start = new Date("2026-10-13T22:00:00.000Z")) {
  let now = start;
  const learned: string[] = [];
  const checks: string[] = [];
  const pins = new PinGate({
    check: async (spoken) => {
      checks.push(spoken);
      return spoken === pin;
    },
    clock: () => now,
    onVerified: (spoken) => learned.push(spoken),
  });
  return {
    pins,
    learned,
    checks,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("PinGate", () => {
  it("verifies a call with the right PIN and tells the redactor", async () => {
    const { pins, learned } = gate();
    expect(pins.isVerified("conv_1")).toBe(false);
    expect(await pins.attempt("conv_1", "48 21", "inbound")).toEqual({
      verified: true,
      attemptsLeft: 2,
      endCall: false,
    });
    expect(pins.isVerified("conv_1")).toBe(true);
    expect(pins.isVerified("conv_2")).toBe(false);
    expect(learned).toEqual(["4821"]);
  });

  it(`ends the call after ${PIN_ATTEMPTS_PER_CALL} wrong PINs and never checks another`, async () => {
    const { pins, checks } = gate();
    expect(await pins.attempt("conv_1", "1111", "inbound")).toEqual({
      verified: false,
      attemptsLeft: 1,
      endCall: false,
    });
    expect(await pins.attempt("conv_1", "2222", "inbound")).toEqual({
      verified: false,
      attemptsLeft: 0,
      endCall: true,
    });
    expect(await pins.attempt("conv_1", "4821", "inbound")).toEqual({
      verified: false,
      attemptsLeft: 0,
      endCall: true,
    });
    expect(checks).toEqual(["1111", "2222"]);
    expect(pins.isVerified("conv_1")).toBe(false);
  });

  it("allows the right PIN after one wrong one", async () => {
    const { pins } = gate();
    await pins.attempt("conv_1", "1111", "inbound");
    expect(await pins.attempt("conv_1", "4821", "inbound")).toEqual({
      verified: true,
      attemptsLeft: 1,
      endCall: false,
    });
  });

  it("does not let concurrent guesses exceed the limit", async () => {
    const { pins, checks } = gate();
    const results = await Promise.all(
      ["1", "2", "3", "4", "5"].map((d) => pins.attempt("conv_1", d.repeat(4), "inbound")),
    );
    expect(checks).toHaveLength(PIN_ATTEMPTS_PER_CALL);
    expect(results.every((r) => !r.verified && r.endCall)).toBe(true);
  });

  it(`locks every PIN check, the right PIN too, after ${PIN_FAILURES_PER_HOUR} failures in an hour`, async () => {
    const { pins, advance } = gate();
    for (let i = 0; i < PIN_FAILURES_PER_HOUR / PIN_ATTEMPTS_PER_CALL; i += 1) {
      await pins.attempt(`conv_${i}`, "0000", "inbound");
      await pins.attempt(`conv_${i}`, "0000", "inbound");
    }
    expect(await pins.attempt("conv_new", "4821", "inbound")).toEqual({
      verified: false,
      attemptsLeft: 0,
      endCall: true,
    });
    advance(59 * 60 * 1000);
    expect((await pins.attempt("conv_new2", "4821", "inbound")).verified).toBe(false);
    advance(2 * 60 * 1000);
    expect((await pins.attempt("conv_new3", "4821", "inbound")).verified).toBe(true);
  });

  it("keeps inbound guessing from locking the PIN on calls Hotline placed, and the other way round", async () => {
    const { pins } = gate();
    for (let i = 0; i < PIN_FAILURES_PER_HOUR; i += 1) await pins.attempt(`conv_in_${i}`, "0000", "inbound");
    expect((await pins.attempt("conv_in_x", "4821", "inbound")).verified).toBe(false);
    expect((await pins.attempt("conv_out", "4821", "outbound")).verified).toBe(true);
    // A call keeps the budget of its first attempt.
    expect((await pins.attempt("conv_in_0", "4821", "outbound")).verified).toBe(false);
  });

  it("keeps counting failures stamped in the future when the clock moves back", async () => {
    const { pins, advance } = gate();
    for (let i = 0; i < PIN_FAILURES_PER_HOUR; i += 1) await pins.attempt(`conv_${i}`, "0000", "inbound");
    advance(-3 * 60 * 60 * 1000);
    expect((await pins.attempt("conv_x", "4821", "inbound")).verified).toBe(false);
  });

  it("treats a failing check as a wrong PIN", async () => {
    const pins = new PinGate({
      check: async () => Promise.reject(new Error("scrypt")),
      clock: () => new Date(),
    });
    expect(await pins.attempt("conv_1", "4821", "inbound")).toMatchObject({ verified: false });
  });

  it("forgets a verification after two hours", async () => {
    const { pins, advance } = gate();
    await pins.attempt("conv_1", "4821", "inbound");
    advance(2 * 60 * 60 * 1000);
    expect(pins.isVerified("conv_1")).toBe(false);
  });
});
