// Which permission requests are high risk: approving one needs the owner's PIN or
// a confirming text, not just a spoken "yes" (plan section 12, question 6).
//
// The recommended set is deleting files, `git push`, network installs, writes
// outside the project, and anything touching credentials. A denylist of those
// is easy to slip past (`/bin/rm`, `$(...)`, `command rm`, `git -c alias...`),
// so shell commands are judged the other way round: a command is low risk only
// when every simple command in it is on a short allowlist of read-only commands
// with safe arguments. Anything else, including anything Hotline cannot parse,
// is high. The denylist below only names the reasons the owner hears.
//
// It decides how much proof the owner gives. A low-risk request still needs the
// owner's own "yes", and every failure denies.
// Pure: no I/O, no Node modules. Paths are resolved as POSIX strings.
import type { Risk } from "./contracts.js";

export type RiskReason =
  | "deletes files"
  | "pushes or rewrites git history"
  | "installs or downloads from the network"
  | "sends data off the machine"
  | "writes outside the project"
  | "touches credentials or agent settings"
  | "runs with elevated privileges"
  | "runs nested code Hotline cannot read"
  | "runs a command Hotline does not recognise as read-only"
  | "uses a tool Hotline does not know"
  | "has input Hotline cannot read"
  | "is too long to read out in full";

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
  "WebSearch",
  "TodoWrite",
  "ExitPlanMode",
]);

/** Tools that send what they are given to another host. */
const SENDING_TOOLS: ReadonlySet<string> = new Set(["WebFetch"]);

const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "shell", "exec_command", "local_shell"]);

/** Whether the tool runs a shell command (its `command` input is shown to the owner). */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch"]);

// ---------------------------------------------------------------------------
// Paths

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

/**
 * The project root for a session's `cwd`, or undefined when there is no known
 * project: an empty or relative cwd, `/`, a top-level directory such as `/tmp`,
 * or a home directory (`/Users/<name>`, `/home/<name>`). Then every path counts
 * as outside the project.
 */
export function projectRoot(cwd: string): string | undefined {
  if (!cwd.startsWith("/")) return undefined;
  const root = resolvePosix("/", cwd);
  if (/^\/[^/]*$/.test(root)) return undefined;
  if (/^\/(?:Users|home)\/[^/]+$/.test(root) || root === "/var/root") return undefined;
  return root;
}

/** Whether `path` (absolute, or relative to `cwd`) is inside a known project at `cwd`. */
export function insideProject(cwd: string, path: string): boolean {
  if (path === "" || /^(?:~|\$)/.test(path)) return false;
  const root = projectRoot(cwd);
  if (root === undefined) return false;
  const target = resolvePosix(root, path);
  return target === root || target.startsWith(`${root}/`);
}

