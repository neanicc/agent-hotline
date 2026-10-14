// Confirms a voice decision against the post-call transcript before it counts.
//
// `submit_answer` carries `owner_words`, which the voice model writes, and the
// asks it reads out were written by coding agents. So a decision counts only
// when the owner's own turns in the transcript back it up, in the right place:
//
// - The words must come from the owner's turns right after an agent turn
//   recognised as reading that ask, before the next agent turn of any kind. A
//   "yes" said earlier ("yes, I can hear you"), after another ask, or after an
//   agent turn that cannot be told apart (a paraphrase, a tie) never confirms it.
// - `ownerSaid` (providers) does the matching: case and punctuation ignored,
//   whole words, owner turns only.
// - An approval (`allow`) is confirmed by the read-back exchange (HL-09c, the
//   owner's direction: approving by voice is as natural as a conversation). The
//   ask is read; later the agent reads it back as a question asking for a yes ("Allow pnpm test in demo-app? Yes?",
//   or "Sorry, is that a yes or a no?" with the read-back); the owner's words
//   are their reply to that read-back. No yes word is needed ("of course", "do
//   it", "send it" all approve), but the reply and everything the owner says
//   about the ask after the read-back must hold no refusal, hedge or doubt and
//   no question back. Doubt before the read-back ("hmm") does not count against
//   a clear reply after it. No read-back, or a read-back of another ask, is no
//   approval.
// - A free-text decision (a question's answer, a stop's next instruction) must
//   itself be words the owner said, since it becomes the agent's next input.
// - Anything the owner said about the ask after those words may take it back:
//   a later turn with refusal, negation, hesitation or a correction ("no",
//   "wait", "never mind", "actually", any "n't") means not confirmed.
// - An option must be named in the owner's words (its number, ordinal, number
//   word or most of its text), and no other offered option may be. `done` needs
//   a word for it ("done", "that's it", "nothing").
// - A refusal (`deny`) only needs to be the owner's words; it is safe.
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
  /** A question's options, for checking that the owner named the one submitted. */
  options?: readonly string[];
}

/** Share of an ask's key words an agent turn must contain to count as reading it. */
export const READING_MIN_SHARE = 0.5;
/**
 * An ask whose text has more key words than this is long: a turn that names
 * half this many of its text's key words also reads it, so a one-sentence
 * read-back of a long ask is still recognised.
 */
export const LONG_ASK_KEY_WORDS = 8;
/** Ask text the voice agent was given is cut to this many characters (`callVariables`). */
const READ_TEXT_LENGTH = 300;
/** Owner turns kept as the stored excerpt, at most. The contract allows 2000 characters. */
const MAX_EXCERPT = 2000;

const wordSet = (words: string): ReadonlySet<string> => new Set(words.split(" "));

/** Words too common to tell asks apart. */
const COMMON = wordSet(
  "the and for you your are can this that with from want wants should would will use run ask agent",
);
/**
 * Words that make an approval doubtful or take an answer back: refusal,
 * negation, hesitation, delay, correction. Includes the not-forms people type or
 * transcribe without the apostrophe; `n't` itself is caught before tokenising.
 */
