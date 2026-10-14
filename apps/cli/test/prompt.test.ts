// The readline prompter behind `hotline init` and `test-call`, on in-memory streams.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PromptCancelled, readlinePrompter } from "../src/prompt.js";

function streams() {
  const input = new PassThrough();
  const written: string[] = [];
  return { input, written, errors: { write: (text: string) => written.push(text) } };
}

describe("readlinePrompter", () => {
  it("resolves with the trimmed answer and writes the question", async () => {
    const { input, written, errors } = streams();
    const answer = readlinePrompter(input, errors, false).ask("Number? ");
    input.write("  +15555550100  \n");
    await expect(answer).resolves.toBe("+15555550100");
    expect(written.join("")).toContain("Number? ");
  });

  it("never echoes a secret answer", async () => {
    const { input, written, errors } = streams();
    const answer = readlinePrompter(input, errors, true).ask("PIN: ", { secret: true });
    input.write("482913\r");
    await expect(answer).resolves.toBe("482913");
    expect(written.join("")).not.toContain("482913");
  });

  it("rejects when the input ends or is interrupted instead of hanging", async () => {
    const ended = streams();
    const pending = readlinePrompter(ended.input, ended.errors, false).ask("PIN: ", { secret: true });
    ended.input.end();
    await expect(pending).rejects.toBeInstanceOf(PromptCancelled);

    const interrupted = streams();
    const asked = readlinePrompter(interrupted.input, interrupted.errors, true).ask("Type yes: ");
    interrupted.input.write("\u0003");
    await expect(asked).rejects.toBeInstanceOf(PromptCancelled);
  });
});
