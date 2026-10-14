import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { type AgentKind, productName } from "@hotline/core";
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
  /** The working directory; `hotline mcp` registers its session there. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The MCP protocol streams for `hotline mcp`. Default to the process's own. */
  stdin?: Readable;
  stdout?: Writable;
}

export function processContext(): CliContext {
  return {
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
    signals: process,
    logDestination: process.stderr,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
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
    "  mcp         Run the MCP server for Claude Code or Codex (stdio)",
    "  help        Show this message",
    "  version     Print the hotline version",
    "",
    "More commands (init, install, away, doctor, voice, test-call, hook)",
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

export function mcpUsage(): string {
  return [
    "Usage: hotline mcp [--agent <claude|codex>] [--port <port>]",
    "",
    "Runs the Hotline MCP server on stdin and stdout until the agent closes it.",
    "Claude Code and Codex start it themselves; see docs/mcp.md for their config.",
    "Tools: ask_human, notify_human, check_inbox. It talks only to the daemon's",
    "agent API on 127.0.0.1, with the per-install token from the secret store.",
    "",
    "Options:",
    "  --agent <claude|codex>   Which agent runs this server (else guessed from the client)",
    "  --port <port>            The daemon's agent API port instead of daemon.port",
    "",
    "Nothing but MCP messages goes to stdout; errors go to stderr.",
  ].join("\n");
}

const AGENT_FLAGS: Readonly<Record<string, AgentKind>> = { claude: "claude-code", codex: "codex" };

async function mcpCommand(args: readonly string[], out: Output, context: CliContext): Promise<number> {
  let agent: AgentKind | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      // Help goes to stderr: stdout belongs to the MCP protocol.
      out.stderr(mcpUsage());
      return 0;
    }
    if (arg === "--agent") {
      const value = args[++index];
      const kind = value === undefined ? undefined : AGENT_FLAGS[value];
      if (kind === undefined) {
        out.stderr(`hotline mcp: --agent must be claude or codex\n\n${mcpUsage()}`);
        return 2;
      }
      agent = kind;
      continue;
    }
    if (arg === "--port") {
      const value = args[++index];
      if (value === undefined || !/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        out.stderr(`hotline mcp: --port needs a port number\n\n${mcpUsage()}`);
        return 2;
      }
      port = Number(value);
      continue;
    }
    out.stderr(`hotline mcp: unknown option "${arg}"\n\n${mcpUsage()}`);
    return 2;
  }

  const { DaemonClient, DaemonError, runStdioMcpServer } = await import("@hotline/agents");
  const daemon = new DaemonClient({
    // Read on first use and again after a failure, so the daemon may start later.
    connection: async () => {
      const { hotlinePaths, loadConfig, openSecretStore } = await import("@hotline/daemon");
      try {
        const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
        const config = await loadConfig(paths.config);
        const secrets = openSecretStore({
          choice: config.secrets.store,
          platform: context.platform,
          filePath: paths.secrets,
        });
        const token = await secrets.get("daemon.apiToken");
        if (token === undefined) throw new Error('no API token yet; start "hotline daemon" first');
        return { port: port ?? config.daemon.port, token };
      } catch (error) {
        const message = (error as Error).message;
        out.stderr(`hotline mcp: ${message}`);
        throw new DaemonError("not-configured", message);
      }
    },
  });
  const sessionId = context.env.CLAUDE_CODE_SESSION_ID;
  try {
    await runStdioMcpServer({
      daemon,
      cwd: context.cwd ?? process.cwd(),
      version: cliVersion,
      ...(agent === undefined ? {} : { agent }),
      ...(sessionId === undefined ? {} : { agentSessionId: sessionId }),
      ...(context.stdin === undefined ? {} : { stdin: context.stdin }),
      ...(context.stdout === undefined ? {} : { stdout: context.stdout }),
    });
    return 0;
  } catch (error) {
    out.stderr(`hotline mcp: ${(error as Error).message}`);
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
    case "mcp":
      return mcpCommand(args, out, context);
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
