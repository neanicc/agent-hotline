// `hotline install <claude|codex> [--project] [--uninstall]`: writes (or removes)
// the MCP server and hook entries from docs/mcp.md and docs/hooks.md in the
// agent's config files. Each changed file gets a timestamped backup first, and
// the change is printed as a diff. Running it twice changes nothing.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_FLAGS,
  AgentConfigError,
  type AgentFlag,
  checkLauncher,
  editClaudeMcp,
  editCodexToml,
  editHooks,
} from "./agent-config.js";
import type { CliContext, Output } from "./cli.js";
import { isTestMode } from "./setup.js";
import { lineDiff } from "./text-diff.js";

export function installUsage(): string {
  return [
    "Usage: hotline install <claude|codex> [--project] [--uninstall] [--dry-run]",
    "                       [--command <path>] [--home <dir>]",
    "",
    "Adds the Hotline MCP server and the permission and Stop hooks to the agent's",
    "config (docs/mcp.md, docs/hooks.md). Every changed file is backed up first",
    "(<file>.hotline-backup-<time>) and the change is printed as a diff. Running it",
    "again changes nothing. It never changes permission modes or other settings.",
    "",
    "  claude   ~/.claude.json (MCP) and ~/.claude/settings.json (hooks)",
    "           --project: .mcp.json and .claude/settings.json in this folder",
    "  codex    ~/.codex/config.toml (MCP) and ~/.codex/hooks.json (hooks), or $CODEX_HOME",
    "           --project: .codex/config.toml and .codex/hooks.json in this folder",
    "",
    "Options:",
    "  --project          Install for the project in the current folder",
    "  --uninstall        Remove Hotline's entries instead",
    "  --dry-run          Print the diff without writing anything",
    "  --command <path>   Absolute path of the hotline executable (default: hotline on PATH)",
    "  --home <dir>       Use <dir> instead of your home folder (required in test mode)",
  ].join("\n");
}

export interface ConfigLocation {
  /** The user's home folder (or the `--home` override). */
  home: string;
  /** The project folder, for `--project`. */
  project?: string;
  /** `$CODEX_HOME`, where Codex keeps its user config when set. */
  codexHome?: string;
}

/** The MCP and hooks config files of an agent, user-level or for one project. */
export function agentConfigFiles(agent: AgentFlag, where: ConfigLocation): { mcp: string; hooks: string } {
  if (agent === "claude") {
    return where.project === undefined
      ? { mcp: join(where.home, ".claude.json"), hooks: join(where.home, ".claude", "settings.json") }
      : { mcp: join(where.project, ".mcp.json"), hooks: join(where.project, ".claude", "settings.json") };
  }
  const dir =
    where.project === undefined
      ? (where.codexHome ?? join(where.home, ".codex"))
      : join(where.project, ".codex");
  return { mcp: join(dir, "config.toml"), hooks: join(dir, "hooks.json") };
}

/**
 * Where the agent configs are: `--home` or the user's home, `$CODEX_HOME` unless
 * `--home` is given, and the current folder for `--project`. Throws on a bad path.
 */
export function configLocation(
  context: CliContext,
  home: string | undefined,
  project: boolean,
): ConfigLocation {
  if (home !== undefined && !isAbsolute(home)) throw new Error("--home must be an absolute path");
  const where: ConfigLocation = { home: resolve(home ?? context.homeDir) };
  if (project) where.project = resolve(context.cwd ?? process.cwd());
  const codexHome = context.env.CODEX_HOME;
  if (home === undefined && codexHome) {
    if (!isAbsolute(codexHome)) throw new Error("CODEX_HOME must be an absolute path");
    where.codexHome = codexHome;
  }
  return where;
}

/** The file's text and mode, or undefined when it does not exist. Refuses symlinks and non-files. */
export async function readConfigFile(path: string): Promise<{ text: string; mode: number } | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new AgentConfigError(`${path} is a symbolic link; add the entries by hand (see docs/install.md)`);
  }
  if (!info.isFile()) throw new AgentConfigError(`${path} is not a regular file`);
  return { text: await readFile(path, "utf8"), mode: info.mode & 0o777 };
}

