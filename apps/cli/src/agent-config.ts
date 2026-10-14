// The Claude Code and Codex config entries `hotline install` writes (from
// docs/mcp.md and docs/hooks.md) and the readers `hotline doctor` uses. Pure:
// text in, text out. Only Hotline's own entries are ever added, changed or
// removed; every other key, including permission settings, is left as it was.
import { isDeepStrictEqual } from "node:util";

export type AgentFlag = "claude" | "codex";
export const AGENT_FLAGS: readonly AgentFlag[] = ["claude", "codex"];

/** Hook `timeout` in seconds, and the hook's own wait: about a minute below it (docs/hooks.md). */
export const HOOK_TIMEOUT_SECONDS = 1900;
export const HOOK_WAIT_SECONDS = 1830;
/** The hook's wait and the agents' hook timeout when neither is configured. */
export const DEFAULT_HOOK_WAIT_SECONDS = 540;
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
/** Codex `tool_timeout_sec` for the MCP server: above the 30-minute ask timeout plus a margin. */
export const CODEX_TOOL_TIMEOUT_SECONDS = 2100;
/** Codex's own default when `tool_timeout_sec` is unset. */
export const CODEX_DEFAULT_TOOL_TIMEOUT_SECONDS = 60;

const HOOK_EVENTS = { PermissionRequest: "permission", Stop: "stop" } as const;
type HookEvent = keyof typeof HOOK_EVENTS;

const TOML_BEGIN = "# >>> hotline: written by `hotline install codex`; edit with care >>>";
const TOML_END = "# <<< hotline <<<";

/** A config file Hotline cannot safely edit. The message never quotes the file. */
export class AgentConfigError extends Error {
  override readonly name = "AgentConfigError";
}

/**
 * The command that starts Hotline: `hotline`, or an absolute path given with
 * `--command`. Hook commands run through a shell, so only plain path characters.
 */
export function checkLauncher(launcher: string): string {
  if (launcher === "hotline" || /^\/[A-Za-z0-9._/+-]+$/.test(launcher)) return launcher;
  throw new AgentConfigError(
    "--command must be an absolute path of letters, digits and . _ / + - (no spaces or shell characters)",
  );
}

export function hookCommand(launcher: string, agent: AgentFlag, event: HookEvent): string {
  return `${launcher} hook ${agent} ${HOOK_EVENTS[event]} --wait-seconds ${HOOK_WAIT_SECONDS}`;
}

/**
 * Whether a hook command is Hotline's `<launcher> hook <agent> <event>`, whatever
 * launcher wrote it (`hotline`, a `--command` absolute path, or `node .../main.js`).
 * The shape must match exactly: the launcher, then `hook <agent> <event>` and only
 * Hotline's own `--wait-seconds` and `--port` options.
 */
function isHotlineHook(command: unknown, agent: AgentFlag, event: HookEvent, launcher = "hotline"): boolean {
  if (typeof command !== "string") return false;
  const words = command.trim().split(/\s+/);
  const at = words.indexOf("hook");
  if (at < 1) return false;
  const program = words.slice(0, at);
  // `hotline`, this run's `--command`, an absolute path to a file named exactly
  // `hotline`, or `node <...>/apps/cli/dist/main.js` (the hand-written form in
  // docs/hooks.md). Never another program.
  const first = program[0] ?? "";
  const programOk =
    (program.length === 1 &&
      (first === "hotline" || first === launcher || /^\/(.+\/)?hotline$/.test(first))) ||
    (program.length === 2 && first === "node" && /\/apps\/cli\/dist\/main\.js$/.test(program[1] ?? ""));
  if (!programOk || words[at + 1] !== agent || words[at + 2] !== HOOK_EVENTS[event]) return false;
  const options = words.slice(at + 3);
  for (let index = 0; index < options.length; index += 2) {
    if (
      !["--wait-seconds", "--port"].includes(options[index] ?? "") ||
      !/^\d{1,6}$/.test(options[index + 1] ?? "")
    ) {
      return false;
    }
  }
  return true;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a JSON config file; a missing file is an empty object. */
export function parseJsonConfig(text: string | undefined, label: string): Json {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentConfigError(`${label} is not valid JSON; fix it by hand, then run this again`);
  }
  if (!isObject(parsed)) throw new AgentConfigError(`${label} is not a JSON object`);
  return parsed;
}

