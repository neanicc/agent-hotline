// The scenario runner's command line (docs/eval.md):
//
//   node eval/dist/main.js --mode <ci|local> --thresholds eval/thresholds.toml --out eval-out
//
// It prints one line per scenario (PASS, or FAIL with the reason), then exactly
// one of `THRESHOLDS: PASS` or `THRESHOLDS: FAIL`, and writes `report.json` and
// `report.txt` to the --out folder. Exit code 0 only for THRESHOLDS: PASS.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAULTS, type Fault } from "./fault.js";
import { runScenarios, SCENARIOS } from "./suite.js";
import {
  MODES,
  type Mode,
  parseThresholds,
  type ScenarioResult,
  score,
  type Thresholds,
} from "./thresholds.js";

export interface Output {
  stdout(line: string): void;
  stderr(line: string): void;
}

export function usage(): string {
  return [
    "Usage: hotline-scenarios [--mode ci|local] [--thresholds <file>] [--out <dir>] [--only <a,b,...>]",
    "",
    "Runs the scenario suite (docs/eval.md) against the real daemon, MCP server and hooks",
    "with fake providers and scripted humans, and scores it against the thresholds file.",
    "",
    "  --mode <ci|local>     Which required_in mode to score as (default local)",
    "  --thresholds <file>   Default eval/thresholds.toml",
    "  --out <dir>           Where report.json and report.txt go (default eval-out)",
    "  --only <names>        Run only these scenarios; every other required one counts as not run",
    `  --fault <name>        Self-test only: inject a fault (${FAULTS.join(", ")}); never passes`,
  ].join("\n");
}

interface Args {
  mode: Mode;
  thresholds: string;
  out: string;
  only?: string[];
  fault?: Fault;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { mode: "local", thresholds: "eval/thresholds.toml", out: "eval-out" };
  // `pnpm run eval -- ...` may pass the separator through.
  const list = argv[0] === "--" ? argv.slice(1) : [...argv];
  for (let index = 0; index < list.length; index++) {
    const flag = list[index];
    const value = list[index + 1];
    if (flag === "--help" || flag === "-h") return "help";
    if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
    index += 1;
    if (flag === "--mode") {
      if (!(MODES as readonly string[]).includes(value)) return `--mode must be ${MODES.join(" or ")}`;
      args.mode = value as Mode;
    } else if (flag === "--thresholds") {
      args.thresholds = value;
    } else if (flag === "--out") {
      args.out = value;
    } else if (flag === "--only") {
      const names = value.split(",").map((name) => name.trim());
      if (names.some((name) => name === "")) return "--only needs scenario names separated by commas";
      const unknown = names.filter((name) => !SCENARIOS.some((s) => s.name === name));
      if (unknown.length > 0) return `--only names unknown scenarios: ${unknown.join(", ")}`;
      args.only = names;
    } else if (flag === "--fault") {
      if (!(FAULTS as readonly string[]).includes(value)) return `--fault must be ${FAULTS.join(" or ")}`;
      args.fault = value as Fault;
    } else {
      return `unknown option ${flag}`;
    }
  }
  return args;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function resultLine(result: ScenarioResult): string {
  return result.status === "pass"
    ? `PASS ${result.name} (${seconds(result.durationMs)})`
    : `FAIL ${result.name}: ${result.reason ?? "failed"}`;
}

export async function main(argv: readonly string[], out: Output): Promise<number> {
  const args = parseArgs(argv);
  if (args === "help") {
    out.stdout(usage());
    return 0;
  }
  if (typeof args === "string") {
    out.stderr(`hotline-scenarios: ${args}\n\n${usage()}`);
    return 2;
  }

  let thresholds: Thresholds | undefined;
  let thresholdsProblem: string | undefined;
  try {
    thresholds = parseThresholds(await readFile(args.thresholds, "utf8"));
  } catch (error) {
    thresholdsProblem = `cannot use ${args.thresholds}: ${(error as Error).message}`;
  }

  const started = new Date();
  const lines: string[] = [];
  const print = (line: string) => {
    lines.push(line);
    out.stdout(line);
  };
  if (args.fault !== undefined) out.stderr(`hotline-scenarios: fault injected: ${args.fault}`);
  const results = await runScenarios({
    ...(args.only === undefined ? {} : { only: args.only }),
    ...(args.fault === undefined ? {} : { fault: args.fault }),
    onResult: (result) => print(resultLine(result)),
  });

  const scored = thresholds === undefined ? undefined : score(results, thresholds, args.mode);
  const reasons = [
    ...(thresholdsProblem === undefined ? [] : [thresholdsProblem]),
    ...(scored?.reasons ?? []),
    ...(args.fault === undefined ? [] : [`a fault was injected (${args.fault}): a faulted run never passes`]),
  ];
  for (const name of scored?.missing ?? []) {
    const known = SCENARIOS.some((s) => s.name === name);
    print(`FAIL ${name}: not run (${known ? "left out of this run" : "the suite has no such scenario"})`);
  }
  const verdict = reasons.length === 0 ? "PASS" : "FAIL";
  for (const reason of reasons) out.stderr(`hotline-scenarios: ${reason}`);
  print(`THRESHOLDS: ${verdict}`);

  const report = {
    schema: 1,
    mode: args.mode,
    thresholds: args.thresholds,
    ...(args.fault === undefined ? {} : { fault: args.fault }),
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    result: verdict,
    reasons,
    passed: scored?.passed ?? results.filter((r) => r.status === "pass").length,
    total: scored?.total ?? results.length,
    passRate: scored?.passRate ?? null,
    passRateMin: thresholds?.passRateMin ?? null,
    missing: scored?.missing ?? [],
    scenarios: results.map((r) => ({ ...r, required: thresholds?.required.includes(r.name) ?? null })),
  };
  try {
    await mkdir(args.out, { recursive: true });
    await writeFile(join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(args.out, "report.txt"), `${lines.join("\n")}\n`);
  } catch (error) {
    out.stderr(`hotline-scenarios: could not write the report to ${args.out}: ${(error as Error).message}`);
    return 1;
  }
  return verdict === "PASS" ? 0 : 1;
}
