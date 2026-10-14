// Hook payloads as Claude Code and Codex send them (the shapes of the HL-02
// fixtures in packages/agents/test/fixtures/hooks, from the Claude Code hooks
// reference and the Codex hooks schema), and readers for what the hooks print.
import { ClaudePermissionRequestOutput, CodexPermissionRequestOutput, StopBlockOutput } from "@hotline/core";
import { check, ScenarioFailure, show } from "./check.js";
import type { HookRun } from "./hotline.js";

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

function hookJson(run: HookRun, what: string): unknown {
  check(run.code === 0, `${what} exited with ${run.code} (${run.stderr.trim()})`);
  const out = run.stdout.trim();
  if (out === "") return undefined;
  try {
    return JSON.parse(out);
  } catch {
    throw new ScenarioFailure(`${what} printed something that is not JSON: ${show(out)}`);
  }
}

/**
 * The permission hook's decision: what the agent will do. The whole output must
 * match that agent's documented PermissionRequest output (core's strict schemas),
 * so output the agent would reject never counts as an allow or a deny.
 */
export function permissionDecision(run: HookRun): { behavior: string; message?: string } {
  check(run.event === "permission", `expected a permission hook run, got ${run.event}`);
  const what = `the ${run.agent} permission hook`;
  const output = hookJson(run, what);
  if (output === undefined) throw new ScenarioFailure(`${what} printed nothing`);
  const schema = run.agent === "codex" ? CodexPermissionRequestOutput : ClaudePermissionRequestOutput;
  const parsed = schema.safeParse(output);
  if (!parsed.success)
    throw new ScenarioFailure(`${what} printed output the agent would reject: ${show(output)}`);
  return parsed.data.hookSpecificOutput.decision;
}

export function expectAllow(run: HookRun, what: string): void {
  const decision = permissionDecision(run);
  check(decision.behavior === "allow", `${what}: expected the hook to allow, got ${show(decision)}`);
}

export function expectDeny(run: HookRun, what: string): string {
  const decision = permissionDecision(run);
  check(decision.behavior === "deny", `${what}: expected the hook to deny, got ${show(decision)}`);
  return decision.message ?? "";
}

/**
 * The Stop hook's output: undefined when the agent stops, else `{decision, reason}`,
 * which must match the documented block output both agents read.
 */
export function stopOutput(run: HookRun): Record<string, unknown> | undefined {
  check(run.event === "stop", `expected a Stop hook run, got ${run.event}`);
  const what = `the ${run.agent} Stop hook`;
  const output = hookJson(run, what);
  if (output === undefined) return undefined;
  const parsed = StopBlockOutput.safeParse(output);
  if (!parsed.success)
    throw new ScenarioFailure(`${what} printed output the agent would reject: ${show(output)}`);
  return parsed.data;
}