function formatJson(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hookGroup(launcher: string, agent: AgentFlag, event: HookEvent): Json {
  const hook = {
    type: "command",
    command: hookCommand(launcher, agent, event),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  // Claude Code needs a matcher for tool events; Codex's PermissionRequest matches every tool without one.
  return agent === "claude" && event === "PermissionRequest"
    ? { matcher: "*", hooks: [hook] }
    : { hooks: [hook] };
}

/**
 * The hooks file (Claude Code `settings.json`, Codex `hooks.json`) with Hotline's
 * PermissionRequest and Stop hooks added (or removed). An entry that is already
 * exactly right is left in place, so running this twice changes nothing.
 */
export function editHooks(
  text: string | undefined,
  label: string,
  agent: AgentFlag,
  launcher: string,
  remove: boolean,
): string | undefined {
  const settings = parseJsonConfig(text, label);
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new AgentConfigError(`${label}: "hooks" is not an object; fix it by hand`);
  const next: Json = { ...hooks };
  let changed = false;
  for (const event of Object.keys(HOOK_EVENTS) as HookEvent[]) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || !groups.every((group) => isObject(group))) {
      throw new AgentConfigError(`${label}: "hooks.${event}" is not a list of hook groups; fix it by hand`);
    }
    const ours = (hook: unknown) => isObject(hook) && isHotlineHook(hook.command, agent, event, launcher);
    const count = groups.reduce(
      (total, group) => total + (Array.isArray(group.hooks) ? group.hooks.filter(ours).length : 0),
      0,
    );
    const wanted = hookGroup(launcher, agent, event);
    if (remove ? count === 0 : count === 1 && groups.some((group) => isDeepStrictEqual(group, wanted))) {
      continue;
    }
    changed = true;
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks) || !group.hooks.some(ours)) return [group];
      const rest = group.hooks.filter((hook) => !ours(hook));
      return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
    });
    if (!remove) kept.push(wanted);
    if (kept.length === 0) delete next[event];
    else next[event] = kept;
  }
  if (!changed) return text;
  const result: Json = { ...settings, hooks: next };
  if (Object.keys(next).length === 0) delete result.hooks;
  return formatJson(result);
}

/** Claude Code's `mcpServers.hotline` entry (docs/mcp.md). No per-server `timeout`: it is a hard limit. */
export function claudeMcpEntry(launcher: string): Json {
  return { type: "stdio", command: launcher, args: ["mcp", "--agent", "claude"] };
}

/** `.mcp.json` or `~/.claude.json` with `mcpServers.hotline` set (or removed). */
export function editClaudeMcp(
  text: string | undefined,
  label: string,
  launcher: string,
  remove: boolean,
): string | undefined {
  const settings = parseJsonConfig(text, label);
  const servers = settings.mcpServers ?? {};
  if (!isObject(servers))
    throw new AgentConfigError(`${label}: "mcpServers" is not an object; fix it by hand`);
  if (remove && !("hotline" in servers)) return text;
  const next: Json = { ...servers };
  if (remove) delete next.hotline;
  else next.hotline = claudeMcpEntry(launcher);
  const result: Json = { ...settings, mcpServers: next };
  if (Object.keys(next).length === 0) delete result.mcpServers;
  if (isDeepStrictEqual(result, settings)) return text;
  return formatJson(result);
}

function codexBlock(launcher: string): string {
  return [
    TOML_BEGIN,
    "[mcp_servers.hotline]",
    `command = ${JSON.stringify(launcher)}`,
    'args = ["mcp", "--agent", "codex"]',
    "# Codex does not reset this on progress; keep it above policy.askTimeoutMinutes.",
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    TOML_END,
  ].join("\n");
}

/** Where Hotline's managed block is, as [start, end) character offsets. */
function findBlock(text: string): [number, number] | undefined {
  const start = text.indexOf(TOML_BEGIN);
  if (start === -1) return undefined;
  const endMarker = text.indexOf(TOML_END, start);
  if (endMarker === -1) throw new AgentConfigError("Hotline's block in the Codex config has no end marker");
  let end = endMarker + TOML_END.length;
  if (text[end] === "\n") end++;
  return [start, end];
}

/** A TOML key or table name without spaces and quotes: `mcp_servers . 'hotline'` is `mcp_servers.hotline`. */
function bareKey(key: string): string {
  return key.replace(/["'\s]/g, "");
}

/**
 * Whether TOML text defines an `mcp_servers.hotline` server in any form:
 * `[mcp_servers.hotline]` (any quoting), `hotline = {...}` or `hotline.x = ...`
 * under `[mcp_servers]`, a dotted root key, or an inline `mcp_servers = {...}`.
 * A line scanner, not a TOML parser: it errs towards "yes", which only makes
 * `install` refuse.
 */
function definesHotlineServer(text: string): boolean {
  let table = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?([^\]]*)\]\]?/.exec(line);
    if (header) {
      table = bareKey(header[1] ?? "");
      if (table === "mcp_servers.hotline" || table.startsWith("mcp_servers.hotline.")) return true;
      continue;
    }
    const key = /^\s*([^=#]+?)\s*=/.exec(line);
    if (!key) continue;
    const name = table === "" ? bareKey(key[1] ?? "") : `${table}.${bareKey(key[1] ?? "")}`;
    if (name === "mcp_servers.hotline" || name.startsWith("mcp_servers.hotline.")) return true;
    if (name === "mcp_servers" && /\bhotline\b/.test(line)) return true;
  }
  return false;
}

