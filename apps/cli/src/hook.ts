// `hotline hook <claude|codex> <permission|stop>` and `hotline away [on|off|status]`.
// See docs/hooks.md.
import type { Readable } from "node:stream";
import { type AgentKind, JUDGE_ENV } from "@hotline/core";
import type { CliContext, Output } from "./cli.js";
import { loadDaemonSetup } from "./setup.js";

/** Larger payloads are not understood, so the agent falls back to its own prompt. */
export const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;

const AGENTS: Readonly<Record<string, AgentKind>> = { claude: "claude-code", codex: "codex" };
const EVENTS = new Set(["permission", "stop"]);

export function hookUsage(): string {
  return [
    "Usage: hotline hook <claude|codex> <permission|stop> [--port <port>] [--wait-seconds <n>]",
    "",
    "The command hook Claude Code and Codex run for PermissionRequest (permission)",
    "and Stop (stop). It reads the agent's JSON payload on stdin and prints the",
    "agent's documented output, or nothing. Outside away mode it prints nothing, so",
    "the agent shows its own prompt or stops. See docs/hooks.md for the config.",
    "",
    "Options:",
    "  --port <port>         The daemon's agent API port instead of daemon.port",
    "  --wait-seconds <n>    Longest wait for the owner (default 540). Keep it below",
    "                        the hook timeout in the agent's config (default 600)",
  ].join("\n");
}

export function awayUsage(): string {
  return [
    "Usage: hotline away [on|off|status]",
    "",
    "Away mode lets the permission and Stop hooks phone you. Off (the default),",
    "the hooks stay out of the way. Switching it off also clears the Stop-hook",
    "continuation counts.",
  ].join("\n");
}

async function readInput(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    // Too large to be a real payload: keep reading so the agent is not blocked, but drop it.
    if (size <= MAX_HOOK_INPUT_BYTES) chunks.push(buffer);
  }
  return size > MAX_HOOK_INPUT_BYTES ? "" : Buffer.concat(chunks).toString("utf8");
}

function numberOption(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d{1,6}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
}

/**
 * Exit codes matter here: exit 2 from a Stop hook makes the agent keep going, so
 * this command never returns 2. Usage errors return 1, a non-blocking error.
 */
export async function hookCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  // The reply judge's own agent CLI run (HL-09d): never phone anyone about it.
  if (context.env[JUDGE_ENV] === "1") {
    out.stderr("hotline hook: inside the reply judge; doing nothing");
    return 0;
  }
  const positional: string[] = [];
  let port: number | undefined;
  let waitSeconds: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      // stdout belongs to the agent.
      out.stderr(hookUsage());
      return 0;
    }
    if (arg === "--port" || arg === "--wait-seconds") {
      const value = numberOption(args[++index], 1, arg === "--port" ? 65535 : 86_400);
      if (value === undefined) {
        out.stderr(`hotline hook: ${arg} needs a number\n\n${hookUsage()}`);
        return 1;
      }
      if (arg === "--port") port = value;
      else waitSeconds = value;
      continue;
    }
    if (arg.startsWith("-")) {
      out.stderr(`hotline hook: unknown option "${arg}"\n\n${hookUsage()}`);
      return 1;
    }
    positional.push(arg);
  }
  const [agentFlag, event, ...extra] = positional;
  const agent = agentFlag === undefined ? undefined : AGENTS[agentFlag];
  if (agent === undefined || event === undefined || !EVENTS.has(event) || extra.length > 0) {
    out.stderr(`hotline hook: expected <claude|codex> <permission|stop>\n\n${hookUsage()}`);
    return 1;
  }

  const { DaemonClient, runHook } = await import("@hotline/agents");
  const { FileContinuationStore, hotlinePaths, readAwayState } = await import("@hotline/daemon");
  let paths: ReturnType<typeof hotlinePaths>;
  try {
    paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
  } catch (error) {
    // No usable hotline home means no away mode: the agent carries on as usual.
    out.stderr(`hotline hook: ${(error as Error).message}`);
    return 0;
  }
  const counts = new FileContinuationStore(paths.hookState);
  const input = await readInput(context.stdin ?? process.stdin);

  // The agent kills the hook on its own timeout or when the user interrupts: stop waiting.
  const aborted = new AbortController();
  const onSignal = () => aborted.abort();
  context.signals.on("SIGTERM", onSignal);
  context.signals.on("SIGINT", onSignal);
  try {
    const result = await runHook({
      agent,
      event: event as "permission" | "stop",
      input,
      signal: aborted.signal,
      ...(waitSeconds === undefined ? {} : { waitSeconds }),
      state: {
        isAway: async () => {
          const state = await readAwayState(paths.away);
          if (state.problem !== undefined) out.stderr(`hotline hook: away mode is off: ${state.problem}`);
          return state.away;
        },
        continuations: (sessionId) => counts.get(agent, sessionId),
        setContinuations: (sessionId, count) => counts.set(agent, sessionId, count, new Date()),
      },
      connect: async () => {
        const { config, token } = await loadDaemonSetup(context);
        return {
          daemon: new DaemonClient({ connection: async () => ({ port: port ?? config.daemon.port, token }) }),
          maxConsecutiveContinuations: config.policy.maxConsecutiveContinuations,
        };
      },
    });
    out.stderr(`hotline hook: ${result.note}`);
    if (result.stdout !== undefined) out.stdout(result.stdout);
    return 0;
  } finally {
    context.signals.off("SIGTERM", onSignal);
    context.signals.off("SIGINT", onSignal);
  }
}

export async function awayCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  const [action = "status", ...extra] = args;
  if (action === "--help" || action === "-h") {
    out.stdout(awayUsage());
    return 0;
  }
  if (!["on", "off", "status"].includes(action) || extra.length > 0) {
    out.stderr(`hotline away: expected on, off or status\n\n${awayUsage()}`);
    return 2;
  }
  const { FileContinuationStore, hotlinePaths, readAwayState, writeAwayState } = await import(
    "@hotline/daemon"
  );
  try {
    const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
    if (action !== "status") {
      await writeAwayState(paths.away, action === "on", new Date());
      // A fresh start either way: no continuation chain carries over.
      await new FileContinuationStore(paths.hookState).clear();
    }
    const state = await readAwayState(paths.away);
    if (state.problem !== undefined) {
      out.stderr(`hotline away: ${state.problem}`);
      return 1;
    }
    out.stdout(
      state.away
        ? "Away mode is on: permission requests and finished turns will phone you."
        : "Away mode is off: agents use their own terminal prompts.",
    );
    return 0;
  } catch (error) {
    out.stderr(`hotline away: ${(error as Error).message}`);
    return 1;
  }
}
