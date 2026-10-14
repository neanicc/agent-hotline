import { createRequire } from "node:module";
import { productName } from "@hotline/core";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

// Resolves to apps/cli/package.json from both src/ (tests) and dist/ (built).
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const cliVersion: string = version;

export function usage(): string {
  return [
    `${productName}: your coding agents call you on the phone.`,
    "",
    "Usage: hotline <command>",
    "",
    "Commands:",
    "  help        Show this message",
    "  version     Print the hotline version",
    "",
    "More commands (init, daemon, install, away, doctor, voice, test-call,",
    "hook, mcp) arrive with later tickets; see docs/plan.md.",
  ].join("\n");
}

/** Runs one CLI invocation and returns the process exit code. */
export function run(argv: readonly string[], out: Output): number {
  const command = argv[0];
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      out.stdout(usage());
      return 0;
    case "version":
    case "--version":
    case "-v":
      out.stdout(`hotline ${cliVersion}`);
      return 0;
    case undefined:
      out.stderr(usage());
      return 2;
    default:
      out.stderr(`hotline: unknown command "${command}"\n\n${usage()}`);
      return 2;
  }
}
