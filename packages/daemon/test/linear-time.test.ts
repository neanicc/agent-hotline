// Negative controls for the linear-time helper (HL-13): the retries and the
// fastest-of-several measurement must never let quadratic work through, even
// quadratic work that stays under the old 50 ms bound.
import { describe, expect, it } from "vitest";
import { benignText, linearTime, MAX_GROWTH } from "./linear-time.js";

const HOSTILE = "eyJ-".repeat(4096);

let sink = 0;

/** Compares character pairs `stride` apart over the whole input: quadratic in its length. */
function quadratic(input: string, stride: number): number {
  let count = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    for (let j = i + 1; j < input.length; j += stride) if (input.charCodeAt(j) === c) count++;
  }
  return count;
}

/** One pass over the input: linear. */
function linear(input: string): number {
  let count = 0;
  for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) === 101) count++;
  return count;
}

/** Quadratic only on the hostile shape, as a redactor pass with a bad pattern would be. */
const onHostile = (stride: number) => (input: string) => {
  sink += input.startsWith("eyJ") ? quadratic(input, stride) : linear(input);
};

describe("linearTime negative controls", { timeout: 60_000 }, () => {
  it("passes linear work", () => {
    expect(linearTime((input) => (sink += linear(input)), HOSTILE)).toMatchObject({ linear: true });
  });

  it("fails quadratic work that is slow on 16 KiB", () => {
    expect(linearTime(onHostile(1), HOSTILE)).toMatchObject({ linear: false });
  });

  it("fails quadratic work that stays under the old 50 ms bound", () => {
    // A stride of 16 takes about 13 ms for the full text on the dev Mac, under
    // the absolute bound but well above the growth floor, and grows about 16x.
    const measured = linearTime(onHostile(16), HOSTILE);
    expect(measured.linear).toBe(false);
    expect(measured.growth).toBeGreaterThan(MAX_GROWTH);
  });

  it("measures benign text that never takes the hostile path", () => {
    expect(benignText(HOSTILE.length).startsWith("eyJ")).toBe(false);
    expect(sink).toBeGreaterThan(0);
  });
});
