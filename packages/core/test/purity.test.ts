// Core is pure: it never reads the clock, sets a timer, draws randomness or does I/O.
// Callers inject the time. This scan keeps that true as the package grows.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = new URL("../src/", import.meta.url);

const FORBIDDEN: [RegExp, string][] = [
  [/Date\.now\s*\(/, "reads the wall clock"],
  [/new Date\(\s*\)/, "reads the wall clock"],
  [/performance\.now\s*\(/, "reads the clock"],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/, "sets a timer"],
  [/Math\.random\s*\(/, "draws randomness"],
  [/\bcrypto\.(randomUUID|getRandomValues|randomBytes|randomInt)\s*\(/, "draws randomness"],
  [/from\s+["']node:/, "imports a Node module (I/O belongs in the daemon)"],
  [/\brequire\s*\(/, "loads a module at run time"],
  [/\bfetch\s*\(/, "touches the network"],
  [/\bprocess\./, "reads the process environment"],
];

describe("@hotline/core purity", () => {
  const files = readdirSync(SOURCE).filter((name) => name.endsWith(".ts"));

  it("has sources to check", () => {
    expect(files).toEqual(expect.arrayContaining(["policy.ts", "queue.ts", "contracts.ts", "config.ts"]));
  });

  it.each(files)("%s does no clock, timer, randomness or I/O", (name) => {
    const text = readFileSync(new URL(name, SOURCE), "utf8");
    const found = FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, why]) => why);
    expect(found).toEqual([]);
  });
});
