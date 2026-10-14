// Judges for tests (HL-09c, HL-09d): scripted verdicts, errors and hangs, with
// every input recorded so tests can check the judge never sees agent-written
// text; and a fake `JudgeHost` that plays the Claude Code or Codex CLI, so no
// real agent CLI ever runs.
import { readdir, writeFile } from "node:fs/promises";
import type {
  ExecResult,
  JudgeHost,
  JudgeOutput,
  JudgeRunOptions,
  ReplyJudge,
  ReplyVerdict,
} from "../src/index.js";

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

/** One run of a fake agent CLI, as the judge made it. */
export interface FakeRun {
  file: string;
  args: readonly string[];
  options: JudgeRunOptions;
  /** What the run's cwd held when it started (it must be empty). */
  cwdEntries: string[];
  /** The owner's reply turns, read back out of the prompt's reply markers. */
  reply: readonly string[];
}

/** What the scripted model answers: its JSON answer, raw CLI output, an error, or `hang`. */
export type FakeAnswer = JudgeOutput | { raw: ExecResult } | Error | "hang";

/** Reads the reply turns out of a judge prompt (`judgePrompt`). */
export function replyInPrompt(prompt: string): readonly string[] {
  const match = /<reply>\n(.*)\n<\/reply>/s.exec(prompt);
  return match?.[1] === undefined ? [] : (JSON.parse(match[1]) as string[]);
}

/** `claude -p --output-format json` output carrying `result` as its answer text. */
export function claudeResult(result: string, isError = false): ExecResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: isError, result }),
    stderr: "",
  };
}

/**
 * Plays the agent CLIs: `find` returns the configured paths, and `run`
 * records the call and answers with what `answer` returns for the reply. For
 * Codex, the answer is written to the `--output-last-message` file, as Codex does.
 */
export class FakeJudgeHost implements JudgeHost {
  readonly runs: FakeRun[] = [];
  readonly found: string[] = [];

  constructor(
    private readonly paths: Readonly<Record<string, string>>,
    private readonly answer: (reply: readonly string[]) => FakeAnswer = () => ({
      verdict: "unclear",
      conditional: false,
      retracted: false,
    }),
  ) {}

  async find(command: string): Promise<string | undefined> {
    this.found.push(command);
    return this.paths[command];
  }

  async run(file: string, args: readonly string[], options: JudgeRunOptions): Promise<ExecResult> {
    const reply = replyInPrompt(options.input);
    this.runs.push({ file, args, options, cwdEntries: await readdir(options.cwd), reply });
    const answer = this.answer(reply);
    if (answer instanceof Error) throw answer;
    if (answer === "hang") return new Promise<ExecResult>(() => {});
    if ("raw" in answer) return answer.raw;
    const text = JSON.stringify(answer);
    const codexOut = args.indexOf("--output-last-message");
    if (codexOut >= 0) {
      await writeFile(args[codexOut + 1] as string, text);
      return { exitCode: 0, stdout: text, stderr: "" };
    }
    return claudeResult(text);
  }
}
