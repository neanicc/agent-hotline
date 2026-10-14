// Assertions for scenarios. A failed check throws `ScenarioFailure`, whose
// message is the one-line reason the runner prints. Messages name what was
// expected and what came back, never secrets: scenarios use fake values only.

export class ScenarioFailure extends Error {
  override readonly name = "ScenarioFailure";
}

/** One line, cut, so a reason never floods the report. */
export function oneLine(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return oneLine(JSON.stringify(value), 200);
  } catch {
    return String(value);
  }
}

export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ScenarioFailure(reason);
}

export function equal<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ScenarioFailure(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

export function includes(text: string | undefined, part: string, what: string): void {
  if (text === undefined || !text.includes(part)) {
    throw new ScenarioFailure(`${what}: expected it to contain ${show(part)}, got ${show(text)}`);
  }
}

/** `what` names the forbidden part; the part itself (a secret, even a fake one) is never echoed. */
export function excludes(text: string, part: string, what: string, where: string): void {
  if (text.includes(part)) throw new ScenarioFailure(`${what} reached ${where}`);
}

/** Polls `probe` until it returns a value, on the real clock. Scenario steps never wait on the fake one. */
export async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new ScenarioFailure(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
