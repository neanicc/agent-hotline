// `hotline hook <claude|codex> <permission|stop>`: the command hooks Claude Code
// and Codex run for `PermissionRequest` and `Stop`. Each run reads one JSON
// payload from stdin and prints the agent's documented output, or nothing.
//
// Rules (plan sections 4B, 4C and 7; docs/hooks.md):
//
// - Away mode off, or input Hotline cannot parse: print nothing. The agent then
//   shows its own terminal prompt (permission) or simply stops (Stop). Hotline
//   never widens a permission, never applies a suggestion, never sends
//   `updatedInput`, `updatedPermissions` or `interrupt`.
// - Away mode on: phone the owner through the daemon. A permission is allowed
//   only when core's `permissionVerdict` says so: the owner's own approval of
//   exactly this ask, with the PIN or a confirming text when it is high risk.
//   No answer, a timeout, an unreachable daemon or a malformed outcome denies.
// - Stop continues only with the owner's own instruction, and only while the
//   loop guards allow: a turn Hotline did not continue itself is left alone, and
//   at most `policy.maxConsecutiveContinuations` continuations run in a row.
//
// Everything in the payload was written by the agent and is untrusted: it is
// cut short, stripped of control characters and redacted by the daemon before
// it is stored, spoken or texted.
import {
  type AgentKind,
  type Ask,
  type AskOutcome,
  ClaudePermissionRequestInput,
  ClaudePermissionRequestOutput,
  ClaudeStopInput,
  CodexPermissionRequestInput,
  CodexPermissionRequestOutput,
  CodexStopInput,
  classifyPermission,
  Id,
  insideProject,
  isShellTool,
  type PermissionRisk,
  patchFiles,
  permissionVerdict,
  projectRoot,
  resolvePosix,
  StopBlockOutput,
  shellCommand,
  stopInstruction,
  withRiskReason,
} from "@hotline/core";
import type { CreateAskRequest, HotlineDaemon } from "./daemon-client.js";

export type HookEvent = "permission" | "stop";

/** Answered before the agent's own hook timeout (600 s by default in both agents) can discard the output. */
export const DEFAULT_HOOK_WAIT_SECONDS = 540;
export const DEFAULT_HOOK_POLL_SECONDS = 25;
export const DEFAULT_HOOK_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Past the ask's own expiry, the hook stops waiting even if the daemon has not said so. */
const EXPIRY_GRACE_MS = 30_000;

/** Lengths of the agent-written text sent to the daemon, which redacts it. */
export const MAX_PREVIEW = 200;
export const MAX_DESCRIPTION = 120;
export const MAX_SUMMARY = 300;
const MAX_TOOL_NAME = 100;
const MAX_REASON = 4000;
const MAX_OWNER_WORDS = 300;
/** Tools whose `url`, `pattern` or `query` is the preview. Other unknown tools show argument names only. */
const KNOWN_FIELD_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch", "Grep", "Glob"]);

/** The deny message for every case where nobody approved. Matches the HL-02 fixtures. */
export const NOT_APPROVED = "The owner did not approve this by phone.";

/** What the hook keeps between runs: away mode and the continuation counts. */
export interface HookState {
  /** Whether away mode is on. Anything unreadable is off. */
  isAway(): Promise<boolean>;
  /** Consecutive continuations for this agent session. Throws when the count cannot be trusted. */
  continuations(agentSessionId: string): Promise<number>;
  setContinuations(agentSessionId: string, count: number): Promise<void>;
}

/** The daemon and the settings a hook needs, read only when away mode is on. */
export interface HookConnection {
  daemon: HotlineDaemon;
  /** `policy.maxConsecutiveContinuations`. */
  maxConsecutiveContinuations: number;
}

export interface HookOptions {
  agent: AgentKind;
  event: HookEvent;
  /** The raw stdin payload. */
  input: string;
  state: HookState;
  connect: () => Promise<HookConnection>;
  clock?: () => Date;
  /** Longest wait for the owner. Keep it below the hook `timeout` in the agent's config. */
  waitSeconds?: number;
  pollSeconds?: number;
  retryDelaysMs?: readonly number[];
  /** Aborted when the agent kills the hook: the ask is cancelled and the hook denies or lets the agent stop. */
  signal?: AbortSignal;
}

export interface HookResult {
  /** One JSON line for stdout, or undefined to print nothing. */
  stdout?: string;
  /** A short diagnostic for stderr. Never holds agent-written text, owner words or secrets. */
  note: string;
}

// C0 controls and DEL become spaces, then whitespace runs collapse: one spoken line.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]+/g;