const DOUBT_WORDS = wordSet(
  [
    "no nope nah nuh not never negative deny denied reject refuse stop cancel abort wait hold later maybe",
    "unless but cannot nevermind scratch forget actually instead",
    // Hedges and conditions: "I'm unsure whether to approve", "yes if the tests pass".
    "unsure uncertain doubt dunno idk whether if perhaps probably possibly might guess suppose think",
    "hmm hm hmmm kinda sorta whatever meh",
    // Not heard or not followed: "huh", "pardon", "hello", "repeat that".
    "huh pardon hello repeat",
    // Refusals without a "no": "fine, skip it", "go ahead and decline it".
    "decline declined skip pass block disallow veto rather away",
    "dont doesnt didnt wont wouldnt cant couldnt shouldnt isnt arent wasnt werent",
    "havent hasnt hadnt aint mustnt neednt mightnt shant",
  ].join(" "),
);
/** Spoken yeses that contain a doubt word on their own ("mm-hmm", "uh-huh"). */
const AFFIRMING_SOUNDS = ["mm hmm", "mm hm", "m hmm", "uh huh"];
/** How the owner may name option N (index N - 1). "one" is too common ("the second one") to name option 1 against another. */
const NUMBER_WORDS = "one two three four five six seven eight nine".split(" ");
const ORDINALS = "first second third fourth fifth sixth seventh eighth ninth".split(" ");
/** Words that let a stopped agent finish. */
const DONE_WORDS = wordSet("done nothing finished enough stop nope no");
const DONE_PHRASES = [
  "that s it",
  "thats it",
  "that is it",
  "that is all",
  "that s all",
  "all good",
  "no more",
];
/** Words that make a turn a question. */
const QUESTION_WORDS = wordSet("what why how which when where who whose explain wonder curious question");
/** Doubt that only shows as a phrase. */
const DOUBT_PHRASES = ["hang on", "hold on", "not yet", "no way", "never mind", "dont do", "uh uh", "uh oh"];
/** Words in an agent turn that ask the owner for a yes, besides a question mark. */
const ASKS_FOR_YES = wordSet("yes confirm");
/** Apostrophe look-alikes a transcript may use for "don't". */
const APOSTROPHES = /[’‘ʼ`´′]/g;
const QUESTION_MARK = /[?？¿]/u;

function normalized(text: string): string {
  return text.toLowerCase().normalize("NFKC").replace(APOSTROPHES, "'");
}

function tokens(text: string): string[] {
  return normalized(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether `text` holds any refusal, negation, hesitation or retraction. Any
 * `n't` (and the bare `t` it leaves when split) counts, so "okay, I wouldn't"
 * or "sure, I can't" is never a clear yes.
 */
export function soundsDoubtful(text: string, questions = true): boolean {
  const plain = normalized(text);
  if (plain.includes("n't")) return true;
  const all = tokens(text);
  // "Mm-hmm" and "uh-huh" are a yes, though "hmm" and "huh" alone are not.
  let joined = ` ${all.join(" ")} `;
  for (const sound of AFFIRMING_SOUNDS) joined = joined.replaceAll(` ${sound} `, " ");
  const words = joined.split(" ").filter((word) => word.length > 0);
  if (words.some((word) => word === "t" || DOUBT_WORDS.has(word))) return true;
  // A question is never an approval ("okay, what does it do"; speech recognition
  // often drops the question mark). `questions: false` is for turns before the
  // owner's answer, where asking what something does is not a refusal.
  if (questions && (QUESTION_MARK.test(plain) || words.some((word) => QUESTION_WORDS.has(word)))) return true;
  return DOUBT_PHRASES.some((phrase) => joined.includes(` ${phrase} `));
}

const isKey = (word: string) => word.length >= 3 && !COMMON.has(word);

interface AskKeys {
  /** Every word that identifies the ask: its text, session name and tool. */
  all: ReadonlySet<string>;
  /** The ones from its text alone. */
  text: ReadonlySet<string>;
}

/** The words that identify an ask when the agent reads it out. */
function keyWords(ask: ReadAsk): AskKeys {
  const fromText = tokens(ask.text.slice(0, READ_TEXT_LENGTH));
  const every = [...fromText, ...[ask.nickname, ask.toolName ?? ""].flatMap(tokens)];
  const all = new Set(every.filter(isKey));
  return { all: all.size > 0 ? all : new Set(every), text: new Set(fromText.filter(isKey)) };
}

const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].every((word) => b.has(word));

/**
 * Which ask one agent turn reads, or undefined. An ask is a candidate when the
 * turn holds at least `READING_MIN_SHARE` of its key words, or, for a long ask,
 * half of `LONG_ASK_KEY_WORDS` of its text's key words. Of the candidates, one
 * whose matched words are all matched by another, which matches more, drops out
 * (the turn says nothing that is only that ask's). If one is left it is read. If
 * several are left and the turn matched the same words of each, the one with
 * the larger share of its own key words is read; otherwise (a turn reading two
 * asks, or a tie) none is.
 */
function readingOf(said: ReadonlySet<string>, keys: readonly AskKeys[]): number | undefined {
  const candidates = keys.flatMap((key, ask) => {
    if (key.all.size === 0) return [];
    const matched = new Set([...key.all].filter((word) => said.has(word)));
    const textMatched = [...key.text].filter((word) => said.has(word)).length;
    const share = matched.size / key.all.size;
    const long =
      key.text.size > LONG_ASK_KEY_WORDS && textMatched >= Math.ceil(LONG_ASK_KEY_WORDS * READING_MIN_SHARE);
    return share >= READING_MIN_SHARE || long ? [{ ask, matched, share }] : [];
  });
  const left = candidates.filter(
    (c) =>
      !candidates.some((other) => other.matched.size > c.matched.size && subset(c.matched, other.matched)),
  );
  const [first, ...rest] = left;
  if (first === undefined) return undefined;
  if (rest.length === 0) return first.ask;
  const sameWords = rest.every(
    (c) => c.matched.size === first.matched.size && subset(c.matched, first.matched),
  );
  if (!sameWords) return undefined;
  const best = Math.max(...left.map((c) => c.share));
  const top = left.filter((c) => c.share === best);
  return top.length === 1 ? top[0]?.ask : undefined;
}

