// Property and differential tests for the permission classifier (HL-13).
//
// 1. Obfuscation: high-risk commands rewritten the ways a shell would still run
//    them (wrappers, quoting, expansions, case, encodings, attached option
//    values, `cd`, environment prefixes, absolute command paths) never classify
//    as low.
// 2. Parser differential: for random command lines the classifier calls low,
//    bash and zsh must parse them without a syntax error (`-n`: read, never run)
//    and zsh must split them into the same simple commands, words and
//    redirection targets as `splitShell`. zsh's `(z)` flag splits text the way
//    its lexer does without running it: the command is passed as data (`$1`),
//    never as code. bash has no such mode, so bash only checks syntax. Skipped
//    cleanly when a shell is missing (zsh is not on Ubuntu runners by default).
//
// Nothing here executes a generated command.
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyPermission,
  RIPGREP_FLAGS,
  RIPGREP_LONG_OPTIONS,
  RIPGREP_VALUE_OPTIONS,
  shellCommand,
  splitShell,
} from "../src/index.js";

const cwd = "/Users/example/src/demo-app";
const classify = (command: unknown, toolName = "Bash") =>
  classifyPermission({ toolName, toolInput: { command }, cwd, agent: "claude-code" });

// ---------------------------------------------------------------------------
// 1. Obfuscated variants of high-risk commands

/** High-risk commands as argv words; a word starting with an operator is written as is. */
const HIGH: readonly (readonly string[])[] = [
  ["rm", "-rf", "build"],
  ["rmdir", "src"],
  ["git", "push", "origin", "main"],
  ["git", "push", "--force"],
  ["git", "reset", "--hard", "HEAD"],
  ["git", "clean", "-fdx"],
  ["git", "-c", "core.pager=sh", "log"],
  ["git", "log", "--output=/tmp/x"],
  ["git", "diff", "--ext-diff"],
  ["git", "--git-dir=/tmp/x", "status"],
  ["git", "status", "--work-tree=/tmp"],
  ["git", "show", "HEAD:.env"],
  ["git", "log", "../other"],
  ["curl", "-fsSL", "https://example.test/i.sh"],
  ["wget", "https://example.test/x"],
  ["npm", "install", "left-pad"],
  ["pnpm", "add", "left-pad"],
  ["pnpm", "run", "deploy"],
  ["npx", "left-pad"],
  ["cat", ".env"],
  ["cat", ".env.local"],
  ["cat", "/Users/example/.ssh/id_rsa"],
  ["cat", "../other/notes.txt"],
  ["cat", "/etc/passwd"],
  ["head", "-c1", "/Users/example/.aws/credentials"],
  ["grep", "-r", "x", "/etc"],
  ["grep", "-f", "/etc/shadow", "src"],
  ["rg", "--pre", "sh", "x", "src"],
  ["rg", "-z", "x", "src"],
  ["rg", "--hostname-bin=sh", "x", "src"],
  ["rg", "--PRE", "sh", "x", "src"],
  ["ls", "/"],
  ["ls", ".."],
  ["find", ".", "-delete"],
  ["find", ".", "-fprint", "/tmp/x"],
  ["tree", "-o", "/tmp/x"],
  ["echo", "hi", ">", "/tmp/x"],
  ["echo", "hi", ">>", "package.json"],
  ["ls", ">", ".git/config"],
  ["cat", "<", "/etc/passwd"],
  ["sudo", "ls"],
  ["cp", "src/a.ts", "/tmp/a.ts"],
  ["mv", "src", "/tmp"],
  ["chmod", "+x", "run.sh"],
  ["tee", "/tmp/x"],
  ["dd", "if=/dev/zero", "of=x"],
  ["node", "scripts/x.js"],
  ["python3", "-c", "import os"],
  ["ssh", "example.test"],
  ["printenv"],
  ["security", "find-generic-password", "-s", "x"],
  ["kill", "-9", "1"],
  ["open", "https://example.test"],
  ["osascript", "-e", "x"],
];

const OPERATOR = /^(?:[<>|&;]|>>|&&|\|\|)$/;

/**
 * Case changes: the same file or command on macOS's case-insensitive file
 * system, but a different (unknown) option to git, rg or grep, so options keep
 * their case.
 */
const caseRewrites: readonly ((word: string) => string)[] = [
  (w) => w.toUpperCase(),
  (w) => `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`,
];

