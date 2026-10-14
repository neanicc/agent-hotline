// Which permission requests are high risk: approving one needs the owner's PIN or
// a confirming text, not just a spoken "yes" (plan section 12, question 6).
//
// The recommended set: deleting files, `git push`, network installs, writes
// outside the project, and anything touching credentials. Hotline adds a few
// cases it cannot assess at all (sudo, nested shell code, tools it does not
// know, input it cannot read), because a request it cannot read must not count
// as harmless.
//
// This is a heuristic over agent-written text, not a sandbox: a determined agent
// can disguise a command. It only decides how much proof the owner gives; a
// low-risk request still needs the owner's own "yes", and every failure denies.
// Pure: no I/O, no Node modules. Paths are resolved as POSIX strings.
import type { Risk } from "./contracts.js";

export type RiskReason =
  | "deletes files"
  | "pushes or rewrites git history"
  | "installs or downloads from the network"
  | "writes outside the project"
  | "touches credentials or agent settings"
  | "runs with elevated privileges"
  | "runs nested code Hotline cannot read"
  | "uses a tool Hotline does not know"
  | "has input Hotline cannot read";

export interface PermissionRisk {
  risk: Risk;
  /** Why it is high risk, in a stable order; empty when low. */
  reasons: RiskReason[];
}

export interface PermissionRequestFacts {
  toolName: string;
  /** The agent's tool input, untouched. Untrusted. */
  toolInput: unknown;
  /** The session's working directory: the project. */
  cwd: string;
}

/** Tools that change files: the path fields to check. */
const FILE_WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};

