// How a session is named when the voice agent (or a text) talks about it, such
// as "Claude in demo-app". The name is built by Hotline from session data: the
// agent kind (an enum, never agent text) and the last folder of the session's
// working directory, or the owner's own name for that folder from
// `config.nicknames`. Nothing an agent writes in a question, option or message
// ever becomes part of it.
//
// The folder name still comes from the agent's process, so it is treated as
// untrusted: redacted whole first (a secret in a folder name is never spoken),
// then reduced to letters, digits, spaces and a little punctuation, then cut.
// The voice provider additionally fences it as agent text when it is read out.
import type { AgentKind } from "@hotline/core";

/** Longest spoken session name, numbered suffix included. */
export const MAX_SPOKEN_NICKNAME_LENGTH = 60;

/** What each agent kind is called out loud. */
export const AGENT_SPOKEN_NAMES: Readonly<Record<AgentKind, string>> = {
  "claude-code": "Claude",
  codex: "Codex",
};

/**
 * Words of a folder name that are spoken. Real folder names rarely have more
 * than a few; the cap keeps a folder named like a sentence from being read out
 * as one. (A configured name is the owner's and is not capped by words.)
 */
export const MAX_FOLDER_WORDS = 4;

/** Said instead of the folder when nothing speakable is left of it (such as `/` or a folder of symbols). */
export const UNNAMED_FOLDER = "an unnamed folder";

const ELLIPSIS = "…";

/**
 * Reduces a name to one plain, speakable line: letters, combining marks, digits,
 * spaces and `- _ . ' [ ] …` (so a redaction marker such as `[REDACTED]`, or the
 * ellipsis of a name cut earlier, survives).
 * Everything else, including control and invisible characters, line breaks,
 * angle brackets, braces, quotes, colons and other sentence punctuation, becomes
 * a space, so a folder name cannot spell markup, a `{{variable}}`, or read like
 * a separate sentence. Runs of spaces collapse.
 */
export function speakableName(text: string): string {
  return text
    .replace(/[^\p{L}\p{M}\p{N}\-_.'[\]… ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cuts to at most `max` UTF-16 units (what the `Session` contract counts), on a
 * code point boundary, so an emoji or other astral character is never split
 * into a lone surrogate.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > max - ELLIPSIS.length) break;
    kept += char;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/** The last path segment of an absolute or relative POSIX path, ignoring trailing slashes. */
function lastFolder(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? "";
}

export interface SessionNicknameInput {
  agent: AgentKind;
  /** The session's working directory. Only its last folder is used. */
  cwd: string;
  /** `config.nicknames`: repository folder name to the owner's spoken name for it. */
  nicknames?: Readonly<Record<string, string>>;
  /** Applied to the folder name (and a configured name) before anything else, such as the daemon's redactor. */
  redact?: (text: string) => string;
  /**
   * Nicknames of the other live sessions. A name already taken gets a number,
   * "Claude 2 in demo-app", so the owner can tell two sessions in one folder apart.
   */
  taken?: Iterable<string>;
}

/**
 * The spoken name of a session: the owner's name for its folder from
 * `config.nicknames`, else "<Claude|Codex> in <folder>". Always 1 to
 * `MAX_SPOKEN_NICKNAME_LENGTH` speakable characters, and distinct from `taken`.
 */
export function sessionNickname({
  agent,
  cwd,
  nicknames = {},
  redact = (text) => text,
  taken = [],
}: SessionNicknameInput): string {
  const folder = lastFolder(cwd);
  const configured = Object.hasOwn(nicknames, folder) ? speakableName(redact(nicknames[folder] ?? "")) : "";
  const agentName = AGENT_SPOKEN_NAMES[agent];
  const words = speakableName(redact(folder))
    .split(" ")
    .filter((word) => word.length > 0);
  const place =
    words.length === 0
      ? UNNAMED_FOLDER
      : `${words.slice(0, MAX_FOLDER_WORDS).join(" ")}${words.length > MAX_FOLDER_WORDS ? ELLIPSIS : ""}`;
  const name = (n?: number) => {
    const suffix = n === undefined ? "" : ` ${n}`;
    if (configured !== "") {
      return `${cut(configured, MAX_SPOKEN_NICKNAME_LENGTH - suffix.length)}${suffix}`;
    }
    const head = `${agentName}${suffix} in `;
    return `${head}${cut(place, MAX_SPOKEN_NICKNAME_LENGTH - head.length)}`;
  };
  // Compared as they are spoken: a name saved before this rule (such as
  // "Claude in demo!") sounds the same as "Claude in demo" and reserves it.
  const spoken = (nickname: string) => speakableName(nickname).toLowerCase();
  const used = new Set([...taken].map(spoken));
  if (!used.has(spoken(name()))) return name();
  for (let n = 2; n < 100; n++) {
    const candidate = name(n);
    if (!used.has(spoken(candidate))) return candidate;
  }
  // Ninety-nine sessions in one folder: give up on telling them apart rather than loop.
  return name();
}