function collapse(text: string): string {
  return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/**
 * The first `max` characters of a collapsed line, cut back to a word boundary:
 * a cut through a word could leave the start of a secret that the daemon's
 * redactor no longer recognises. One word longer than `max` leaves nothing.
 */
function cutAtWord(line: string, max: number): string {
  if (line.length <= max) return line;
  const head = line.slice(0, max);
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : "";
}

function oneLine(text: string, max: number): string {
  const line = collapse(text);
  if (line.length <= max) return line;
  const cut = cutAtWord(line, max - 1);
  return cut === "" ? "…" : `${cut}…`;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function shownPath(cwd: string, path: string): string {
  const root = projectRoot(cwd);
  if (root === undefined || !insideProject(cwd, path)) return path;
  const below = resolvePosix(root, path).slice(root.length + 1);
  return below === "" ? "." : below;
}

/** For a tool Hotline does not know: its argument names only, never their values (they can hold file bodies). */
function argumentNames(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "(no named arguments)";
  const names = Object.keys(input).map((name) => safeToolName(name));
  if (names.length === 0) return "(no arguments)";
  return `arguments ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
}

/** A tool name the daemon accepts: identifier characters only. */
export function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, MAX_TOOL_NAME) || "unknown";
}

/** What the hook sends the daemon for a permission request. */
export interface PermissionAsk {
  /** The line the owner hears or reads. */
  text: string;
  /** From the full tool input, made high when the preview had to be shortened. */
  risk: PermissionRisk;
}

/**
 * The short line the owner hears or reads for a permission request, in this
 * order: why it is high risk, the tool and a one-line preview (a command, the
 * files a patch touches, a path), then the agent's own description, labelled as
 * the agent's words. Never file contents. A preview too long to read out says
 * how much was cut and makes the request high risk, since the cut part could
 * hold anything. The description is untrusted and never replaces the preview.
 */
export function permissionAsk(toolName: string, toolInput: unknown, cwd: string): PermissionAsk {
  let risk = classifyPermission({ toolName, toolInput, cwd });
  const command = isShellTool(toolName) || toolName === "apply_patch" ? shellCommand(toolInput) : undefined;
  const patch = toolName === "apply_patch" && command !== undefined ? patchFiles(command) : undefined;
  const path = field(toolInput, "file_path") ?? field(toolInput, "notebook_path") ?? field(toolInput, "path");
  let preview: string;
  if (patch !== undefined) {
    const files = patch.paths.slice(0, 5).map((file) => shownPath(cwd, file));
    preview = `change ${files.join(", ")}${patch.paths.length > 5 ? ` and ${patch.paths.length - 5} more` : ""}`;
  } else if (toolName === "apply_patch") {
    preview = "a patch Hotline cannot read";
  } else if (command !== undefined) {
    preview = command;
  } else if (path !== undefined) {
    preview = shownPath(cwd, path);
  } else if (KNOWN_FIELD_TOOLS.has(toolName)) {
    preview = field(toolInput, "url") ?? field(toolInput, "pattern") ?? field(toolInput, "query") ?? "";
  } else {
    preview = argumentNames(toolInput);
  }
  const line = collapse(preview);
  let shown = line === "" ? "(no details)" : line;
  if (line.length > MAX_PREVIEW) {
    const head = cutAtWord(line, MAX_PREVIEW);
    const more = line.length - head.length;
    const what = command === undefined ? "details" : "command";
    shown = `${head === "" ? "" : `${head} `}(${what} shortened, ${more} more characters)`;
    risk = withRiskReason(risk, "is too long to read out in full");
  }
  const parts: string[] = [];
  if (risk.risk === "high") parts.push(`High risk: ${risk.reasons.join(", ")}.`);
  parts.push(`${oneLine(toolName, MAX_TOOL_NAME)}: ${shown}`);
  const description = oneLine(field(toolInput, "description") ?? "", MAX_DESCRIPTION);
  // Only a description with something readable in it; the daemon redacts it with the rest.
  if (/[\p{L}\p{N}]/u.test(description)) parts.push(`The agent says: "${description.replace(/"/g, "'")}"`);
  return { text: parts.join(" "), risk };
}

/** "Finished a turn: <summary>. What next?" */
export function stopText(lastMessage: string | null | undefined): string {
  const summary = lastMessage === null || lastMessage === undefined ? "" : oneLine(lastMessage, MAX_SUMMARY);
  return summary === "" ? "Finished a turn. What next?" : `Finished a turn: ${summary} What next?`;
}

