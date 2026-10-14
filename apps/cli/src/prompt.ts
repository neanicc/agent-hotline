// Terminal questions for `hotline init` and `hotline test-call`. Secret answers
// (the PIN, API keys) are read without echo, so they never show on screen or in
// a terminal recording.
import { createInterface } from "node:readline";
import { type Readable, Writable } from "node:stream";

export interface Prompter {
  /** Asks one question and resolves with the trimmed answer ("" for none). Rejects when cancelled. */
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
}

export class PromptCancelled extends Error {
  override readonly name = "PromptCancelled";
  constructor() {
    super("cancelled; nothing more was changed");
  }
}

/**
 * A prompter reading `input` and writing questions to `errors`. Ctrl-C, Ctrl-D or
 * the end of `input` rejects with `PromptCancelled` instead of leaving the
 * question pending.
 */
export function readlinePrompter(
  input: Readable,
  errors: { write(text: string): unknown },
  terminal: boolean,
): Prompter {
  return {
    ask(question, { secret = false } = {}) {
      return new Promise((resolve, reject) => {
        let muted = false;
        let answered = false;
        // While muted, nothing the owner types is echoed.
        const output = new Writable({
          write(chunk, _encoding, done) {
            if (!muted) errors.write(String(chunk));
            done();
          },
        });
        const reader = createInterface({ input, output, terminal });
        reader.on("SIGINT", () => reader.close());
        reader.on("close", () => {
          if (secret) errors.write("\n");
          if (!answered) reject(new PromptCancelled());
        });
        reader.question(question, (answer) => {
          answered = true;
          reader.close();
          resolve(answer.trim());
        });
        muted = secret;
      });
    },
  };
}

/** A prompter on the process's terminal, or undefined when stdin is not a terminal. */
export function terminalPrompter(): Prompter | undefined {
  if (!process.stdin.isTTY) return undefined;
  return readlinePrompter(process.stdin, process.stderr, true);
}
