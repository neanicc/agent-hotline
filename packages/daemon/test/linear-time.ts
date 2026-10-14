// Linear-time checks that hold under parallel load (HL-13). An absolute limit
// ("under 50 ms") flakes when other test files compete for the CPU; a ratio to
// a benign input of the same length does not, because load slows both alike.
// Each side is timed as the fastest of several interleaved runs, since load
// and garbage collection only ever add time.
//
// Measured on the dev Mac (HL-13): benign 16 KiB takes about 0.19 ms; the
// slowest linear hostile shape (`%E0+`, invalid UTF-8 escapes decoded byte by
// byte) is about 40 times that; the quadratic truncation pattern that HL-04's
// review removed is about 440 times. The old absolute limit, 50 ms, was about
// 270 times the baseline, so this ratio is stricter than it was on an idle
// machine and stays the same on a busy one. Inputs must be the full 16 KiB:
// a quadratic pattern's ratio shrinks with the input.

/** How many times slower than benign text of the same length hostile text may be. */
export const MAX_HOSTILE_RATIO = 100;

/** Benign log-like text: words, spaces and punctuation, no names, numbers or escapes that trigger a pass. */
export function benignText(length: number): string {
  const unit = "the agent finished reading the files, then waited for the owner. ";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** How long one run of `work` takes, in milliseconds. */
function timed(work: () => unknown): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

/**
 * How many times longer `run` takes on `hostile` than on benign text of the
 * same length. The baseline is never taken as under 0.05 ms, so timer
 * resolution cannot inflate the ratio.
 */
export function hostileRatio(run: (input: string) => unknown, hostile: string, runs = 7): number {
  const benign = benignText(hostile.length);
  // Warm both paths up so the first run's compilation counts for neither.
  run(benign);
  run(hostile);
  let benignBest = Number.POSITIVE_INFINITY;
  let hostileBest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    benignBest = Math.min(
      benignBest,
      timed(() => run(benign)),
    );
    hostileBest = Math.min(
      hostileBest,
      timed(() => run(hostile)),
    );
  }
  return hostileBest / Math.max(benignBest, 0.05);
}
