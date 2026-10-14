// Scoring against eval/thresholds.toml (human-owned; docs/eval.md "Scoring").
// The file is read strictly: anything this runner does not understand fails
// the run rather than being skipped.
import { parse } from "smol-toml";

export const MODES = ["ci", "local"] as const;
export type Mode = (typeof MODES)[number];

export interface Thresholds {
  /** The modes in which every `required` scenario must run and pass. */
  requiredIn: Mode[];
  /** Lowest share of scenarios that must pass, 0 to 1. */
  passRateMin: number;
  required: string[];
}

export class ThresholdsError extends Error {
  override readonly name = "ThresholdsError";
}

function table(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThresholdsError(`${where} must be a table`);
  }
  return value as Record<string, unknown>;
}

/** A setting this runner does not know could be a threshold it would silently skip: refuse it. */
function onlyKeys(value: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new ThresholdsError(`${where} has unknown keys: ${unknown.join(", ")}`);
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ThresholdsError(`${where} must be an array of names`);
  }
  if (new Set(value).size !== value.length) throw new ThresholdsError(`${where} lists a name twice`);
  return value as string[];
}

export function parseThresholds(text: string): Thresholds {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ThresholdsError(`not valid TOML: ${(error as Error).message.split("\n")[0]}`);
  }
  if (doc.schema !== 1) throw new ThresholdsError("schema must be 1");
  onlyKeys(doc, ["schema", "suite"], "the file");
  const suite = table(doc.suite, "[suite]");
  onlyKeys(suite, ["scenarios"], "[suite]");
  const scenarios = table(suite.scenarios, "[suite.scenarios]");
  onlyKeys(scenarios, ["required_in", "pass_rate_min", "required"], "[suite.scenarios]");
  const requiredIn = strings(scenarios.required_in, "required_in");
  const badMode = requiredIn.find((mode) => !(MODES as readonly string[]).includes(mode));
  if (badMode !== undefined) throw new ThresholdsError(`required_in has an unknown mode: ${badMode}`);
  const passRateMin = scenarios.pass_rate_min;
  if (typeof passRateMin !== "number" || !(passRateMin >= 0 && passRateMin <= 1)) {
    throw new ThresholdsError("pass_rate_min must be a number from 0 to 1");
  }
  return { requiredIn: requiredIn as Mode[], passRateMin, required: strings(scenarios.required, "required") };
}

export interface ScenarioResult {
  name: string;
  status: "pass" | "fail";
  /** Why it failed. */
  reason?: string;
  durationMs: number;
}

export interface Score {
  result: "PASS" | "FAIL";
  passed: number;
  /** Scenarios run plus required ones that did not run. */
  total: number;
  passRate: number;
  /** Required scenarios that did not run: each counts as a failure. */
  missing: string[];
  /** Why the run fails; empty when it passes. */
  reasons: string[];
}

/** PASS only when the pass rate is met and, in a required mode, every required scenario ran and passed. */
export function score(results: readonly ScenarioResult[], thresholds: Thresholds, mode: Mode): Score {
  const ran = new Set(results.map((r) => r.name));
  const missing = thresholds.required.filter((name) => !ran.has(name));
  const passed = results.filter((r) => r.status === "pass").length;
  const total = results.length + missing.length;
  const passRate = total === 0 ? 0 : passed / total;
  const reasons: string[] = [];
  if (results.length === 0) reasons.push("no scenario ran");
  if (passRate < thresholds.passRateMin) {
    reasons.push(`pass rate ${passRate.toFixed(3)} is below pass_rate_min ${thresholds.passRateMin}`);
  }
  if (thresholds.requiredIn.includes(mode)) {
    for (const name of missing) reasons.push(`required scenario ${name} did not run`);
    for (const r of results) {
      if (r.status === "fail" && thresholds.required.includes(r.name)) {
        reasons.push(`required scenario ${r.name} failed`);
      }
    }
  }
  return { result: reasons.length === 0 ? "PASS" : "FAIL", passed, total, passRate, missing, reasons };
}
