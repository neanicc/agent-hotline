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
// The tokenizer accepts only what bash and zsh read the same way (no
// expansions, substitutions, escapes or non-ASCII), and Hotline does not see the
// shell's aliases or PATH, so this is a classification of the text, not a
// sandbox. The allowlisted package scripts (`test`, `build`, `lint`,
// `typecheck`) and git commands run project code and repository config: writing
// that config (`.git/`, `package.json`, `node_modules/`, package-manager rc
// files) is high risk, but a script the owner already let the agent edit runs
// as low risk. What protects the owner there is that low risk still needs their
// explicit "yes" to this command.
//
// The classifier only decides how much proof an approval needs (the PIN or a
// confirming text, or the owner's spoken "yes"), never whether one is needed:
// every permission request needs the owner's own approval, and every failure
// denies. Sensitive names are matched case-insensitively after NFC
// normalisation, because macOS file systems ignore both by default. Bypass
// classes not covered here are tracked for HL-13's fuzzing.
//
// What is judged must be what runs (HL-06b). The command text and paths are
// judged against the session's cwd, so any other tool input field that could
// change what runs, or where, makes the request high: a working directory, an
// environment, a sandbox or escalation setting, a background flag, or any field
// Hotline does not know. So does `cd`, `pushd` or `popd` anywhere in a command,
// because Claude Code's Bash tool keeps its working directory between calls and
// later commands would no longer run where Hotline judged them. Codex sends
// neither the folder a command runs in nor its sandbox setting to the hook, so
// a Codex shell request is always high (see `actionFields` and docs/hooks.md).
// Pure: no I/O, no Node modules. Paths are resolved as POSIX strings.
import type { AgentKind, Risk } from "./contracts.js";

export type RiskReason =
  | "deletes files"
  | "pushes or rewrites git history"
  | "installs or downloads from the network"
  | "sends data off the machine"
  | "writes outside the project"
  | "touches credentials or agent settings"
  | "runs with elevated privileges"
  | "asks to run outside the sandbox"
  | "asks for network access"
  | "asks to run in another folder"
  | "may run in another folder or outside the sandbox"
  | "asks to run in the background"
  | "asks to set environment variables"
  | "runs nested code Hotline cannot read"
  | "runs a command Hotline does not recognise as read-only"
  | "uses a tool Hotline does not know"
  | "has a setting Hotline does not know"
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
  /** The session's working directory: the project. Relative paths and commands are judged against it. */
  cwd: string;
  /**
   * The agent that asked, when known. Codex's hook payload leaves out the folder
   * a shell command runs in and its sandbox setting, so a Codex shell request is
   * high; without `agent` only the payload itself is judged.
   */
  agent?: AgentKind;
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
// Fields that change what runs (HL-06b)

/**
 * Shell tool input fields that change how or where a command runs, and what the
 * owner hears for each. Names from the Claude Code hooks reference ("PreToolUse
 * input", Bash), the Claude Code 2.1.299 Bash input schema (`run_in_background`,
 * `dangerouslyDisableSandbox`, `allowed_domains`), and Codex's tool arguments:
 * `exec_command` (`workdir`, `sandbox_permissions`, `additional_permissions`,
 * `justification`), `local_shell` (`working_directory`, `env`) and the older
 * `shell` tool (`workdir`, `with_escalated_permissions`). Any field not listed
 * here and not benign is "has a setting Hotline does not know".
 */
const SHELL_FIELD_REASONS: ReadonlyMap<string, RiskReason> = new Map<string, RiskReason>([
  ["workdir", "asks to run in another folder"],
  ["working_directory", "asks to run in another folder"],
  ["cwd", "asks to run in another folder"],
  ["env", "asks to set environment variables"],
  ["run_in_background", "asks to run in the background"],
  ["dangerouslyDisableSandbox", "asks to run outside the sandbox"],
  ["with_escalated_permissions", "asks to run outside the sandbox"],
  ["sandbox_permissions", "asks to run outside the sandbox"],
  ["additional_permissions", "asks to run outside the sandbox"],
  ["justification", "asks to run outside the sandbox"],
  ["allowed_domains", "asks for network access"],
]);

