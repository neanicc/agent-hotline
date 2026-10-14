// Linear-time checks that hold under parallel load (HL-13). An absolute limit
// ("under 50 ms") flakes when other test files compete for the CPU. These
// checks compare timings taken side by side instead, so load slows both sides
// of each comparison alike. Each timing is the fastest of several interleaved
// runs, since load and garbage collection only ever add time.
//
// Two measures, each enough on its own to tell linear from quadratic:
//
// - ratio: hostile text against benign text of the same length. Measured on
//   the dev Mac: benign 16 KiB takes about 0.19 ms; the slowest linear hostile
//   shapes (`%E0+`, `%E0,9`: invalid UTF-8 escapes decoded byte by byte) about
//   40 to 50 times that; the quadratic truncation pattern HL-04's review
//   removed about 440 times. The old absolute limit, 50 ms, was about 270
//   times the baseline.
// - growth: the full hostile text against its first quarter. Linear work grows
//   about 4 times; quadratic work about 16 times.
//
// A check fails only when both measures say quadratic, so noise in one of them
// (a garbage collection during one run, a busy core) cannot fail it, and a
// quadratic pass still fails both by a wide margin. Inputs should be the full
// 16 KiB: a quadratic pattern's ratio shrinks with the input.

/** How many times slower than benign text of the same length hostile text may be. */
export const MAX_HOSTILE_RATIO = 100;
/** How many times longer the full hostile text may take than its first quarter. */
export const MAX_GROWTH = 8;

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
  /** Hostile time over benign time, same length (benign never taken as under 0.05 ms). */
  ratio: number;
  /** Full hostile time over the time for its first quarter (never taken as under 0.02 ms). */
  growth: number;
  /** False only when both measures say the work is quadratic. */
  linear: boolean;
}

/** How `run` scales on `hostile`; see the file comment. */
export function linearTime(run: (input: string) => unknown, hostile: string, rounds = 7): LinearTime {
  const [benign = 0, quarter = 0, full = 0] = fastestTimes(
    run,
    [benignText(hostile.length), hostile.slice(0, Math.floor(hostile.length / 4)), hostile],
    rounds,
  );
  const ratio = full / Math.max(benign, 0.05);
  const growth = full / Math.max(quarter, 0.02);
  return { ratio, growth, linear: ratio < MAX_HOSTILE_RATIO || growth < MAX_GROWTH };
}
