// Linear-time checks that hold under parallel load (HL-13). A single timed run
// against "under 50 ms" flaked when other test files competed for the CPU
// (HL-10). These checks keep that bound and add two more, but measure each
// side as the fastest of several interleaved runs (load and garbage collection
// only ever add time) and allow a few attempts. One attempt must meet all three:
//
// - absolute: the full hostile text in under `MAX_HOSTILE_MS`, the old bound;
// - ratio: hostile text against benign text of the same length. Measured on
//   the dev Mac: benign 16 KiB takes about 0.19 ms; the slowest linear hostile
//   shapes (`%E0+`, `%E0,9`: invalid UTF-8 escapes decoded byte by byte) about
//   40 to 50 times that; the quadratic truncation pattern HL-04's review
//   removed about 440 times;
// - growth: the full hostile text against its first quarter. Linear work grows
//   about 4 times; quadratic work about 16 times.
//
// So it is at least as strict as the old check, and a quadratic pass that
// happens to stay under 50 ms still fails on growth. Inputs should be the full
// 16 KiB: a quadratic pattern's ratio shrinks with the input.

/** The old absolute bound for 16 KiB of hostile text, in milliseconds. */
export const MAX_HOSTILE_MS = 50;
/** How many times slower than benign text of the same length hostile text may be. */
export const MAX_HOSTILE_RATIO = 100;
/** How many times longer the full hostile text may take than its first quarter. */
export const MAX_GROWTH = 8;
/** Below this full-input time, in milliseconds, growth is not judged. */
const GROWTH_FLOOR_MS = 2;
/** Measurements tried before a check fails; noise only ever makes one slower. */
const ATTEMPTS = 5;

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

/** The fastest time of `run` on each input, measured in interleaved rounds. */
function fastestTimes(run: (input: string) => unknown, inputs: readonly string[], rounds: number): number[] {
  // Warm every path up so the first run's compilation counts for none.
  for (const input of inputs) run(input);
  const best = inputs.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < rounds; round++) {
    inputs.forEach((input, i) => {
      best[i] = Math.min(
        best[i] ?? Number.POSITIVE_INFINITY,
        timed(() => run(input)),
      );
    });
  }
  return best;
}

export interface LinearTime {
  /** The fastest time for the full hostile text, in milliseconds. */
  ms: number;
  /** Hostile time over benign time, same length (benign never taken as under 0.05 ms). */
  ratio: number;
  /** Full hostile time over the time for its first quarter (never taken as under 0.02 ms). */
  growth: number;
  /** True when one attempt met the absolute bound, the ratio and the growth limit together. */
  linear: boolean;
}

/** How `run` scales on `hostile`; see the file comment. Returns the passing attempt, or the last one. */
export function linearTime(run: (input: string) => unknown, hostile: string, rounds = 7): LinearTime {
  const inputs = [benignText(hostile.length), hostile.slice(0, Math.floor(hostile.length / 4)), hostile];
  let last: LinearTime | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const [benign = 0, quarter = 0, full = 0] = fastestTimes(run, inputs, rounds);
    const ratio = full / Math.max(benign, 0.05);
    const growth = full / Math.max(quarter, 0.02);
    // Under `GROWTH_FLOOR_MS` the quarter's time is too close to timer noise to
    // compare; a quadratic pass over 16 KiB takes tens of milliseconds anyway.
    const grows = growth < MAX_GROWTH || full < GROWTH_FLOOR_MS;
    const linear = full < MAX_HOSTILE_MS && ratio < MAX_HOSTILE_RATIO && grows;
    last = { ms: full, ratio, growth, linear };
    if (linear) return last;
  }
  return last as LinearTime;
}