/** Flags that change nothing when they are `false`, their documented default. */
const OFF_WHEN_FALSE: ReadonlySet<string> = new Set([
  "run_in_background",
  "dangerouslyDisableSandbox",
  "with_escalated_permissions",
]);

/**
 * The fields each file tool may carry: its path fields and content or option
 * fields. Names from the Claude Code hooks reference ("PreToolUse input": Write,
 * Edit, Read, Glob, Grep) and the Claude Code 2.1.299 input schemas
 * (MultiEdit, NotebookEdit, LS, NotebookRead, Read `pages`, Grep options), and
 * Codex's `apply_patch` hook input (`command`, `description`).
 */
const FILE_TOOL_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Write: new Set(["file_path", "content"]),
  Edit: new Set(["file_path", "old_string", "new_string", "replace_all"]),
  MultiEdit: new Set(["file_path", "edits"]),
  NotebookEdit: new Set(["notebook_path", "cell_id", "new_source", "cell_type", "edit_mode"]),
  apply_patch: new Set(["command", "description"]),
  Read: new Set(["file_path", "offset", "limit", "pages"]),
  NotebookRead: new Set(["notebook_path", "cell_id"]),
  Glob: new Set(["pattern", "path"]),
  Grep: new Set([
    "pattern",
    "path",
    "glob",
    "output_mode",
    "-A",
    "-B",
    "-C",
    "context",
    "-i",
    "-n",
    "type",
    "head_limit",
    "offset",
    "multiline",
  ]),
  LS: new Set(["path", "ignore"]),
};

/** A tool input field Hotline does not judge, and why it makes the request high. */
export interface ActionField {
  /** The field's name as the agent sent it. Untrusted. */
  name: string;
  /** The field's value, untouched. Untrusted. */
  value: unknown;
  reason: RiskReason;
}

/**
 * The fields of a tool input that could change what runs, or where, beyond what
 * the classifier judges. Shell tools may carry only `command`, a string or null
 * `description` and a numeric `timeout` (and the flags in `OFF_WHEN_FALSE` set
 * to `false`); file tools only their known path and content fields. Every other
 * field is listed here, and each one makes the request high.
 */
