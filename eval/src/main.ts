#!/usr/bin/env node
// `pnpm run eval -- --mode <ci|local> --thresholds eval/thresholds.toml --out eval-out`
// (scripts/ci/run.sh eval). See cli.ts and docs/eval.md.
import { main } from "./cli.js";

// A stray rejection inside one scenario must not take the whole run down with
// no THRESHOLDS line; the scenario itself still fails on what it awaited.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`hotline-scenarios: unhandled rejection: ${String(reason)}\n`);
});

const code = await main(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
// Anything still holding the event loop open (a child the run already killed) must not hang CI.
setTimeout(() => process.exit(code), 5_000).unref();