/** Paths that hold secrets, or settings an agent could use to approve itself or run code. */
const CREDENTIAL_PATH =
  /(?:^|[/\\\s'"=])(?:\.env(?:\.[\w.-]+)?|\.envrc|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.hotline|\.claude|\.codex|\.config\/gh|\.git\/(?:config|hooks)|\.gitattributes|id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks))(?=$|[/\\\s'"])|keychain/i;

/** Whether `path` names a credential or settings file. Inside the project only the part below it counts. */
function credentialPath(cwd: string, path: string): boolean {
  const root = projectRoot(cwd);
  if (root === undefined || !insideProject(cwd, path)) return CREDENTIAL_PATH.test(path);
  return CREDENTIAL_PATH.test(resolvePosix(root, path).slice(root.length));
}

// ---------------------------------------------------------------------------
// Shell: reasons the owner hears (a denylist, for labels only)

// A command word: at the start, or after whitespace, a separator, a quote, a
// slash (`/bin/rm`) or a subshell opener, and followed by the end, whitespace or
// a separator.
const word = (names: string) =>
  new RegExp(`(?:^|[\\s;&|(){}\`'"!/=$])(?:${names})(?=$|[\\s;&|()<>'"\`])`, "i");

const DELETES = [word("rm|rmdir|unlink|shred|srm|trash"), /\s-delete\b/, /\bgit\b.*\b(?:rm|clean)\b/];
const GIT_HISTORY = [
  /\bgit\b.*\bpush\b/,
  /\bgit\b.*\breset\b.*--hard\b/,
  /\bgit\b.*\bbranch\b.*(?:-D|--delete)\b/,
  /\bgit\b.*\b(?:filter-branch|filter-repo)\b/,
  /\bgit\b.*\bstash\s+(?:drop|clear)\b/,
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
  /\bgit\b.*\b(?:clone|fetch|pull|submodule\s+update)\b/,
  /\bdocker\s+(?:pull|run|push|login)\b/,
];
const ELEVATED = [word("sudo|doas|su")];
const NESTED = [
  /`|\$\(|\$\{|<\(|>\(/,
  word("eval|exec|source|osascript|xargs|env|command|builtin|nohup|time|watch|parallel"),
  /\b(?:ba|z|da|k|fi)?sh\s+(?:-\S+\s+)*-c\b/,
  /\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/,
  /\b(?:python[0-9.]*|node|perl|ruby|php|deno|bun)\s+(?:-\S+\s+)*-(?:c|e|-eval)\b/,
];
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
];
const HARMLESS_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);
const PATH_TOKEN =
  /(?:^|[\s=<>'"(])((?:~|\$HOME|\$\{HOME\})(?:\/[^\s;&|<>'"()]*)?|\/[^\s;&|<>'"()]*|(?:\.\.\/)+[^\s;&|<>'"()]*|\.\.(?=$|[\s;&|<>'"()]))/g;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function labelReasons(command: string, cwd: string): RiskReason[] {
  const reasons = new Set<RiskReason>();
  if (matchesAny(command, DELETES)) reasons.add("deletes files");
  if (matchesAny(command, GIT_HISTORY)) reasons.add("pushes or rewrites git history");
  if (matchesAny(command, NETWORK)) reasons.add("installs or downloads from the network");
  if (matchesAny(command, ELEVATED)) reasons.add("runs with elevated privileges");
  if (matchesAny(command, NESTED)) reasons.add("runs nested code Hotline cannot read");
  // The project's own path may contain `.claude` or `secrets` (a worktree, say): judge what is below it.
  const root = projectRoot(cwd);
  const belowProject = root === undefined ? command : command.split(root).join(".");
  if (matchesAny(belowProject, CREDENTIAL_WORDS)) reasons.add("touches credentials or agent settings");
  if (matchesAny(command, WRITES)) {
    for (const match of command.matchAll(PATH_TOKEN)) {
      const path = match[1] ?? "";
      if (!HARMLESS_TARGETS.has(path) && !insideProject(cwd, path)) {
        reasons.add("writes outside the project");
        break;
      }
    }
  }
  return [...reasons];
}

// ---------------------------------------------------------------------------
// Shell: the allowlist that decides

interface Redirect {
  /** `>`, `>>`, `<`, `&>`, `&>>`, or `dup` for `2>&1` and the like. */
  op: string;
  target: string;
}

interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
}

/**
 * Splits a command line into simple commands on `;`, `&&`, `||`, `|` and
 * newlines, with single and double quotes. Returns undefined for anything it
 * does not fully understand: substitutions, variables, escapes, globs of
 * control characters, subshells, background jobs, here-documents, comments and
 * unbalanced quotes. Undefined always means high risk.
 */
export function splitShell(command: string): SimpleCommand[] | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched for display.
  if (/[`$\\\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) return undefined;
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pending: string | undefined;
  let needsCommand = false;

  const endWord = (): boolean => {
    if (!inWord) return true;
    if (pending !== undefined) {
      if (pending === "dup" && !/^(?:\d+|-)$/.test(word)) current.redirects.push({ op: ">", target: word });
      else current.redirects.push({ op: pending, target: word });
      pending = undefined;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
    return true;
  };
  const endCommand = (strict: boolean): boolean => {
    endWord();
    if (pending !== undefined) return false;
    const empty = current.words.length === 0 && current.redirects.length === 0;
    if (empty && (strict || needsCommand)) return false;
    if (!empty) commands.push(current);
    current = { words: [], redirects: [] };
    needsCommand = strict;
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    const next = command[i + 1];
    if (c === " " || c === "\t") {
      endWord();
    } else if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close === -1) return undefined;
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === ";" || c === "\n") {
      if (!endCommand(false)) return undefined;
    } else if (c === "|") {
      if (next === "&") return undefined;
      if (next === "|") i++;
      if (!endCommand(true)) return undefined;
    } else if (c === "&") {
      if (next === "&") {
        i++;
        if (!endCommand(true)) return undefined;
      } else if (next === ">") {
        endWord();
        if (pending !== undefined) return undefined;
        i++;
        if (command[i + 1] === ">") i++;
        pending = "&>";
      } else {
        return undefined;
      }
    } else if (c === ">" || c === "<") {
      // A bare number right before the operator is a file descriptor (`2>`).
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      if (pending !== undefined) return undefined;
      if (c === "<" && (next === "<" || next === ">" || next === "(")) return undefined;
      if (c === ">" && next === "(") return undefined;
      if (next === "&") {
        i++;
        pending = "dup";
      } else if (c === ">" && (next === ">" || next === "|")) {
        i++;
        pending = next === ">" ? ">>" : ">";
      } else {
        pending = c;
      }
    } else if (c === "(" || c === ")" || (c === "#" && !inWord)) {
      return undefined;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (!endCommand(false) || needsCommand) return undefined;
  return commands;
}

/** Read-only commands whose arguments are options or paths. Values: options they must not have. */
const READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  ls: [],
  pwd: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  grep: [],
  egrep: [],
  fgrep: [],
  rg: ["--pre", "--pre-glob", "-z", "--search-zip"],
  find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"],
  echo: [],
  diff: [],
  du: [],
  tree: ["-o"],
};
const GIT_READ_ONLY: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
]);
const GIT_FORBIDDEN_OPTIONS = ["--output", "--ext-diff"];
const GIT_BRANCH_LIST_OPTIONS: ReadonlySet<string> = new Set([
  "-a",
  "-r",
  "-l",
  "-v",
  "-vv",
  "--list",
  "--all",
  "--remotes",
  "--show-current",
  "--no-color",
]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_SCRIPTS: ReadonlySet<string> = new Set(["test", "build", "lint", "typecheck"]);

/** An argument is safe when it is inside a known project and names no credential. */
function safeArgument(arg: string, cwd: string): boolean {
  if (arg.startsWith("-")) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
    return value === "" || safeArgument(value, cwd);
  }
  if (CREDENTIAL_PATH.test(arg) && credentialPath(cwd, arg)) return false;
  return insideProject(cwd, arg);
}