/**
 * For each transcript turn, the index of the ask it reads out, or undefined
 * (see `readingOf`; a tie reads none). The call's first agent turn is the fixed
 * greeting and never reads an ask, so an ask written to look like the greeting
 * cannot pull the owner's reply to it into its window.
 */
export function readings(
  transcript: readonly TranscriptTurn[],
  asks: readonly ReadAsk[],
): (number | undefined)[] {
  const keys = asks.map(keyWords);
  const firstAgent = transcript.findIndex((turn) => turn.role === "agent");
  return transcript.map((turn, index) => {
    if (turn.role !== "agent" || index === firstAgent) return undefined;
    return readingOf(new Set(tokens(turn.message)), keys);
  });
}

/** One agent turn that reads an ask (`at`) and the person's turns right after it. */
interface ReadingWindow {
  at: number;
  turns: readonly TranscriptTurn[];
}

function readingWindows(
  transcript: readonly TranscriptTurn[],
  read: readonly (number | undefined)[],
  index: number,
): ReadingWindow[] {
  const windows: ReadingWindow[] = [];
  transcript.forEach((turn, at) => {
    if (turn.role !== "agent" || read[at] !== index) return;
    const turns: TranscriptTurn[] = [];
    for (let next = at + 1; next < transcript.length && transcript[next]?.role !== "agent"; next++) {
      const said = transcript[next];
      if (said !== undefined) turns.push(said);
    }
    windows.push({ at, turns });
  });
  return windows;
}

/**
 * The stretches of transcript where the owner may answer ask `index`: the
 * person's turns right after each agent turn recognised as reading it, up to the
 * next agent turn of any kind. An agent turn that is not recognised as reading
 * this ask (a paraphrase, a tie, another ask, small talk) always ends a window,
 * so a reply to something else can never land in it; a later re-reading of the
 * ask opens a new one. Undefined when no reading is found.
 */
export function answerWindows(
  transcript: readonly TranscriptTurn[],
  asks: readonly ReadAsk[],
  index: number,
): readonly (readonly TranscriptTurn[])[] | undefined {
  const windows = readingWindows(transcript, readings(transcript, asks), index);
  return windows.length > 0 ? windows.map((window) => window.turns) : undefined;
}

/**
 * Whether the agent turn at `at` is a read-back of ask `index`: it reads that
 * ask, an earlier agent turn on the call read it too (the first reading is
 * never its own read-back), and it asks for a yes (a question mark, "yes" or
 * "confirm"). The ask need not be the last one read: going back to an ask after
 * answering another one is still a read-back of it, since the turn must be
 * recognised as reading this ask and no other.
 */
function isReadBack(
  transcript: readonly TranscriptTurn[],
  read: readonly (number | undefined)[],
  index: number,
  at: number,
): boolean {
  if (read[at] !== index || !read.slice(0, at).includes(index)) return false;
  const message = transcript[at]?.message ?? "";
  return QUESTION_MARK.test(message) || tokens(message).some((word) => ASKS_FOR_YES.has(word));
}

/** Where `excerpt` was said: the shortest run of consecutive owner turns containing it, verbatim. */
function matchingTurns(
  excerpt: string,
  windows: readonly (readonly TranscriptTurn[])[],
): { window: number; start: number; end: number; text: string } | undefined {
  for (const [window, turns] of windows.entries()) {
    for (let end = 0; end < turns.length; end++) {
      if (turns[end]?.role !== "owner") continue;
      for (let start = end; start >= 0 && turns[start]?.role === "owner"; start--) {
        const run = turns.slice(start, end + 1);
        if (ownerSaid(excerpt, run)) {
          return { window, start, end, text: run.map((turn) => turn.message).join(" ") };
        }
      }
    }
  }
  return undefined;
}

const ownerTurns = (turns: readonly TranscriptTurn[]) => turns.filter((turn) => turn.role === "owner");