function stamp(now: Date): string {
  // 20261014T120000.123Z: milliseconds, so two runs in one second get different backups.
  return now.toISOString().replace(/[-:]/g, "");
}

async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function within(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

type Edit = (text: string | undefined, label: string) => string | undefined;

export async function installCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  let agent: AgentFlag | undefined;
  let project = false;
  let remove = false;
  let dryRun = false;
  let launcher = "hotline";
  let home: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      out.stdout(installUsage());
      return 0;
    }
    if (arg === "--project") project = true;
    else if (arg === "--uninstall") remove = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--command" || arg === "--home") {
      const value = args[++index];
      if (value === undefined || value === "") {
        out.stderr(`hotline install: ${arg} needs a value\n\n${installUsage()}`);
        return 2;
      }
      if (arg === "--command") launcher = value;
      else home = value;
    } else if (AGENT_FLAGS.includes(arg as AgentFlag) && agent === undefined) agent = arg as AgentFlag;
    else {
      out.stderr(`hotline install: unexpected "${arg}"\n\n${installUsage()}`);
      return 2;
    }
  }
  if (agent === undefined) {
    out.stderr(`hotline install: say which agent: claude or codex\n\n${installUsage()}`);
    return 2;
  }
  // Tests must never reach the developer's real ~/.claude or ~/.codex.
  if (isTestMode(context) && home === undefined) {
    out.stderr("hotline install: test mode needs --home <temporary directory>");
    return 2;
  }
  let where: ConfigLocation;
  try {
    checkLauncher(launcher);
    where = configLocation(context, home, project);
  } catch (error) {
    out.stderr(`hotline install: ${(error as Error).message}`);
    return 2;
  }
  if (isTestMode(context) && where.project !== undefined && !within(where.project, where.home)) {
    out.stderr("hotline install: test mode needs the project folder inside --home");
    return 2;
  }

  const files = agentConfigFiles(agent, where);
  const editMcp: Edit =
    agent === "claude"
      ? (text, label) => editClaudeMcp(text, label, launcher, remove)
      : (text, label) => editCodexToml(text, label, launcher, remove);
  const editHookFile: Edit = (text, label) => editHooks(text, label, agent, launcher, remove);
  const now = (context.now ?? (() => new Date()))();
  let changed = 0;
  try {
    for (const [path, edit] of [
      [files.mcp, editMcp],
      [files.hooks, editHookFile],
    ] as const) {
      const current = await readConfigFile(path);
      const next = edit(current?.text, path);
      if (next === undefined || next === current?.text) {
        out.stdout(`unchanged: ${path}`);
        continue;
      }
      changed++;
      out.stdout(lineDiff(path, current?.text ?? "", next));
      if (dryRun) continue;
      if (current !== undefined) {
        const backup = `${path}.hotline-backup-${stamp(now)}`;
        // COPYFILE_EXCL: never overwrite an earlier backup. Backups can hold
        // private settings, so only the owner may read them.
        await copyFile(path, backup, constants.COPYFILE_EXCL);
        await chmod(backup, 0o600);
        out.stdout(`backup: ${backup}`);
      } else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      }
      await writeAtomically(path, next, current?.mode ?? 0o600);
      out.stdout(`${remove ? "removed Hotline from" : "wrote"}: ${path}`);
    }
  } catch (error) {
    out.stderr(`hotline install: ${(error as Error).message}`);
    return 1;
  }
  if (dryRun) out.stdout(`dry run: ${changed} file(s) would change; nothing was written`);
  else if (remove || changed === 0) return 0;
  else if (agent === "codex")
    out.stdout("Codex runs a new hook only after you trust it: open Codex and run /hooks.");
  else {
    out.stdout(
      "Claude Code: set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=2400000 where Claude Code starts, so a long wait is not cut off (docs/mcp.md).",
    );
  }
  return 0;
}