/** Whether any argument is one of `options`, also as `--opt=value`, `-xVALUE` or in a cluster such as `-iz`. */
function forbidden(args: readonly string[], options: readonly string[]): boolean {
  return args.some((arg) =>
    options.some((option) => {
      if (arg === option || arg.startsWith(`${option}=`)) return true;
      const short = /^-[A-Za-z]$/.test(option) ? (option[1] ?? "") : undefined;
      return short !== undefined && /^-[A-Za-z]/.test(arg) && !arg.startsWith("--") && arg.includes(short);
    }),
  );
}

function readOnlyCommand({ words, redirects }: SimpleCommand, cwd: string): boolean {
  for (const { op, target } of redirects) {
    if (op === "dup") continue;
    if (target === "/dev/null") continue;
    if (!safeArgument(target, cwd) || target.startsWith("-")) return false;
  }
  const [name, ...args] = words;
  if (name === undefined || name.includes("/") || name.includes("=")) return false;
  if (Object.hasOwn(READ_ONLY, name)) {
    if (forbidden(args, READ_ONLY[name] ?? [])) return false;
    return args.every((arg) => safeArgument(arg, cwd));
  }
  if (name === "git") {
    const [sub, ...rest] = args;
    if (sub === undefined || !GIT_READ_ONLY.has(sub) || forbidden(rest, GIT_FORBIDDEN_OPTIONS)) return false;
    if (sub === "branch") return rest.every((arg) => GIT_BRANCH_LIST_OPTIONS.has(arg));
    // Revisions (`HEAD~2`, `main`) pass; anything that could be a path is checked like one.
    const pathLike = (arg: string) => /[/~]/.test(arg) || arg.startsWith(".") || CREDENTIAL_PATH.test(arg);
    return rest.every(
      (arg) => (arg.startsWith("-") && !arg.includes("=")) || !pathLike(arg) || safeArgument(arg, cwd),
    );
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const [first, second, ...more] = args;
    const script = first === "run" ? second : first;
    const rest = first === "run" ? more : [second, ...more].filter((arg) => arg !== undefined);
    if (script === undefined || !PACKAGE_SCRIPTS.has(script)) return false;
    return rest.every((arg) => arg === "--" || safeArgument(arg, cwd));
  }
  return false;
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
    // An argv array is one command; quote each part so the split keeps it whole.
    return value
      .map((part) => (/^[\w./:@%+,-]+$/.test(part) ? part : `'${part.replace(/'/g, "")}'`))
      .join(" ");
  }
  return undefined;
}