/**
 * Whether `said` names option `n` (1-based): its digit, ordinal or number word,
 * or most of the option's own key words. With `strict`, the number word "one"
 * does not count, since "the second one" names option 2, not option 1.
 */
function namesOption(
  said: readonly string[],
  n: number,
  option: string | undefined,
  strict: boolean,
): boolean {
  if (said.includes(String(n)) || said.includes(ORDINALS[n - 1] ?? "")) return true;
  if (said.includes(NUMBER_WORDS[n - 1] ?? "") && !(strict && n === 1)) return true;
  if (option === undefined) return false;
  const key = tokens(option).filter(isKey);
  return key.length > 0 && key.filter((word) => said.includes(word)).length / key.length >= READING_MIN_SHARE;
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

/**
 * An `allow`: the owner's words are their reply to a read-back of this ask, and
 * nothing the owner said about the ask from that read-back on sounds doubtful
 * or asks a question back.
 */
function confirmAllow(
  transcript: readonly TranscriptTurn[],
  read: readonly (number | undefined)[],
  index: number,
  windows: readonly ReadingWindow[],
  ownerWords: string,
): VoiceConfirmation {
  const backs = windows.filter((window) => isReadBack(transcript, read, index, window.at));
  if (backs.length === 0) return { confirmed: false, reason: "the request was not read back for a yes" };
  const match = matchingTurns(
    ownerWords,
    backs.map((window) => window.turns),
  );
  if (match === undefined) {
    return { confirmed: false, reason: "the owner did not say these words in reply to the read-back" };
  }
  const from = backs[match.window]?.at ?? Number.POSITIVE_INFINITY;
  const after = windows.filter((window) => window.at >= from).flatMap((window) => ownerTurns(window.turns));
  if (after.some((turn) => soundsDoubtful(turn.message))) {
    return { confirmed: false, reason: "the owner's reply to the read-back is not a clear yes" };
  }
  return { confirmed: true, excerpt: match.text.slice(0, MAX_EXCERPT) };
}

/** Whether the post-call transcript backs a voice decision; see the top of this file. */
export function confirmVoiceDecision({
  transcript,
  asks,
  index,
  decision,
  ownerWords,
}: ConfirmInput): VoiceConfirmation {
  const read = readings(transcript, asks);
  const opened = readingWindows(transcript, read, index);
  if (opened.length === 0) return { confirmed: false, reason: "the ask's reading is not in the transcript" };
  if (decision.type === "allow") return confirmAllow(transcript, read, index, opened, ownerWords);
  const windows = opened.map((window) => window.turns);
  const match = matchingTurns(ownerWords, windows);
  if (match === undefined) {
    return { confirmed: false, reason: "the owner did not say these words after the ask was read" };
  }
  const excerpt = { confirmed: true as const, excerpt: match.text.slice(0, MAX_EXCERPT) };
  // A refusal is safe whatever else was said: it only needs to be the owner's.
  if (decision.type === "deny") return excerpt;
  if (decision.type === "text" && !windows.some((window) => ownerSaid(decision.text, window))) {
    return { confirmed: false, reason: "the answer text is not the owner's own words" };
  }
  // Anything the owner said about this ask after the matched words may take it back.
  const later = [
    ...ownerTurns((windows[match.window] ?? []).slice(match.end + 1)),
    ...windows.slice(match.window + 1).flatMap(ownerTurns),
  ];
  if (later.some((turn) => soundsDoubtful(turn.message))) {
    return { confirmed: false, reason: "the owner took the answer back" };
  }
  if (decision.type === "option") {
    // The owner must name this option and no other one the ask offered.
    const said = tokens(match.text);
    const options = asks[index]?.options ?? [];
    const other = options.some(
      (option, i) => i + 1 !== decision.option && namesOption(said, i + 1, option, true),
    );
    if (!namesOption(said, decision.option, options[decision.option - 1], false) || other) {
      return { confirmed: false, reason: "the owner's words do not name this option" };
    }
  }
  if (decision.type === "done") {
    // Letting a stopped agent finish is what no answer does too; it still needs a word for it.
    const said = tokens(match.text);
    const joined = ` ${said.join(" ")} `;
    if (!said.some((word) => DONE_WORDS.has(word)) && !DONE_PHRASES.some((p) => joined.includes(` ${p} `))) {
      return { confirmed: false, reason: "the owner's words do not say the agent is done" };
    }
  }
  return excerpt;
}
