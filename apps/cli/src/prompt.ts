// Terminal questions for `hotline init` and `hotline test-call`. Secret answers
// (the PIN, API keys) are read without echo, so they never show on screen or in
// a terminal recording.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface Prompter {
  /** Asks one question and resolves with the trimmed answer ("" for none). */
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
}

/** A prompter on the process's terminal, or undefined when stdin is not a terminal. */
export function terminalPrompter(): Prompter | undefined {
  if (!process.stdin.isTTY) return undefined;
  return {
    ask(question, { secret = false } = {}) {
      return new Promise((resolve) => {
        let muted = false;
        // Prompts go to stderr, like the rest of the command's messages; while
        // muted, nothing the owner types is echoed.
        const output = new Writable({
          write(chunk, _encoding, done) {
            if (!muted) process.stderr.write(chunk);
            done();
          },
        });
        const reader = createInterface({ input: process.stdin, output, terminal: true });
        reader.question(question, (answer) => {
          reader.close();
          if (secret) process.stderr.write("\n");
          resolve(answer.trim());
        });
        muted = secret;
      });
    },
  };
}
