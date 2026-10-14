// The suite's self-test (docs/eval.md, "Scoring"): a deliberately broken build
// that approves everything must fail at least silence-denies,
// high-risk-needs-pin and agent-text-cannot-self-approve. The fault is the
// always-approve proxy in src/fault.ts, switched on only by the runner's
// `fault` option. These run the real daemon and the built CLI
// (apps/cli/dist), like the suite itself.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runScenarios } from "../src/suite.js";

/** In the suite's order (docs/eval.md's table), which is the order they run in. */
const MUST_CATCH = ["high-risk-needs-pin", "silence-denies", "agent-text-cannot-self-approve"];

describe("a build that approves everything", () => {
  it("fails silence-denies, high-risk-needs-pin and agent-text-cannot-self-approve", async () => {
    const faulted = await runScenarios({ only: MUST_CATCH, fault: "always-approve" });
    expect(faulted.map((r) => [r.name, r.status])).toEqual(MUST_CATCH.map((name) => [name, "fail"]));
    for (const result of faulted) expect(result.reason, result.name).toMatch(/\S/);
    // The same scenarios pass on the real build, so the fault is what they caught.
    const clean = await runScenarios({ only: MUST_CATCH });
    expect(clean.map((r) => [r.name, r.status, r.reason])).toEqual(
      MUST_CATCH.map((name) => [name, "pass", undefined]),
    );
  }, 240_000);
});

describe("the runner", () => {
  async function runner(args: string[], thresholds: string) {
    const dir = await mkdtemp(join(tmpdir(), "hotline-scenarios-cli-"));
    try {
      const file = join(dir, "thresholds.toml");
      await writeFile(file, thresholds);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(["--", ...args, "--thresholds", file, "--out", join(dir, "out")], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      const report = JSON.parse(await readFile(join(dir, "out", "report.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const text = await readFile(join(dir, "out", "report.txt"), "utf8");
      return { code, stdout, stderr, report, text };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const lenient = (required: string[]) =>
    `schema = 1\n[suite.scenarios]\nrequired_in = ["ci"]\npass_rate_min = 1.0\nrequired = ${JSON.stringify(required)}\n`;

  it("prints one line per scenario, then exactly THRESHOLDS: PASS, and writes the report", async () => {
    const run = await runner(
      ["--mode", "ci", "--only", "permission-approved"],
      lenient(["permission-approved"]),
    );
    expect(run.stdout).toEqual([
      expect.stringMatching(/^PASS permission-approved \(\d+\.\d s\)$/),
      "THRESHOLDS: PASS",
    ]);
    expect(run.code).toBe(0);
    expect(run.report).toMatchObject({ result: "PASS", mode: "ci", passed: 1, total: 1, missing: [] });
    expect(run.text).toBe(`${run.stdout.join("\n")}\n`);
  }, 60_000);

  it("fails a required scenario that did not run", async () => {
    const run = await runner(
      ["--mode", "ci", "--only", "permission-approved"],
      lenient(["permission-approved", "silence-denies", "no-such-scenario"]),
    );
    expect(run.stdout).toEqual([
      expect.stringMatching(/^PASS permission-approved/),
      "FAIL silence-denies: not run (left out of this run)",
      "FAIL no-such-scenario: not run (the suite has no such scenario)",
      "THRESHOLDS: FAIL",
    ]);
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({ result: "FAIL", missing: ["silence-denies", "no-such-scenario"] });
  }, 60_000);

  it("never passes a faulted run, even when every scenario it ran passed", async () => {
    // permission-approved expects an allow, which the fault also gives.
    const run = await runner(
      ["--mode", "ci", "--only", "permission-approved", "--fault", "always-approve"],
      lenient(["permission-approved"]),
    );
    expect(run.stdout.at(-1)).toBe("THRESHOLDS: FAIL");
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({ result: "FAIL", fault: "always-approve" });
  }, 60_000);

  it("fails when the thresholds file cannot be used", async () => {
    const run = await runner(["--mode", "ci", "--only", "permission-approved"], "schema = 2\n");
    expect(run.stdout.at(-1)).toBe("THRESHOLDS: FAIL");
    expect(run.stderr.join("\n")).toContain("schema must be 1");
    expect(run.code).toBe(1);
  }, 60_000);

  it("refuses unknown options and scenario names", async () => {
    const out = { stdout: () => {}, stderr: () => {} };
    expect(await main(["--mode", "nightly"], out)).toBe(2);
    expect(await main(["--only", "no-such-scenario"], out)).toBe(2);
    expect(await main(["--fault", "approve-some"], out)).toBe(2);
    expect(await main(["--verbose", "yes"], out)).toBe(2);
  });
});