function shellReasons(command: string, cwd: string): RiskReason[] {
  const reasons = labelReasons(command, cwd);
  const commands = splitShell(command);
  const readOnly =
    commands !== undefined && commands.length > 0 && commands.every((simple) => readOnlyCommand(simple, cwd));
  if (!readOnly && reasons.length === 0)
    reasons.push("runs a command Hotline does not recognise as read-only");
  return readOnly ? [] : reasons;
}

// ---------------------------------------------------------------------------
// Other tools

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

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

const ORDER: readonly RiskReason[] = [
  "deletes files",
  "pushes or rewrites git history",
  "installs or downloads from the network",
  "sends data off the machine",
  "writes outside the project",
  "touches credentials or agent settings",
  "runs with elevated privileges",
  "runs nested code Hotline cannot read",
  "runs a command Hotline does not recognise as read-only",
  "uses a tool Hotline does not know",
  "has input Hotline cannot read",
  "is too long to read out in full",
];

function verdict(reasons: readonly RiskReason[]): PermissionRisk {
  const sorted = ORDER.filter((reason) => reasons.includes(reason));
  return { risk: sorted.length > 0 ? "high" : "low", reasons: sorted };
}

/** `risk` made high for `reason`, keeping any reasons it already had. */
export function withRiskReason(risk: PermissionRisk, reason: RiskReason): PermissionRisk {
  return verdict([...risk.reasons, reason]);
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
  if (SENDING_TOOLS.has(toolName)) return verdict(["sends data off the machine"]);
  if (READ_TOOLS.has(toolName)) {
    const paths = ["file_path", "path", "notebook_path"].map((field) => stringField(toolInput, field));
    const patterns = ["pattern", "glob", "query"].map((field) => stringField(toolInput, field));
    const credentials =
      paths.some((path) => path !== undefined && credentialPath(cwd, path)) ||
      patterns.some((pattern) => pattern !== undefined && CREDENTIAL_PATH.test(pattern));
    return verdict(credentials ? ["touches credentials or agent settings"] : []);
  }
  // MCP tools (`mcp__server__tool`) and anything else: Hotline cannot tell what they do.
  return verdict(["uses a tool Hotline does not know"]);
}