/**
 * Codex `config.toml` with Hotline's `[mcp_servers.hotline]` table in a marked
 * block (or without it). A `hotline` server written by hand is never touched.
 */
export function editCodexToml(
  text: string | undefined,
  label: string,
  launcher: string,
  remove: boolean,
): string | undefined {
  const current = text ?? "";
  const block = findBlock(current);
  const outside = block === undefined ? current : current.slice(0, block[0]) + current.slice(block[1]);
  if (definesHotlineServer(outside)) {
    throw new AgentConfigError(
      `${label} already has an mcp_servers.hotline entry written by hand; remove it and run this again, or keep it and set tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    );
  }
  let result: string;
  if (block === undefined) {
    if (remove) return text;
    const separator =
      current === "" ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    result = `${current}${separator}${codexBlock(launcher)}\n`;
  } else if (remove) {
    let before = current.slice(0, block[0]);
    if (before.endsWith("\n\n")) before = before.slice(0, -1);
    result = before + current.slice(block[1]);
  } else {
    result = `${current.slice(0, block[0])}${codexBlock(launcher)}\n${current.slice(block[1])}`;
  }
  return result === current ? text : result;
}

// --- Readers for `hotline doctor` ---

export interface InstalledHook {
  event: "permission" | "stop";
  waitSeconds: number;
  timeoutSeconds: number;
}

/** Hotline's hooks in a hooks file, with their wait and timeout (defaults filled in). */
export function readHooks(
  text: string | undefined,
  label: string,
  agent: AgentFlag,
  launcher = "hotline",
): InstalledHook[] {
  const settings = parseJsonConfig(text, label);
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const found: InstalledHook[] = [];
  for (const event of Object.keys(HOOK_EVENTS) as HookEvent[]) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!isObject(hook) || !isHotlineHook(hook.command, agent, event, launcher)) continue;
        const wait = /--wait-seconds\s+(\d{1,6})\b/.exec(String(hook.command));
        found.push({
          event: HOOK_EVENTS[event],
          waitSeconds: wait ? Number(wait[1]) : DEFAULT_HOOK_WAIT_SECONDS,
          timeoutSeconds: typeof hook.timeout === "number" ? hook.timeout : DEFAULT_HOOK_TIMEOUT_SECONDS,
        });
      }
    }
  }
  return found;
}

/** Claude Code's `mcpServers.hotline`, if present, with its per-server `timeout` (ms) if set. */
export function readClaudeMcp(
  text: string | undefined,
  label: string,
): { installed: boolean; timeoutMs?: number } {
  const servers = parseJsonConfig(text, label).mcpServers;
  const entry = isObject(servers) ? servers.hotline : undefined;
  if (!isObject(entry)) return { installed: false };
  return typeof entry.timeout === "number"
    ? { installed: true, timeoutMs: entry.timeout }
    : { installed: true };
}

/** Codex's `[mcp_servers.hotline]` table, if present, with its `tool_timeout_sec` (Codex's default when unset). */
export function readCodexMcp(text: string | undefined): { installed: boolean; toolTimeoutSeconds: number } {
  const installed = definesHotlineServer(text ?? "");
  let table = "";
  for (const line of (text ?? "").split("\n")) {
    const header = /^\s*\[\[?([^\]]*)\]\]?/.exec(line);
    if (header) {
      table = bareKey(header[1] ?? "");
      continue;
    }
    const inHotline = table === "mcp_servers.hotline";
    // `tool_timeout_sec = N` in the table, or inside an inline `hotline = { ... }`.
    const inline = (table === "mcp_servers" && /^\s*["']?hotline["']?\s*=/.test(line)) || table === "";
    if (!inHotline && !inline) continue;
    if (inline && !/\bhotline\b/.test(line)) continue;
    const match = /\btool_timeout_sec\s*=\s*(\d+(?:\.\d+)?)/.exec(line);
    if (match) return { installed, toolTimeoutSeconds: Number(match[1]) };
  }
  return { installed, toolTimeoutSeconds: CODEX_DEFAULT_TOOL_TIMEOUT_SECONDS };
}
