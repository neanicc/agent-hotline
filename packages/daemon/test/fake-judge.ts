// A judge for tests (HL-09c): scripted verdicts, errors and hangs, with every
// input recorded so tests can check the judge never sees agent-written text.
import type { ReplyJudge, ReplyVerdict } from "../src/index.js";

/** A scripted step for `FakeJudge`: a verdict, an error to throw, or `hang` (never answers). */
export type FakeJudgeStep = ReplyVerdict | Error | "hang";

/** A judge for tests: answers with scripted steps in order (then `unclear`) and records every input. */
export class FakeJudge implements ReplyJudge {
  /** Every reply it was asked about, oldest first. */
  readonly inputs: (readonly string[])[] = [];
  readonly #steps: FakeJudgeStep[];

  constructor(...steps: FakeJudgeStep[]) {
    this.#steps = steps;
  }

  judge(reply: readonly string[]): Promise<ReplyVerdict> {
    this.inputs.push([...reply]);
    const step = this.#steps.shift() ?? "unclear";
    if (step instanceof Error) return Promise.reject(step);
    if (step === "hang") return new Promise<ReplyVerdict>(() => {});
    return Promise.resolve(step);
  }
}
