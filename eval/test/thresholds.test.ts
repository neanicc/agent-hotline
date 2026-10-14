// Scoring against eval/thresholds.toml, and the suite's coverage of docs/eval.md.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../src/scenarios/index.js";
import { parseThresholds, type ScenarioResult, score, ThresholdsError } from "../src/thresholds.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const pass = (name: string): ScenarioResult => ({ name, status: "pass", durationMs: 1 });
const fail = (name: string): ScenarioResult => ({ name, status: "fail", reason: "broken", durationMs: 1 });

const THRESHOLDS = {
  requiredIn: ["ci", "local"] as ("ci" | "local")[],
  passRateMin: 1,
  required: ["a", "b"],
};

describe("eval/thresholds.toml", () => {
  it("parses the human-owned file", () => {
    const thresholds = parseThresholds(read("eval/thresholds.toml"));
    expect(thresholds.requiredIn).toEqual(["ci", "local"]);
    expect(thresholds.passRateMin).toBe(1);
    expect(thresholds.required.length).toBeGreaterThanOrEqual(22);
  });

  it("has a scenario in the suite for every required name", () => {
    const names = new Set(SCENARIOS.map((s) => s.name));
    const required = parseThresholds(read("eval/thresholds.toml")).required;
    expect(required.filter((name) => !names.has(name))).toEqual([]);
  });

  it("implements exactly the scenarios docs/eval.md lists", () => {
    const listed = [...read("docs/eval.md").matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(listed).toHaveLength(22);
    expect(SCENARIOS.map((s) => s.name)).toEqual(listed);
  });

  it("refuses a file it does not fully understand", () => {
    const base =
      'schema = 1\n[suite.scenarios]\nrequired_in = ["ci"]\npass_rate_min = 1.0\nrequired = ["a"]\n';
    expect(parseThresholds(base).required).toEqual(["a"]);
    for (const broken of [
      "schema = [",
      base.replace("schema = 1", "schema = 2"),
      base.replace('required_in = ["ci"]', 'required_in = ["nightly"]'),
      base.replace("pass_rate_min = 1.0", "pass_rate_min = 1.5"),
      base.replace("pass_rate_min = 1.0", 'pass_rate_min = "1"'),
      base.replace('required = ["a"]', 'required = ["a", "a"]'),
      base.replace('required = ["a"]', "required = [1]"),
      `${base}timeout_seconds = 5\n`,
      "schema = 1\n",
    ]) {
      expect(() => parseThresholds(broken), broken).toThrow(ThresholdsError);
    }
  });
});

describe("score", () => {
  it("passes only when every required scenario ran and passed", () => {
    expect(score([pass("a"), pass("b")], THRESHOLDS, "ci")).toMatchObject({ result: "PASS", passRate: 1 });
    expect(score([pass("a"), fail("b")], THRESHOLDS, "ci")).toMatchObject({
      result: "FAIL",
      reasons: ["pass rate 0.500 is below pass_rate_min 1", "required scenario b failed"],
    });
  });

  it("counts a missing required scenario as a failure", () => {
    const scored = score([pass("a")], THRESHOLDS, "local");
    expect(scored).toMatchObject({ result: "FAIL", missing: ["b"], total: 2, passed: 1 });
    expect(scored.reasons).toContain("required scenario b did not run");
    // Even when the pass rate alone would allow it.
    expect(score([pass("a")], { ...THRESHOLDS, passRateMin: 0.5 }, "ci").result).toBe("FAIL");
  });

  it("applies the required list only in its modes, and the pass rate always", () => {
    const ciOnly = { ...THRESHOLDS, requiredIn: ["ci" as const], passRateMin: 0.5 };
    expect(score([pass("a"), fail("b")], ciOnly, "local").result).toBe("PASS");
    expect(score([pass("a"), fail("b")], ciOnly, "ci").result).toBe("FAIL");
    expect(score([fail("a"), fail("b")], ciOnly, "local").result).toBe("FAIL");
  });

  it("never passes a run in which nothing ran", () => {
    expect(score([], { ...THRESHOLDS, required: [], passRateMin: 0 }, "ci")).toMatchObject({
      result: "FAIL",
      reasons: ["no scenario ran"],
    });
  });
});