function permissionOutput(agent: AgentKind, allow: boolean, message: string): string {
  const decision = allow ? { behavior: "allow" as const } : { behavior: "deny" as const, message };
  const output = { hookSpecificOutput: { hookEventName: "PermissionRequest" as const, decision } };
  // Codex fails closed on fields it does not know; both schemas are strict and narrower than the agents'.
  const schema = agent === "codex" ? CodexPermissionRequestOutput : ClaudePermissionRequestOutput;
  return JSON.stringify(schema.parse(output));
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function agentSessionIdOf(sessionId: string): string | undefined {
  return Id.safeParse(sessionId).success ? sessionId : undefined;
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

interface Waiting {
  daemon: HotlineDaemon;
  clock: () => Date;
  waitMs: number;
  pollSeconds: number;
  retryDelaysMs: readonly number[];
  signal: AbortSignal | undefined;
}

/**
 * Registers the session, queues the ask and waits for its final outcome. Undefined
 * means nobody decided: the daemon failed, the wait ran out or the agent gave up.
 * An ask the hook stops waiting for is cancelled, so nobody is phoned about it.
 */
async function askAndWait(
  w: Waiting,
  session: { agent: AgentKind; cwd: string; agentSessionId: string | undefined },
  request: CreateAskRequest,
): Promise<{ ask: Ask; outcome: AskOutcome | undefined } | undefined> {
  const started = w.clock().getTime();
  let ask: Ask;
  try {
    const registered = await w.daemon.registerSession({
      agent: session.agent,
      cwd: session.cwd,
      ...(session.agentSessionId === undefined ? {} : { agentSessionId: session.agentSessionId }),
    });
    ask = await w.daemon.createAsk(registered.id, request);
  } catch {
    return undefined;
  }
  const deadline = Math.min(started + w.waitMs, Date.parse(ask.expiresAt) + EXPIRY_GRACE_MS);
  let failures = 0;
  while (!w.signal?.aborted) {
    const remainingMs = deadline - w.clock().getTime();
    if (remainingMs <= 0) break;
    try {
      // The request itself ends at the deadline, and an answer that arrives
      // after it does not count: the hook has stopped waiting by then.
      const wait = Math.max(0, Math.min(w.pollSeconds, Math.floor(remainingMs / 1000)));
      const deadlineSignal = AbortSignal.timeout(Math.max(1, remainingMs));
      const signal = w.signal === undefined ? deadlineSignal : AbortSignal.any([w.signal, deadlineSignal]);
      const state = await w.daemon.outcome(ask.id, wait, signal);
      failures = 0;
      if (w.clock().getTime() > deadline) break;
      if (state.state === "final") return { ask, outcome: state.outcome };
    } catch {
      if (w.signal?.aborted || w.clock().getTime() >= deadline) break;
      const delay = w.retryDelaysMs[failures];
      failures += 1;
      if (delay === undefined) break;
      await sleep(delay, w.signal);
    }
  }
  await w.daemon.cancelAsk(ask.id).catch(() => false);
  return { ask, outcome: undefined };
}

function waiting(connection: HookConnection, options: HookOptions): Waiting {
  return {
    daemon: connection.daemon,
    clock: options.clock ?? (() => new Date()),
    waitMs: (options.waitSeconds ?? DEFAULT_HOOK_WAIT_SECONDS) * 1000,
    pollSeconds: options.pollSeconds ?? DEFAULT_HOOK_POLL_SECONDS,
    retryDelaysMs: options.retryDelaysMs ?? DEFAULT_HOOK_RETRY_DELAYS_MS,
    signal: options.signal,
  };
}

async function isAway(state: HookState): Promise<boolean> {
  try {
    return (await state.isAway()) === true;
  } catch {
    return false;
  }
}

async function permissionHook(options: HookOptions): Promise<HookResult> {
  const { agent } = options;
  const schema = agent === "codex" ? CodexPermissionRequestInput : ClaudePermissionRequestInput;
  const parsed = schema.safeParse(parseJson(options.input));
  if (!parsed.success) return { note: "input not understood; the agent shows its own prompt" };
  if (!(await isAway(options.state))) return { note: "away mode is off; the agent shows its own prompt" };

  const deny = (note: string, message = NOT_APPROVED): HookResult => ({
    stdout: permissionOutput(agent, false, message),
    note,
  });
  const { tool_name: toolName, tool_input: toolInput, cwd, session_id: sessionId } = parsed.data;
  const { text, risk } = permissionAsk(toolName, toolInput, cwd);
  let connection: HookConnection;
  try {
    connection = await options.connect();
  } catch {
    return deny("denied: Hotline is not set up or the daemon is unreachable");
  }
  const result = await askAndWait(
    waiting(connection, options),
    { agent, cwd, agentSessionId: agentSessionIdOf(sessionId) },
    {
      kind: "permission",
      text,
      toolName: safeToolName(toolName),
      risk: risk.risk,
    },
  );
  if (result === undefined) return deny("denied: the daemon did not take the request");
  if (result.outcome === undefined) return deny("denied: no answer in time");
  const { ask, outcome } = result;
  // Judge with the stricter of the two risk classes, so a daemon that stored
  // "low" can never lower what this hook worked out from the full input.
  const judged: Ask = { ...ask, risk: risk.risk === "high" ? "high" : ask.risk };
  if (permissionVerdict(judged, outcome) === "allow") {
    return { stdout: permissionOutput(agent, true, ""), note: "allowed by the owner" };
  }
  if (outcome.outcome !== "answered" || outcome.answer.askId !== ask.id) {
    return deny(`denied: ${outcome.outcome === "no-answer" ? outcome.reason : "unexpected outcome"}`);
  }
  if (outcome.answer.decision.type === "allow") {
    return deny(
      "denied: high-risk approval without the PIN or a confirming text",
      `${NOT_APPROVED} A high-risk request needs the owner's PIN or a confirming text.`,
    );
  }
  if (outcome.answer.decision.type === "deny") {
    const words = oneLine(outcome.answer.ownerExcerpt, MAX_OWNER_WORDS);
    return deny("denied by the owner", `The owner denied this by phone. Their words: "${words}"`);
  }
  return deny("denied: the answer was not an approval");
}

async function stopHook(options: HookOptions): Promise<HookResult> {
  const { agent, state } = options;
  const schema = agent === "codex" ? CodexStopInput : ClaudeStopInput;
  const parsed = schema.safeParse(parseJson(options.input));
  if (!parsed.success) return { note: "input not understood; the agent stops" };
  if (!(await isAway(state))) return { note: "away mode is off; the agent stops" };
  const { session_id: sessionId, cwd, stop_hook_active: continued } = parsed.data;

  // Loop guard 1: a turn that is not a continuation starts a fresh count. A
  // continuation Hotline did not cause (another Stop hook's) is left alone.
  let count: number;
  try {
    if (!continued) {
      await state.setContinuations(sessionId, 0);
      count = 0;
    } else {
      count = await state.continuations(sessionId);
      if (count === 0) return { note: "another hook continued this turn; the agent stops" };
    }
  } catch {
    return { note: "the continuation count cannot be read; the agent stops" };
  }

  // Every exit that does not continue the agent clears the count, so a later
  // continuation by another Stop hook is never mistaken for Hotline's own.
  const stop = async (note: string): Promise<HookResult> => {
    await state.setContinuations(sessionId, 0).catch(() => {});
    return { note };
  };

  let connection: HookConnection;
  try {
    connection = await options.connect();
  } catch {
    return stop("Hotline is not set up or the daemon is unreachable; the agent stops");
  }
  const session = { agent, cwd, agentSessionId: agentSessionIdOf(sessionId) };
  // Loop guard 2: at most maxConsecutiveContinuations in a row.
  if (count >= connection.maxConsecutiveContinuations) {
    await state.setContinuations(sessionId, 0).catch(() => {});
    try {
      const registered = await connection.daemon.registerSession({
        agent,
        cwd,
        ...(session.agentSessionId === undefined ? {} : { agentSessionId: session.agentSessionId }),
      });
      await connection.daemon.createAsk(registered.id, {
        kind: "notify",
        text: `Stopped after ${count} away-mode continuations in a row. It is waiting for you at the terminal.`,
      });
    } catch {
      // Best effort: the agent stops either way.
    }
    return { note: `continuation cap (${count}) reached; the agent stops` };
  }

  const result = await askAndWait(waiting(connection, options), session, {
    kind: "stop",
    text: stopText(parsed.data.last_assistant_message),
  });
  if (result?.outcome === undefined) return stop("no instruction from the owner; the agent stops");
  const instruction = stopInstruction(result.ask, result.outcome);
  if (instruction === undefined || instruction.trim() === "") {
    return stop("the owner let the agent stop, or did not answer");
  }
  // Away mode may have been switched off while the hook waited: then the owner
  // is back at the terminal, and no continuation goes out.
  if (!(await isAway(state))) return stop("away mode was switched off while waiting; the agent stops");
  try {
    await state.setContinuations(sessionId, count + 1);
  } catch {
    // Without a count the loop guard cannot work: let the agent stop rather than loop.
    return { note: "the continuation count cannot be saved; the agent stops" };
  }
  const reason = instruction.length <= MAX_REASON ? instruction : instruction.slice(0, MAX_REASON);
  return {
    stdout: JSON.stringify(StopBlockOutput.parse({ decision: "block", reason })),
    note: `continuing with the owner's instruction (${count + 1} in a row)`,
  };
}

/** Runs one hook. Never throws for anything the agent sent or the daemon did. */
export async function runHook(options: HookOptions): Promise<HookResult> {
  try {
    return await (options.event === "permission" ? permissionHook(options) : stopHook(options));
  } catch {
    // A bug must fail closed too: deny the permission, let the agent stop.
    return options.event === "permission"
      ? { stdout: permissionOutput(options.agent, false, NOT_APPROVED), note: "denied: internal error" }
      : { note: "internal error; the agent stops" };
  }
}
