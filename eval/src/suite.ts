// Runs scenarios one at a time, each against its own fresh hotline(s), and
// turns each into a PASS or a FAIL with the reason. Programmatic entry point
// for the runner (cli.ts) and the self-test.
import { oneLine } from "./check.js";
import type { Fault } from "./fault.js";
import { type Hotline, startHotline } from "./hotline.js";
import type { Scenario } from "./scenario.js";
import { SCENARIOS } from "./scenarios/index.js";
import type { ScenarioResult } from "./thresholds.js";

export { FAULTS, type Fault } from "./fault.js";
export { SCENARIOS } from "./scenarios/index.js";
export * from "./thresholds.js";

/** Real time one scenario may take before it fails as timed out. */
export const SCENARIO_TIMEOUT_MS = 120_000;

export interface RunOptions {
  /** Only these scenarios (by name); the rest do not run. */
  only?: readonly string[];
  /** The self-test fault. Never set by CI. */
  fault?: Fault;
  timeoutMs?: number;
  /** Called as each scenario finishes, in order. */
  onResult?: (result: ScenarioResult) => void;
}

async function runOne(scenario: Scenario, options: RunOptions): Promise<ScenarioResult> {
  const started = Date.now();
  const hotlines: Hotline[] = [];
  const context = {
    async start(hotlineOptions = {}) {
      const hotline = await startHotline({
        ...hotlineOptions,
        ...(options.fault === undefined ? {} : { fault: options.fault }),
      });
      hotlines.push(hotline);
      return hotline;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = options.timeoutMs ?? SCENARIO_TIMEOUT_MS;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs);
  });
  const running = scenario.run(context);
  running.catch(() => {});
  let failure: string | undefined;
  try {
    await Promise.race([running, timedOut]);
  } catch (error) {
    failure = oneLine(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    // Stopping the hotlines ends anything still waiting (children, MCP sessions, the daemon).
    // Every one is stopped; a daemon that did not shut down cleanly fails a scenario that passed.
    const problems: string[] = [];
    for (const hotline of hotlines.reverse()) {
      try {
        const code = await hotline.stop();
        if (code !== 0) problems.push(`the daemon exited with ${code} on shutdown`);
      } catch (error) {
        problems.push(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await Promise.race([running.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (failure === undefined && problems.length > 0) failure = oneLine(problems.join("; "));
  }
  return {
    name: scenario.name,
    status: failure === undefined ? "pass" : "fail",
    ...(failure === undefined ? {} : { reason: failure }),
    durationMs: Date.now() - started,
  };
}

/** Runs the selected scenarios in order. Never throws for a scenario's failure. */
export async function runScenarios(options: RunOptions = {}): Promise<ScenarioResult[]> {
  const selected =
    options.only === undefined ? SCENARIOS : SCENARIOS.filter((s) => options.only?.includes(s.name));
  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const result = await runOne(scenario, options);
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
