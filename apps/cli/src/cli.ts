import { createRequire } from "node:module";
import { homedir } from "node:os";
import { productName } from "@hotline/core";
import type { LogDestination, SignalSource } from "@hotline/daemon";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** What a command may read from its environment. Tests pass fakes; `main` passes the process. */
export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  signals: SignalSource;
  /** Where the daemon writes its JSON log lines. */
  logDestination: LogDestination;
}

export function processContext(): CliContext {
  return {
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
    signals: process,
    logDestination: process.stderr,
  };
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
    "  daemon      Run the Hotline daemon (agent API and webhook listener)",
    "  help        Show this message",
    "  version     Print the hotline version",
    "",
    "More commands (init, install, away, doctor, voice, test-call, hook, mcp)",
    "arrive with later tickets; see docs/plan.md.",
  ].join("\n");
}

export function daemonUsage(): string {
  return [
    "Usage: hotline daemon [--port <port>]",
    "",
    "Runs the Hotline daemon in the foreground until SIGINT (Ctrl-C) or SIGTERM.",
    "Both listeners bind 127.0.0.1 only:",
    "  agent API   config daemon.port (default 7341), for agents on this Mac;",
    "              every request needs the per-install token",
    "  webhooks    the next port, serving /hooks/* only; point the tunnel here",
    "",
    "Options:",
    "  --port <port>   Use this agent API port instead of daemon.port",
    "                  (0 picks free ports for both listeners, for testing)",
    "",
    "Logs are JSON lines on stderr with phone numbers and secrets redacted.",
  ].join("\n");
}

async function daemonCommand(args: readonly string[], out: Output, context: CliContext): Promise<number> {
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      out.stdout(daemonUsage());
      return 0;
    }
    if (arg === "--port") {
      const value = args[++index];
      if (value === undefined || !/^\d{1,5}$/.test(value)) {
        out.stderr(`hotline daemon: --port needs a number\n\n${daemonUsage()}`);
        return 2;
      }
      port = Number(value);
      continue;
    }
    out.stderr(`hotline daemon: unknown option "${arg}"\n\n${daemonUsage()}`);
    return 2;
  }

  // Loaded only for this command, so `hotline --version` never starts Fastify or SQLite.
  const { runDaemon } = await import("@hotline/daemon");
  try {
    return await runDaemon({
      ...context,
      version: cliVersion,
      port,
      onReady: (daemon) =>
        out.stdout(`hotline daemon: agent API on ${daemon.apiUrl}, webhooks on ${daemon.hooksUrl}`),
    });
  } catch (error) {
    out.stderr(`hotline daemon: ${(error as Error).message}`);
    return 1;
  }
}

/** Runs one CLI invocation and resolves with the process exit code. */
export async function run(
  argv: readonly string[],
  out: Output,
  context: CliContext = processContext(),
): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "daemon":
      return daemonCommand(args, out, context);
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