/** Tools that only read or plan: low unless they point at credentials. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ExitPlanMode",
]);

const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "shell", "exec_command", "local_shell"]);

const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch"]);

// A command word: at the start, or after whitespace, a separator, a quote or a
// subshell opener, and followed by the end, whitespace or a separator.
const word = (names: string) => new RegExp(`(?:^|[\\s;&|(){}\`'"!])(?:${names})(?=$|[\\s;&|()<>'"])`, "i");

const DELETES = [
  word("rm|rmdir|unlink|shred|srm|trash"),
  /\s-delete\b/,
  /\bgit\s+(?:-\S+\s+)*(?:rm|clean)\b/,
];
const GIT_HISTORY = [
  /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/,
  /\bgit\s+(?:-\S+\s+)*reset\s+(?:\S+\s+)*--hard\b/,
  /\bgit\s+(?:-\S+\s+)*branch\s+(?:\S+\s+)*(?:-D|--delete)\b/,
  /\bgit\s+(?:-\S+\s+)*(?:filter-branch|filter-repo)\b/,
  /\bgit\s+(?:-\S+\s+)*stash\s+(?:drop|clear)\b/,
];
const NETWORK = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*(?:i|install|add|ci|update|upgrade|up|dlx|x|exec|create|global)\b/,
  word("npx|bunx|pnpx|curl|wget|scp|rsync|ssh|sftp|ftp|nc|ncat|telnet"),
  /\bpip[0-9.]*\s+(?:-\S+\s+)*install\b/,
  /\b-m\s+pip\s+install\b/,
  /\b(?:uv|pipx|poetry)\s+(?:pip\s+install|add|install|tool\s+install|run)\b/,
  /\bbrew\s+(?:install|upgrade|reinstall|tap|bundle)\b/,
  /\bcargo\s+(?:install|add)\b/,
  /\bgo\s+(?:install|get)\b/,
  /\bgem\s+install\b/,
  /\bapt(?:-get)?\s+(?:-\S+\s+)*install\b/,
  /\b(?:port|nix-env|conda|mamba)\s+(?:-\S+\s+)*install\b/,
  /\bgit\s+(?:-\S+\s+)*(?:clone|fetch|pull|submodule\s+update)\b/,
  /\bdocker\s+(?:pull|run|push|login)\b/,
];
const ELEVATED = [word("sudo|doas|su")];
const NESTED = [
  word("eval|exec|source|osascript"),
  /\b(?:ba|z|da|k|fi)?sh\s+(?:-\S+\s+)*-c\b/,
  /\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/,
  /\b(?:python[0-9.]*|node|perl|ruby|php|deno|bun)\s+(?:-\S+\s+)*-(?:c|e|-eval)\b/,
];

/** Paths that hold secrets, or settings an agent could use to approve itself. */
const CREDENTIAL_PATH =
  /(?:^|[/\\\s'"=])(?:\.env(?:\.[\w.-]+)?|\.envrc|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.hotline|\.claude|\.codex|\.config\/gh|id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks))(?=$|[/\\\s'"])|keychain/i;
/** Words in a shell command that suggest it reads or moves credentials. */
const CREDENTIAL_WORDS = [
  CREDENTIAL_PATH,
  /(?<![a-z])(?:password|passwd|token|api[_-]?key|private[_-]?key|secret)s?(?![a-z])/i,
  /\bHOTLINE_HOME\b/,
  word("printenv"),
  /\bsecurity\s+(?:find|dump|export|add|delete)-/,
  /\b(?:gh|npm|docker|gcloud|aws|az)\s+(?:auth|login|logout|config)\b/,
];

/** Commands or redirections that write somewhere. */
const WRITES = [
  /(?:^|[^0-9&<>])>{1,2}(?!&)/,
  word("tee|cp|mv|ln|mkdir|touch|chmod|chown|chgrp|install|dd|truncate|tar|unzip|patch|rsync|curl|wget"),
  /\bsed\s+(?:-\S+\s+)*-i/,
  /\bgit\s+-C\b/,
];
/** Places a write to which is harmless. */
const HARMLESS_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);
const PATH_TOKEN =
  /(?:^|[\s=<>'"(])((?:~|\$HOME|\$\{HOME\})(?:\/[^\s;&|<>'"()]*)?|\/[^\s;&|<>'"()]*|(?:\.\.\/)+[^\s;&|<>'"()]*|\.\.(?=$|[\s;&|<>'"()]))/g;

/** POSIX path resolution of `path` against `base`, without touching the file system. */
export function resolvePosix(base: string, path: string): string {
  const parts: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** Whether `path` (absolute, or relative to `cwd`) is inside the project at `cwd`. */
export function insideProject(cwd: string, path: string): boolean {
  if (/^(?:~|\$HOME|\$\{HOME\})/.test(path)) return false;
  if (!cwd.startsWith("/")) return false;
  const root = resolvePosix("/", cwd);
  const target = resolvePosix(root, path);
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** The command text of a shell tool call: a string, or an argv array joined with spaces. */
export function shellCommand(input: unknown): string | undefined {
  const value =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).command
        : undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return undefined;
}

function shellReasons(command: string, cwd: string): RiskReason[] {
  const reasons = new Set<RiskReason>();
  if (matchesAny(command, DELETES)) reasons.add("deletes files");
  if (matchesAny(command, GIT_HISTORY)) reasons.add("pushes or rewrites git history");
  if (matchesAny(command, NETWORK)) reasons.add("installs or downloads from the network");
  if (matchesAny(command, ELEVATED)) reasons.add("runs with elevated privileges");
  if (matchesAny(command, NESTED)) reasons.add("runs nested code Hotline cannot read");
  // The project's own path may contain `.claude` or `secrets` (a worktree, say): judge what is below it.
  const root = cwd.startsWith("/") ? resolvePosix("/", cwd) : "/";
  const belowProject = root === "/" ? command : command.split(root).join(".");
  if (matchesAny(belowProject, CREDENTIAL_WORDS)) reasons.add("touches credentials or agent settings");
  if (matchesAny(command, WRITES)) {
    for (const match of command.matchAll(PATH_TOKEN)) {
      const path = match[1] ?? "";
      if (HARMLESS_TARGETS.has(path)) continue;
      if (!insideProject(cwd, path)) {
        reasons.add("writes outside the project");
        break;
      }
    }
  }
  return [...reasons];
}

/** Files an `apply_patch` envelope touches, and whether it deletes any. Undefined when it has none. */
export function patchFiles(patch: string): { paths: string[]; deletes: boolean } | undefined {
  const paths: string[] = [];
  let deletes = false;
  for (const match of patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    paths.push((match[2] ?? "").trim());
    if (match[1] === "Delete File") deletes = true;
  }
  return paths.length === 0 ? undefined : { paths, deletes };
}

function pathReasons(paths: readonly string[], cwd: string): RiskReason[] {
  const reasons = new Set<RiskReason>();
  for (const path of paths) {
    if (path.trim() === "") reasons.add("has input Hotline cannot read");
    else if (!insideProject(cwd, path)) reasons.add("writes outside the project");
    if (credentialPath(cwd, path)) reasons.add("touches credentials or agent settings");
  }
  return [...reasons];
}

/** Whether `path` names a credential or settings file. Inside the project only the part below it counts. */
function credentialPath(cwd: string, path: string): boolean {
  if (!insideProject(cwd, path)) return CREDENTIAL_PATH.test(path);
  const root = resolvePosix("/", cwd);
  return CREDENTIAL_PATH.test(resolvePosix(root, path).slice(root === "/" ? 0 : root.length));
}

const ORDER: readonly RiskReason[] = [
  "deletes files",
  "pushes or rewrites git history",
  "installs or downloads from the network",
  "writes outside the project",
  "touches credentials or agent settings",
  "runs with elevated privileges",
  "runs nested code Hotline cannot read",
  "uses a tool Hotline does not know",
  "has input Hotline cannot read",
];

function verdict(reasons: readonly RiskReason[]): PermissionRisk {
  const sorted = ORDER.filter((reason) => reasons.includes(reason));
  return { risk: sorted.length > 0 ? "high" : "low", reasons: sorted };
}

/**
 * The risk class of a permission request. High needs the PIN or a confirming
 * text to approve. Anything Hotline cannot read or does not know is high.
 */
export function classifyPermission({ toolName, toolInput, cwd }: PermissionRequestFacts): PermissionRisk {
  if (SHELL_TOOLS.has(toolName)) {
    const command = shellCommand(toolInput);
    if (command === undefined || command.trim() === "") return verdict(["has input Hotline cannot read"]);
    return verdict(shellReasons(command, cwd));
  }
  if (PATCH_TOOLS.has(toolName)) {
    const patch = shellCommand(toolInput);
    const files = patch === undefined ? undefined : patchFiles(patch);
    if (files === undefined) return verdict(["has input Hotline cannot read"]);
    return verdict([
      ...(files.deletes ? (["deletes files"] as const) : []),
      ...pathReasons(files.paths, cwd),
    ]);
  }
  const writeFields = Object.hasOwn(FILE_WRITE_TOOLS, toolName) ? FILE_WRITE_TOOLS[toolName] : undefined;
  if (writeFields !== undefined) {
    const paths = writeFields.map((field) => stringField(toolInput, field));
    if (paths.some((path) => path === undefined)) return verdict(["has input Hotline cannot read"]);
    return verdict(pathReasons(paths as string[], cwd));
  }
  if (READ_TOOLS.has(toolName)) {
    const paths = ["file_path", "path", "notebook_path"].map((field) => stringField(toolInput, field));
    const patterns = ["url", "pattern", "glob"].map((field) => stringField(toolInput, field));
    const credentials =
      paths.some((path) => path !== undefined && credentialPath(cwd, path)) ||
      patterns.some((pattern) => pattern !== undefined && CREDENTIAL_PATH.test(pattern));
    return verdict(credentials ? ["touches credentials or agent settings"] : []);
  }
  // MCP tools (`mcp__server__tool`) and anything else: Hotline cannot tell what they do.
  return verdict(["uses a tool Hotline does not know"]);
}