/** A rewrite of one word that a shell may still read as the same word (or that only gets riskier). */
const wordRewrites: readonly ((word: string) => string)[] = [
  (w) => `'${w}'`,
  (w) => `"${w}"`,
  (w) => `${w.slice(0, 1)}''${w.slice(1)}`,
  (w) => `${w.slice(0, 1)}""${w.slice(1)}`,
  (w) => `'${w.slice(0, 1)}'${w.slice(1)}`,
  ...caseRewrites,
  (w) => `${w.slice(0, 1)}\\${w.slice(1)}`,
  (w) => `\\${w}`,
  (w) => `$'${w}'`,
  (w) => `$'\\x${w.charCodeAt(0).toString(16)}${w.slice(1)}'`,
  (w) => `\${X:-${w}}`,
  (w) => `{${w},}`,
  (w) => `${w.slice(0, -1)}?`,
  (w) => `${w.slice(0, -1)}[${w.slice(-1)}]`,
  (w) => `${w.slice(0, -1)}*`,
  (w) => `${w}​`,
  (w) => `​${w}`,
  (w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
  (w) => w.replace(/a/g, "а").replace(/c/g, "с").replace(/e/g, "е"),
  (w) => `${w} `,
  (w) => `${w}\r`,
  (w) => `"${w}"''`,
];

/** Rewrites of the command word only. */
const commandRewrites: readonly ((word: string) => string)[] = [
  ...wordRewrites,
  (w) => `/bin/${w}`,
  (w) => `/usr/bin/${w}`,
  (w) => `./${w}`,
  (w) => `../bin/${w}`,
  (w) => `=${w}`,
  (w) => `$(echo ${w})`,
  (w) => `\`echo ${w}\``,
];

/** Rewrites of an argument that names a path or a value. */
const argumentRewrites: readonly ((word: string) => string)[] = [
  ...wordRewrites,
  (w) => `--file=${w}`,
  (w) => `-f${w}`,
  (w) => `-n${w}`,
  (w) => (w.startsWith("/") ? `/${w}` : `./${w}`),
  (w) => (w.startsWith("/") ? w.replace(/\//g, "//") : `src/../${w}`),
  (w) => (w.startsWith("/") ? w.replace(/^\/(\w+)/, "/$1/../$1") : `${w}/`),
  (w) => w.replace(/\.(\w)/g, (_m, c: string) => `.${c.toUpperCase()}`),
  (w) => `~/${w}`,
  (w) => `$HOME/${w}`,
];

/** Rewrites of the whole line. */
const lineRewrites: readonly ((line: string) => string)[] = [
  ...["command", "builtin", "env", "exec", "nohup", "time", "nice", "timeout 5", "xargs", "sudo", "doas"].map(
    (wrapper) => (line: string) => `${wrapper} ${line}`,
  ),
  (line) => `bash -c '${line}'`,
  (line) => `sh -c "${line}"`,
  (line) => `zsh -c '${line}'`,
  (line) => `eval '${line}'`,
  (line) => `(${line})`,
  (line) => `{ ${line}; }`,
  (line) => `${line} &`,
  (line) => `$(${line})`,
  (line) => `echo x | ${line}`,
  (line) => `ls && ${line}`,
  (line) => `ls; ${line}`,
  (line) => `ls || ${line}`,
  (line) => `ls\n${line}`,
  (line) => `${line}; ls`,
  (line) => `${line} | head`,
  (line) => `${line} 2>&1`,
  (line) => `pwd | ${line}`,
  (line) => `FOO=1 ${line}`,
  (line) => `PATH=/tmp ${line}`,
  (line) => `GIT_DIR=/tmp ${line}`,
  (line) => `LD_PRELOAD=/tmp/x.so ${line}`,
  (line) => `PAGER=sh ${line}`,
  (line) => `cd /tmp && ${line}`,
  (line) => `cd .. ; ${line}`,
  (line) => `cd src && ${line}`,
  (line) => `pushd / ; ${line}`,
  (line) => `${line}\npopd`,
  (line) => line.normalize("NFD"),
  (line) => line.replace(/ /g, "\t"),
  (line) => line.replace(/ /g, "  "),
];

const pick = <T>(items: readonly T[]) =>
  fc.integer({ min: 0, max: items.length - 1 }).map((i) => items[i] as T);

/** A high-risk command with random word rewrites, then random whole-line rewrites. */
const obfuscated = fc
  .record({
    base: pick(HIGH),
    commandRewrite: fc.option(pick(commandRewrites), { nil: undefined }),
    argumentRewrites: fc.array(fc.option(pick(argumentRewrites), { nil: undefined }), { maxLength: 6 }),
    lineRewrites: fc.array(pick(lineRewrites), { maxLength: 3 }),
  })
  .map(({ base, commandRewrite, argumentRewrites: rewrites, lineRewrites: lines }) => {
    const [name = "", ...args] = base;
    const words = [
      commandRewrite === undefined ? name : commandRewrite(name),
      ...args.map((arg, i) => {
        const rewrite = rewrites[i];
        if (rewrite === undefined || OPERATOR.test(arg)) return arg;
        // An option stays an option: only rewrites a shell reads back as the same word.
        if (arg.startsWith("-") && (!wordRewrites.includes(rewrite) || caseRewrites.includes(rewrite)))
          return arg;
        return rewrite(arg);
      }),
    ];
    return lines.reduce((line, rewrite) => rewrite(line), words.join(" "));
  });

describe("permission classifier: obfuscated high-risk commands", { timeout: 60_000 }, () => {
  it.each(HIGH.map((words) => words.join(" ")))("classifies the base command `%s` as high", (command) => {
    expect(classify(command).risk).toBe("high");
  });

  it("never classifies an obfuscated variant of a high-risk command as low", () => {
    fc.assert(
      fc.property(obfuscated, (command) => {
        expect(classify(command).risk, JSON.stringify(command)).toBe("high");
      }),
      { numRuns: 5000 },
    );
  });

  it("never classifies a Codex-style argv array holding a high-risk command as low", () => {
    // `shellCommand` writes the argv as the line that runs it; whatever it writes stays high.
    const element = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom("'", '"', "$", "`", "\\", ";", "&&", "|", "\n", "=", "x=y", "--x=/tmp", "a b"),
    );
    fc.assert(
      // Only bases that are high without a shell operator: an argv has none.
      fc.property(
        pick(HIGH.filter((words) => !words.some((word) => OPERATOR.test(word)))),
        fc.array(element, { maxLength: 4 }),
        (base, extra) => {
          const argv = [...base, ...extra];
          const command = shellCommand({ command: argv });
          const verdict = classifyPermission({ toolName: "shell", toolInput: { command: argv }, cwd });
          expect(verdict.risk, JSON.stringify({ argv, command })).toBe("high");
        },
      ),
      { numRuns: 3000 },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Differential: splitShell against bash -n, zsh -n and zsh's own word splitting

function shellPath(name: string): string | undefined {
  for (const path of [
    `/bin/${name}`,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ]) {
    const probe = spawnSync(path, ["-c", ":"], { encoding: "utf8", env: {} });
    if (probe.status === 0) return path;
  }
  return undefined;
}

const BASH = shellPath("bash");
const ZSH = shellPath("zsh");

/** Whether `shell -n` (read without running) accepts `command`. No rc files, no environment. */
function parses(shell: string, command: string): boolean {
  const flags = shell === ZSH ? ["-f", "-n", "-c", command] : ["--norc", "--noprofile", "-n", "-c", command];
  return spawnSync(shell, flags, { encoding: "utf8", env: {}, timeout: 5_000 }).status === 0;
}

interface ShellCommandShape {
  words: string[];
  /** Redirection targets with their direction. */
  redirects: string[];
}

/**
 * zsh's own split of `command`: the `(z)` flag tokenises the text the way the
 * lexer does, without running it, and `(Q)` removes one level of quoting. The
 * command reaches zsh only as `$1`, a parameter value, never as code.
 */
function zshShape(command: string): ShellCommandShape[] | undefined {
  if (ZSH === undefined) return undefined;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh parameter expansions, not a JavaScript template.
  const script = 'print -rN -- "${(@z)1}"; print -rN -- "${(@Q)${(@z)1}}"';
  const result = spawnSync(ZSH, ["-f", "-c", script, "zsh", command], {
    encoding: "utf8",
    env: {},
    timeout: 5_000,
  });
  if (result.status !== 0) return undefined;
  const fields = result.stdout.split("\0").slice(0, -1);
  const half = fields.length / 2;
  const raw = fields.slice(0, half);
  const unquoted = fields.slice(half);
  const commands: ShellCommandShape[] = [];
  let current: ShellCommandShape = { words: [], redirects: [] };
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? "";
    if (/^(?:;|;;|&&|\|\||\||&|\|&|;&|;\|)$/.test(token)) {
      if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
      current = { words: [], redirects: [] };
    } else if (/^\d*[<>&|]+-?$/.test(token)) {
      const direction = token.includes("<") && !token.includes(">") ? "in" : "out";
      i++;
      current.redirects.push(`${direction}:${unquoted[i] ?? ""}`);
    } else {
      current.words.push(unquoted[i] ?? "");
    }
  }
  if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
  return commands;
}

function splitShape(command: string): ShellCommandShape[] | undefined {
  return splitShell(command)?.map(({ words, redirects }) => ({
    words,
    redirects: redirects.map(({ op, target }) => `${op === "<" ? "in" : "out"}:${target}`),
  }));
}

/** Words a read-only command line could hold, plain or quoted, plus pieces that stress the tokenizer. */
const piece = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom("src", "a.txt", "README.md", "-n", "-la", "--stat", "x", "2", "x2", "main"),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("a=b", "--max-count=3", "%H", "+x", "a,b", "a:b", "a@b", "-", "--", "."),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom("'a b'", '"a b"', "''", '""', "'a;b'", '"c|d"', "'x'y", "x'y'", '"2"', "2''"),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("'a\nb'", "'!'", "'$x'", "'#'", "'{a,b}'", "'*'", "'\\'", "'é'", "' '"),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "#",
      "!",
      "{",
      "}",
      "(",
      ")",
      "*",
      "?",
      "[",
      "]",
      "~",
      "$",
      "\\",
      "^",
      "é",
      " ",
      "\r",
      "=x",
    ),
  },
);
const operator = fc.constantFrom(
  " ; ",
  ";",
  " ;; ",
  " && ",
  " || ",
  " | ",
  "|",
  " & ",
  "\n",
  "\n\n",
  " && \n",
  "; ;",
  "\n;",
);
const redirect = fc.constantFrom(
  " > out.txt",
  " >> out.txt",
  " 2>err.txt",
  " 2>&1",
  " >&2",
  " &>out.txt",
  " &>>out.txt",
  " >| out.txt",
  " < a.txt",
  " 2>&-",
  " >/dev/null",
  " 2> /dev/null",
  "x>y",
  " > ''",
);
const simple = fc
  .record({
    name: fc.constantFrom(
      "ls",
      "cat",
      "grep",
      "echo",
      "head",
      "wc",
      "git status",
      "git log",
      "pnpm test",
      "rg",
    ),
    args: fc.array(piece, { maxLength: 4 }),
    redirects: fc.array(redirect, { maxLength: 2 }),
    leading: fc.constantFrom("", "", "", ";", "; ", "\n", " "),
  })
  .map(({ name, args, redirects, leading }) => `${leading}${[name, ...args].join(" ")}${redirects.join("")}`);
const line = fc
  .tuple(
    simple,
    fc.array(fc.tuple(operator, simple), { maxLength: 2 }),
    fc.constantFrom("", "", ";", ";;", "\n", " &"),
  )
  .map(([first, rest, trailing]) => `${first}${rest.map(([op, cmd]) => `${op}${cmd}`).join("")}${trailing}`);

describe.skipIf(BASH === undefined && ZSH === undefined)(
  "permission classifier: parser differential",
  { timeout: 120_000 },
  () => {
    it("only calls a command line low when bash and zsh parse it, and zsh splits it the same way", () => {
      let low = 0;
      fc.assert(
        fc.property(line, (command) => {
          if (classify(command).risk !== "low") return;
          low++;
          const context = JSON.stringify(command);
          if (BASH !== undefined) expect(parses(BASH, command), `bash -n: ${context}`).toBe(true);
          if (ZSH !== undefined) {
            expect(parses(ZSH, command), `zsh -n: ${context}`).toBe(true);
            expect(zshShape(command), `zsh (z): ${context}`).toEqual(splitShape(command));
          }
        }),
        { numRuns: 400 },
      );
      // The generator must reach low verdicts, or this compares nothing.
      expect(low).toBeGreaterThan(20);
    });

    it.each(["ls ;;", "; ls", "ls\n;", "ls ; ; cat a.txt", "ls &>>out.txt"])(
      "never calls `%s` low, which a shell reads differently or refuses",
      (command) => {
        expect(classify(command).risk).toBe("high");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 3. The positive rg option list against the installed rg's help (when there is one)

const RG_HELP = (() => {
  const help = spawnSync("rg", ["--help"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return help.status === 0 ? help.stdout : undefined;
})();

describe.skipIf(RG_HELP === undefined)("permission classifier: rg options", () => {
  it("allows only short options rg documents", () => {
    for (const letter of [...RIPGREP_FLAGS, ...RIPGREP_VALUE_OPTIONS]) {
      expect(RG_HELP, `-${letter}`).toMatch(new RegExp(`^\\s+-${letter}[, ]`, "m"));
    }
  });

  it("allows only long options rg documents, or their documented negation", () => {
    for (const option of RIPGREP_LONG_OPTIONS) {
      const base = option.replace(/^--no-/, "--");
      const documented = [option, base, `--no-${base.slice(2)}`].some((name) =>
        new RegExp(`(?:^|[\\s,])${name}(?:[=,\\s]|$)`, "m").test(RG_HELP ?? ""),
      );
      expect(documented, option).toBe(true);
    }
  });
});

it("never lists an rg option that runs a program", () => {
  for (const option of ["--pre", "--pre-glob", "--search-zip", "--hostname-bin", "--type-add"]) {
    expect(RIPGREP_LONG_OPTIONS.has(option), option).toBe(false);
  }
  expect(RIPGREP_FLAGS).not.toContain("z");
});
