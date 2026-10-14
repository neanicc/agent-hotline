// Hook payloads as Claude Code and Codex send them (the shapes of the HL-02
// fixtures in packages/agents/test/fixtures/hooks, from the Claude Code hooks
// reference and the Codex hooks schema), and readers for what the hooks print.
import { check, ScenarioFailure, show } from "./check.js";
import type { CliRun } from "./hotline.js";

export const CLAUDE_SESSION = "00000000-0000-4000-8000-0000000000c1";
export const CODEX_SESSION = "00000000-0000-4000-8000-0000000000c2";
export const CLAUDE_CWD = "/Users/example/src/demo-app";
export const CODEX_CWD = "/Users/example/src/api";

/** A Claude Code `PermissionRequest` for the Bash tool. */
export function claudeBash(command: string, description?: string): Record<string, unknown> {
  return {
    session_id: CLAUDE_SESSION,
    transcript_path: `/Users/example/.claude/projects/-Users-example-src-demo-app/${CLAUDE_SESSION}.jsonl`,
    cwd: CLAUDE_CWD,
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command, ...(description === undefined ? {} : { description }) },
  };
}

/** A Codex `PermissionRequest` for a shell command. Always high risk (HL-06b): Codex does not say where it runs. */
export function codexBash(command: string, description?: string): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    transcript_path: null,
    cwd: CODEX_CWD,
    hook_event_name: "PermissionRequest",
    model: "example-model",
    permission_mode: "default",
    turn_id: "turn-0001",
    tool_name: "Bash",
    tool_input: { command, ...(description === undefined ? {} : { description }) },
  };
}

export function claudeStop(
  active: boolean,
  lastMessage = "I've finished the refactoring.",
): Record<string, unknown> {
  return {
    session_id: CLAUDE_SESSION,
    transcript_path: `/Users/example/.claude/projects/-Users-example-src-demo-app/${CLAUDE_SESSION}.jsonl`,
    cwd: CLAUDE_CWD,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: active,
    last_assistant_message: lastMessage,
    background_tasks: [],
    session_crons: [],
  };
}

export function codexStop(
  active: boolean,
  lastMessage = "The Windows build is fixed.",
): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    transcript_path: null,
    cwd: CODEX_CWD,
    hook_event_name: "Stop",
    model: "example-model",
    permission_mode: "default",
    turn_id: "turn-0003",
    stop_hook_active: active,
    last_assistant_message: lastMessage,
  };
}

function hookJson(run: CliRun, what: string): Record<string, unknown> | undefined {
  check(run.code === 0, `${what} exited with ${run.code} (${run.stderr.trim()})`);
  const out = run.stdout.trim();
  if (out === "") return undefined;
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    throw new ScenarioFailure(`${what} printed something that is not JSON: ${show(out)}`);
  }
}

/** The permission hook's decision: what the agent will do. */
export function permissionDecision(run: CliRun): { behavior: string; message?: string } {
  const output = hookJson(run, "the permission hook");
  const decision = (output?.hookSpecificOutput as { decision?: { behavior: string; message?: string } })
    ?.decision;
  if (decision === undefined)
    throw new ScenarioFailure(`the permission hook printed no decision: ${show(output)}`);
  return decision;
}

export function expectAllow(run: CliRun, what: string): void {
  const decision = permissionDecision(run);
  check(decision.behavior === "allow", `${what}: expected the hook to allow, got ${show(decision)}`);
}

export function expectDeny(run: CliRun, what: string): string {
  const decision = permissionDecision(run);
  check(decision.behavior === "deny", `${what}: expected the hook to deny, got ${show(decision)}`);
  return decision.message ?? "";
}

/** The Stop hook's output: undefined when the agent stops, else `{decision, reason}`. */
export function stopOutput(run: CliRun): Record<string, unknown> | undefined {
  return hookJson(run, "the Stop hook");
}