export function actionFields(toolName: string, toolInput: unknown): ActionField[] {
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return [];
  const input = toolInput as Record<string, unknown>;
  const fields: ActionField[] = [];
  if (SHELL_TOOLS.has(toolName)) {
    for (const [name, value] of Object.entries(input)) {
      if (name === "command") continue;
      if (name === "description") {
        if (typeof value !== "string" && value !== null)
          fields.push({ name, value, reason: "has input Hotline cannot read" });
        continue;
      }
      if (name === "timeout") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          fields.push({ name, value, reason: "has input Hotline cannot read" });
        continue;
      }
      if (OFF_WHEN_FALSE.has(name) && value === false) continue;
      fields.push({
        name,
        value,
        reason: SHELL_FIELD_REASONS.get(name) ?? "has a setting Hotline does not know",
      });
    }
    return fields;
  }
  const known = Object.hasOwn(FILE_TOOL_FIELDS, toolName) ? FILE_TOOL_FIELDS[toolName] : undefined;
  if (known === undefined) return [];
  for (const [name, value] of Object.entries(input)) {
    if (name === "description" && toolName === "apply_patch" && typeof value !== "string" && value !== null) {
      fields.push({ name, value, reason: "has input Hotline cannot read" });
    } else if (!known.has(name)) {
      fields.push({ name, value, reason: "has a setting Hotline does not know" });
    }
  }
  return fields;
}

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
  /(?:^|[/\\\s'"=:])(?:\.env(?:\.[\w.-]+)?|\.envrc|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.hotline|\.claude|\.codex|\.config\/gh|\.git\/(?:config|hooks)|\.gitattributes|id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks))(?=$|[/\\\s'"])|keychain/i;

/**
 * Files that make a later "read-only" command run code: git config, hooks and
 * attributes (`core.fsmonitor`, diff and textconv drivers, hooks run by `git
 * status`), package-manager config and lifecycle files, and installed binaries
 * that `pnpm test` runs. Writing one is high risk even inside the project.
 */
const CODE_CONFIG_PATH =
  /(?:^|\/)(?:\.git(?:\/|$)|\.gitattributes$|\.gitmodules$|\.husky(?:\/|$)|\.npmrc$|\.yarnrc(?:\.yml)?$|\.yarn(?:\/|$)|\.pnpmfile\.c?js$|bunfig\.toml$|package\.json$|node_modules(?:\/|$)|\.envrc$)/i;

/** The part of `path` that is judged: below the project root when inside it, else the whole path. */
function judgedPart(cwd: string, path: string): string {
  // macOS file systems ignore case and Unicode normalisation by default, so
  // `.GIT/config` and a decomposed `.env` are matched like the plain names
  // (the patterns are case-insensitive; this makes the form canonical).
  const normal = path.normalize("NFC");
  const root = projectRoot(cwd);
  if (root === undefined || !insideProject(cwd, normal)) return normal;
  return resolvePosix(root, normal).slice(root.length);
}

/** Whether any component of `path` is `.git` (a repository directory or a `.git` file), in any case. */
export function hasGitComponent(path: string): boolean {
  return path
    .normalize("NFC")
    .split(/[/:]/)
    .some((part) => part.toLowerCase() === ".git");
}

/** Whether `path` names a credential or settings file. Inside the project only the part below it counts. */
function credentialPath(cwd: string, path: string): boolean {
  return CREDENTIAL_PATH.test(judgedPart(cwd, path));
}

/** Whether writing `path` could make a later read-only command run code (see `CODE_CONFIG_PATH`). */
function codeConfigPath(cwd: string, path: string): boolean {
  const judged = judgedPart(cwd, path);
  return CODE_CONFIG_PATH.test(judged.startsWith("/") ? judged : `/${judged}`);
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
/**
 * Changing directory, anywhere in the command (even as an argument: fail
 * closed). Claude Code's Bash tool keeps its working directory between calls,
 * so after a `cd` this and later commands run somewhere other than the session
 * cwd that their relative paths are judged against.
 */
const CHANGES_FOLDER = [word("cd|pushd|popd")];
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
  if (matchesAny(command, CHANGES_FOLDER)) reasons.add("asks to run in another folder");
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
 * Characters allowed outside quotes. Everything else (globs `* ? [ ]`, braces,
 * `~`, `$`, backticks, backslashes, `!`, `^`, `#`, parentheses, non-ASCII
 * characters such as lookalike separators) is something bash or zsh may expand
 * or treat specially, so the command is not understood. `=` is allowed only
 * inside a word: zsh expands a word that starts with `=` (`=cmd`).
 */
const UNQUOTED = /^[A-Za-z0-9_./:@%+,=-]$/;
/** Refused anywhere, quoted or not: substitutions, escapes, and C0 and C1 control characters except tab and newline. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched for display.
const NEVER = /[`$\\\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * Splits a command line into simple commands on `;`, `&&`, `||`, `|` and
 * newlines, with single and double quotes, the way both bash and zsh would.
 * Returns undefined for anything it does not fully understand: substitutions,
 * variables, escapes, expansions (globs, braces, `~`, zsh `=cmd`, `<1-10>`),
 * history expansion, subshells, background jobs, here-documents, comments,
 * control and non-ASCII characters, and unbalanced quotes. Single-quoted text
 * may hold anything else; double-quoted text may not hold `!`. Undefined always
 * means high risk.
 */
export function splitShell(command: string): SimpleCommand[] | undefined {
  if (NEVER.test(command)) return undefined;
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let quoted = false;
  let pending: string | undefined;
  let needsCommand = false;
  let doubt = false;

  const endWord = (): boolean => {
    if (!inWord) return true;
    if (pending !== undefined) {
      // zsh reads `<1-10>` and `<->` as a numeric glob, not a redirection.
      if (pending === "<" && /^\d*-\d*$/.test(word)) doubt = true;
      if (pending === "dup" && !/^(?:\d+|-)$/.test(word)) current.redirects.push({ op: ">", target: word });
      else current.redirects.push({ op: pending, target: word });
      pending = undefined;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
    quoted = false;
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
      const inside = command.slice(i + 1, close);
      // `!` is history expansion inside double quotes in interactive bash and zsh.
      if (c === '"' && inside.includes("!")) return undefined;
      word += inside;
      inWord = true;
      quoted = true;
      i = close;
    } else if (c === ";" || c === "\n") {
      // bash refuses a `;` with no command before it (`; ls`, `ls ;;`, `ls\n;`).
      if (c === ";" && !inWord && current.words.length === 0 && current.redirects.length === 0)
        return undefined;
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
        // `&>>` is a syntax error in bash 3.2, the macOS /bin/bash: refused.
        if (command[i + 1] === ">") return undefined;
        pending = "&>";
      } else {
        return undefined;
      }
    } else if (c === ">" || c === "<") {
      // A bare, unquoted number right before the operator is a file descriptor (`2>`).
      if (inWord && !quoted && /^\d+$/.test(word)) {
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
    } else if (UNQUOTED.test(c) && !(c === "=" && !inWord)) {
      word += c;
      inWord = true;
    } else {
      return undefined;
    }
  }
  if (!endCommand(false) || needsCommand || doubt) return undefined;
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
const GIT_FORBIDDEN_OPTIONS = [
  "--output",
  "--ext-diff",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--no-index",
  "--namespace",
];
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
/**
 * Whether one argument is safe for a read-only command. A plain argument must be
 * a path inside the project that is not sensitive. Options are checked for any
 * value they could carry, since Hotline does not know which options take one:
 *
 * - `--opt=VALUE`: VALUE is checked as a path;
 * - `--opt` with a path-like character (`/`, `.`, `~`) is refused;
 * - `-xVALUE` and clusters such as `-rf/etc/x` or `-fsecrets`: every suffix
 *   after the dash could be the value, so every suffix is checked as a path.
 *
 * A separate `--opt VALUE` needs nothing here: the commands that use this check
 * every following word as a path anyway.
 */
function safeArgument(arg: string, cwd: string): boolean {
  if (arg.startsWith("--")) {
    if (arg.includes("=")) return safePath(arg.slice(arg.indexOf("=") + 1), cwd);
    return !/[/.~]/.test(arg);
  }
  if (arg.startsWith("-") && arg.length > 1) {
    const body = arg.slice(1);
    if (body.includes("="))
      return (
        safePath(body.slice(body.indexOf("=") + 1), cwd) &&
        safeArgument(`-${body.slice(0, body.indexOf("="))}`, cwd)
      );
    for (let i = 1; i < body.length; i++) {
      if (!safePath(body.slice(i), cwd)) return false;
    }
    return !hasGitComponent(body) && !CREDENTIAL_PATH.test(body) && !CREDENTIAL_PATH.test(`/${body}`);
  }
  return safePath(arg, cwd);
}

/** A path inside the project that names no credential, settings file or `.git` component. */
function safePath(path: string, cwd: string): boolean {
  if (path === "") return true;
  if (hasGitComponent(path) || credentialPath(cwd, path)) return false;
  return insideProject(cwd, path.normalize("NFC"));
}

/**
 * ripgrep options that only change what is searched or printed (HL-13). rg
 * keeps adding options that run programs (`--pre`, `--hostname-bin`), so rg is
 * judged by this positive list: any other option, in any case, is high.
 * Audited against `rg --help` of ripgrep 14.1.1: every letter and name below is
 * a search, filter or output option there (`-h` is `--help`). A test checks the
 * list against the installed rg's help when rg is available. Options that widen
 * what is read past rg's defaults are left out, so they are high: `--hidden`,
 * `--no-ignore` and `-u`/`--unrestricted` reach `.env` and `.git` with no path
 * argument naming them, and `-L`/`--follow` reads through symlinks out of the
 * project.
 */
export const RIPGREP_LONG_OPTIONS: ReadonlySet<string> = new Set(
  (
    "--line-number --no-line-number --ignore-case --case-sensitive --smart-case --files-with-matches " +
    "--files-without-match --count --count-matches --word-regexp --line-regexp --fixed-strings " +
    "--invert-match --only-matching --with-filename --no-filename --type --type-not --glob --iglob " +
    "--context --after-context --before-context --max-count --max-depth --files " +
    "--json --color --no-heading --heading --column --stats --regexp --sort --sortr --trim --multiline " +
    "--max-columns --vimgrep --null --quiet --text --byte-offset"
  ).split(" "),
);
/** Single-letter rg flags that take no value (`-z`, which runs decompressors, is not one). */
export const RIPGREP_FLAGS = "nNiIsSlcwxFvoHhUqab";
/** Single-letter rg options whose value is the next word or attached digits. */
export const RIPGREP_VALUE_OPTIONS = "ABCmtTge";

function knownRgOption(arg: string): boolean {
  if (arg === "--" || !arg.startsWith("-")) return true;
  if (arg.startsWith("--"))
    return RIPGREP_LONG_OPTIONS.has(arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg);
  const body = arg.slice(1);
  if (body.length === 1) return RIPGREP_FLAGS.includes(body) || RIPGREP_VALUE_OPTIONS.includes(body);
  // `-A3`, `-m10`: a value option with attached digits; `-nw`: a cluster of plain flags.
  if (/^[ABCm]\d+$/.test(body)) return true;
  return [...body].every((flag) => RIPGREP_FLAGS.includes(flag));
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
    if (op !== "<" && codeConfigPath(cwd, target)) return false;
  }
  const [name, ...args] = words;
  if (name === undefined || name.includes("/") || name.includes("=")) return false;
  if (Object.hasOwn(READ_ONLY, name)) {
    if (forbidden(args, READ_ONLY[name] ?? [])) return false;
    if (name === "rg" && !args.every(knownRgOption)) return false;
    return args.every((arg) => safeArgument(arg, cwd));
  }
  if (name === "git") {
    const [sub, ...rest] = args;
    if (sub === undefined || !GIT_READ_ONLY.has(sub) || forbidden(rest, GIT_FORBIDDEN_OPTIONS)) return false;
    if (sub === "branch") return rest.every((arg) => GIT_BRANCH_LIST_OPTIONS.has(arg));
    // Every argument, revisions included (`main`, `HEAD:src/a.ts`), is checked as
    // a path: inside the project, nothing sensitive, and no `.git` component, so
    // git cannot be pointed at another or a nested repository.
    return rest.every((arg) => safeArgument(arg, cwd));
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

/** Characters bash and zsh read literally outside quotes (`=` is handled separately). */
const PLAIN_WORD = /^[A-Za-z0-9_./:@%+,-]+$/;

/**
 * Text quoted as one contiguous run, so the daemon's redactor sees a quoted
 * value whole: plain as it is, else in single quotes, else (when it holds a `'`)
 * in double quotes if nothing in it is special there. Undefined when neither
 * works: splitting it as `'a'"'"'b'` would let a secret's tail escape the
 * redactor's `name='value'` pattern.
 */
function quoteRun(text: string): string | undefined {
  if (PLAIN_WORD.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!/["$`\\!]/.test(text)) return `"${text}"`;
  return undefined;
}

/**
 * One argv element written so that bash and zsh read it back as exactly that
 * element. After the command word, a `name=` or `name:` prefix stays outside the
 * quotes (`PASSWORD='a b'`, the shape the redactor removes whole); the command
 * word is quoted whole, since an unquoted `name=` there would be an assignment.
 * Undefined when the element cannot be written exactly and redactably.
 */
function quoteArgument(part: string, index: number): string | undefined {
  if (PLAIN_WORD.test(part)) return part;
  const assignment = index > 0 ? /^([A-Za-z0-9_.-]+[=:])([\s\S]*)$/.exec(part) : null;
  if (assignment !== null) {
    const value = assignment[2] ?? "";
    const quoted = value === "" ? "" : quoteRun(value);
    return quoted === undefined ? undefined : `${assignment[1]}${quoted}`;
  }
  if (index === 0 && part.includes("'")) return undefined;
  return part === "" ? "''" : quoteRun(part);
}

/**
 * The command text of a shell tool call: a string, or an argv array (Codex's
 * `shell` tool) written as the shell line that runs exactly that argv, so the
 * owner hears and the classifier judges what runs. Undefined for anything else,
 * including an argv element that cannot be written exactly with each quoted
 * value in one piece (see `quoteArgument`), so the request is high.
 */
export function shellCommand(input: unknown): string | undefined {
  const value =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).command
        : undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
    const words = value.map((part, index) => quoteArgument(part, index));
    return words.every((word) => word !== undefined) ? words.join(" ") : undefined;
  }
  return undefined;
}

function shellReasons(command: string, cwd: string): RiskReason[] {
  const reasons = labelReasons(command, cwd);
  // A change of folder is high even around read-only commands: what follows runs elsewhere.
  if (reasons.includes("asks to run in another folder")) return reasons;
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
    if (credentialPath(cwd, path) || codeConfigPath(cwd, path))
      reasons.add("touches credentials or agent settings");
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
  "asks to run outside the sandbox",
  "asks for network access",
  "asks to run in another folder",
  "may run in another folder or outside the sandbox",
  "asks to run in the background",
  "asks to set environment variables",
  "runs nested code Hotline cannot read",
  "runs a command Hotline does not recognise as read-only",
  "uses a tool Hotline does not know",
  "has a setting Hotline does not know",
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
 * text to approve. Anything Hotline cannot read or does not know is high,
 * including any input field that could change what runs (`actionFields`).
 */
export function classifyPermission(facts: PermissionRequestFacts): PermissionRisk {
  const fieldReasons = actionFields(facts.toolName, facts.toolInput).map((field) => field.reason);
  if (facts.agent === "codex" && SHELL_TOOLS.has(facts.toolName))
    fieldReasons.push("may run in another folder or outside the sandbox");
  return verdict([...toolReasons(facts), ...fieldReasons]);
}

function toolReasons({ toolName, toolInput, cwd }: PermissionRequestFacts): RiskReason[] {
  if (SHELL_TOOLS.has(toolName)) {
    const command = shellCommand(toolInput);
    if (command === undefined || command.trim() === "") return ["has input Hotline cannot read"];
    return shellReasons(command, cwd);
  }
  if (PATCH_TOOLS.has(toolName)) {
    const patch = shellCommand(toolInput);
    const files = patch === undefined ? undefined : patchFiles(patch);
    if (files === undefined) return ["has input Hotline cannot read"];
    return [...(files.deletes ? (["deletes files"] as const) : []), ...pathReasons(files.paths, cwd)];
  }
  const writeFields = Object.hasOwn(FILE_WRITE_TOOLS, toolName) ? FILE_WRITE_TOOLS[toolName] : undefined;
  if (writeFields !== undefined) {
    const paths = writeFields.map((field) => stringField(toolInput, field));
    if (paths.some((path) => path === undefined)) return ["has input Hotline cannot read"];
    return pathReasons(paths as string[], cwd);
  }
  if (SENDING_TOOLS.has(toolName)) return ["sends data off the machine"];
  if (READ_TOOLS.has(toolName)) {
    const paths = ["file_path", "path", "notebook_path"].map((field) => stringField(toolInput, field));
    const patterns = ["pattern", "glob", "query"].map((field) => stringField(toolInput, field));
    const credentials =
      paths.some((path) => path !== undefined && credentialPath(cwd, path)) ||
      patterns.some((pattern) => pattern !== undefined && CREDENTIAL_PATH.test(pattern));
    return credentials ? ["touches credentials or agent settings"] : [];
  }
  // MCP tools (`mcp__server__tool`) and anything else: Hotline cannot tell what they do.
  return ["uses a tool Hotline does not know"];
}
