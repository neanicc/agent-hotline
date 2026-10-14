// Confirms a voice decision against the post-call transcript before it counts.
//
// `submit_answer` carries `owner_words`, which the voice model writes, and the
// asks it reads out were written by coding agents. So a decision counts only
// when the owner's own turns in the transcript back it up, in the right place:
//
// - The words must come from an owner turn after the agent turn that read that
//   ask out, and before the agent read a different ask. A "yes" said earlier
//   ("yes, I can hear you") or after another ask never confirms this one.
// - `ownerSaid` (providers) does the matching: case and punctuation ignored,
//   whole words, owner turns only.
// - A free-text decision (a question's answer, a stop's next instruction) must
//   itself be words the owner said, since it becomes the agent's next input.
// - An approval must sound like one: the owner's matching turns hold a yes word
//   and no word of refusal or hesitation. Anything else fails closed.
//
// Everything here fails closed: an ask whose reading cannot be found in the
// transcript, or words found in the wrong place, is not confirmed, and the ask
// stays unanswered (call policy then texts it). Pure: no I/O, no clock.
import type { Decision } from "@hotline/core";
import { ownerSaid, type TranscriptTurn } from "@hotline/providers";

/** One ask as it was read out on the call, for finding its reading in the transcript. */
export interface ReadAsk {
  text: string;
  nickname: string;
  toolName?: string;
}

/** Share of an ask's key words an agent turn must contain to count as reading it. */
export const READING_MIN_SHARE = 0.5;
/** Ask text the voice agent was given is cut to this many characters (`callVariables`). */
const READ_TEXT_LENGTH = 300;
/** Owner turns kept as the stored excerpt, at most. The contract allows 2000 characters. */
const MAX_EXCERPT = 2000;

const wordSet = (words: string): ReadonlySet<string> => new Set(words.split(" "));

/** Words too common to tell asks apart. */
const COMMON = wordSet(
  "the and for you your are can this that with from want wants should would will use run ask agent",
);
/** Words that make an approval clear. */
const YES_WORDS = wordSet(
  "yes yeah yep yup yea sure ok okay approve approved allow allowed go proceed fine absolutely definitely",
);
/** Words that make an approval doubtful: refusal, negation or hesitation. */
const DOUBT_WORDS = wordSet(
  "no nope nah not don dont never deny denied reject stop cancel wait hold maybe unless but",
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** The words that identify an ask when the agent reads it out. */
function keyWords(ask: ReadAsk): Set<string> {
  const all = [ask.text.slice(0, READ_TEXT_LENGTH), ask.nickname, ask.toolName ?? ""].flatMap(tokens);
  const key = new Set(all.filter((word) => word.length >= 3 && !COMMON.has(word)));
  return key.size > 0 ? key : new Set(all);
}

/**
 * For each transcript turn, the index of the ask it reads out, or undefined. A
 * turn reads the ask whose key words it covers best, with at least
 * `READING_MIN_SHARE` of them; a tie reads none. The call's first agent turn is
 * the fixed greeting and never reads an ask, so an ask written to look like the
 * greeting cannot pull the owner's reply to it into its window.
 */
export function readings(
  transcript: readonly TranscriptTurn[],
  asks: readonly ReadAsk[],
): (number | undefined)[] {
  const keys = asks.map(keyWords);
  const firstAgent = transcript.findIndex((turn) => turn.role === "agent");
  return transcript.map((turn, index) => {
    if (turn.role !== "agent" || index === firstAgent) return undefined;
    const said = new Set(tokens(turn.message));
    let best: number | undefined;
    let bestShare = 0;
    let tie = false;
    keys.forEach((key, ask) => {
      if (key.size === 0) return;
      const share = [...key].filter((word) => said.has(word)).length / key.size;
      if (share > bestShare) {
        best = ask;
        bestShare = share;
        tie = false;
      } else if (share === bestShare && share > 0) {
        tie = true;
      }
    });
    return best !== undefined && !tie && bestShare >= READING_MIN_SHARE ? best : undefined;
  });
}

/**
 * The transcript turns where the owner may answer ask `index`: after the first
 * agent turn that read it, up to the next agent turn that read a different ask.
 * Undefined when the reading cannot be found.
 */
export function answerWindow(
  transcript: readonly TranscriptTurn[],
  asks: readonly ReadAsk[],
  index: number,
): readonly TranscriptTurn[] | undefined {
  const read = readings(transcript, asks);
  const start = read.indexOf(index);
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < transcript.length && (read[end] === undefined || read[end] === index)) end++;
  return transcript.slice(start + 1, end);
}

/** The shortest run of consecutive owner turns in `window` that contains `excerpt`, verbatim. */
function matchingTurns(excerpt: string, window: readonly TranscriptTurn[]): string | undefined {
  for (let end = 0; end < window.length; end++) {
    if (window[end]?.role !== "owner") continue;
    for (let start = end; start >= 0 && window[start]?.role === "owner"; start--) {
      const run = window.slice(start, end + 1);
      if (ownerSaid(excerpt, run)) return run.map((turn) => turn.message).join(" ");
    }
  }
  return undefined;
}

export type VoiceConfirmation =
  /** `excerpt` is the owner's own transcript turns that back the decision, verbatim. */
  { confirmed: true; excerpt: string } | { confirmed: false; reason: string };

export interface ConfirmInput {
  transcript: readonly TranscriptTurn[];
  /** Every ask the call read, in order. */
  asks: readonly ReadAsk[];
  /** Which of them this decision is for. */
  index: number;
  decision: Decision;
  /** `owner_words` from `submit_answer`, written by the voice model. */
  ownerWords: string;
}

/** Whether the post-call transcript backs a voice decision; see the top of this file. */
export function confirmVoiceDecision({
  transcript,
  asks,
  index,
  decision,
  ownerWords,
}: ConfirmInput): VoiceConfirmation {
  const window = answerWindow(transcript, asks, index);
  if (window === undefined) return { confirmed: false, reason: "the ask's reading is not in the transcript" };
  const excerpt = matchingTurns(ownerWords, window);
  if (excerpt === undefined) {
    return { confirmed: false, reason: "the owner did not say these words after the ask was read" };
  }
  if (decision.type === "text" && !ownerSaid(decision.text, window)) {
    return { confirmed: false, reason: "the answer text is not the owner's own words" };
  }
  if (decision.type === "allow") {
    const said = tokens(excerpt);
    if (!said.some((word) => YES_WORDS.has(word)) || said.some((word) => DOUBT_WORDS.has(word))) {
      return { confirmed: false, reason: "the owner's words are not a clear yes" };
    }
  }
  return { confirmed: true, excerpt: excerpt.slice(0, MAX_EXCERPT) };
}
