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
//   are their reply to that read-back. What the reply means is decided in two
//   steps (`replyVerdict`, the owner's direction: approving is not limited to
//   phrase matching). A fast path decides common clear replies at once ("yes",
//   "yeah, go ahead", "of course", "no", "nope"), and noise is unclear
//   (nothing said, fillers, "[inaudible]", a long ramble, the read-back said
//   back). The fast path never agrees with a reply that holds a doubt or
//   negation marker. Anything else goes to a `ReplyJudge`, which sees only the
//   owner's own reply turns, never agent-written text. The default judge
//   (`FailClosedJudge`) finds everything unclear, so such a reply is not
//   confirmed and the ask is texted; a judge error or timeout is the same.
//   Doubt before the read-back ("hmm") does not count against a clear reply
//   after it. No read-back, or a read-back of another ask, is no approval.
// - Which ask a turn reads is attributed strictly (`readingOf`): with several
//   asks on the call, the turn must name every word that tells its ask apart,
//   and anything ambiguous (identical asks, one contained in another, two
//   matches) reads nothing.
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
// stays unanswered (call policy then texts it). `confirmVoiceDecision` is pure
// (no I/O, no clock) and treats every reply the fast path cannot decide as
// unclear; `judgeVoiceDecision` asks the injected judge about those, with a
// timeout.
import type { AskKind, Decision } from "@hotline/core";
import { MAX_SPOKEN_ASK_LENGTH, ownerSaid, type TranscriptTurn } from "@hotline/providers";

/** One ask as it was read out on the call, for finding its reading in the transcript. */
export interface ReadAsk {
  text: string;
  nickname: string;
  /** Without it, an ask with a tool name counts as a permission request. */
  kind?: AskKind;
  toolName?: string;
  /** A question's options, for checking that the owner named the one submitted. */
  options?: readonly string[];
}

/** Share of an ask's key words an agent turn must contain to count as reading it. */
export const READING_MIN_SHARE = 0.5;
/**
 * An ask whose text has more key words than this is long: a turn that names
 * half this many of its text's key words that no other ask on the call has
 * also reads it, so a one-sentence read-back of a long ask is still recognised.
 */
export const LONG_ASK_KEY_WORDS = 8;
/** A reply to a read-back longer than this many words is unclear, never judged a yes. */
export const MAX_REPLY_WORDS = 8;
/** How long `judgeVoiceDecision` waits for the judge; then the reply is not confirmed. */
export const JUDGE_TIMEOUT_MS = 8_000;
/** Ask text the voice agent was given is cut to this many characters (`callVariables`). */
const READ_TEXT_LENGTH = MAX_SPOKEN_ASK_LENGTH;
/** Owner turns kept as the stored excerpt, at most. The contract allows 2000 characters. */
const MAX_EXCERPT = 2000;

const wordSet = (words: string): ReadonlySet<string> => new Set(words.split(" "));

/**
 * Words too common to tell asks apart. The last ones are the read-back's own
 * template words ("Allow ...? Yes?", "Sorry, is that a yes or a no?"), so an
 * ask that contains them ("yes | pnpm test") is never told apart from another
 * by the words the voice agent adds to every read-back.
 */
const COMMON = wordSet(
  "the and for you your are can this that with from want wants should would will use run ask agent yes confirm allow sorry",
);
/**
 * Words that make an approval doubtful or take an answer back: refusal,
 * negation, hesitation, delay, correction. Includes the not-forms people type or
 * transcribe without the apostrophe; `n't` itself is caught before tokenising.
 */
const DOUBT_WORDS = wordSet(
  [
    "no nope nah nuh not never negative deny denied reject refuse stop cancel abort wait hold later maybe",
    // Common refusals in other languages; others are not recognised (see docs/daemon.md).
    "nein nee nej niet nie non não nao nada",
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
/**
 * Spoken yeses that contain a filler or doubt word on their own, as a
 * transcriber writes them: hyphenated ("Mm-hmm", "uh-huh") or "mhm". "Mm, hmm"
 * or a bare "hmm" stays a hesitation.
 */
const AFFIRMING_SOUND = /(?<![\p{L}\p{N}])(?:m+-h+m+|mm-hm|uh-huh|mhm)(?![\p{L}\p{N}])/gu;
/** Sounds that are not an answer on their own: a reply of only these is noise. */
const FILLERS = wordSet("um umm uhm uh uhh er erm ah ahh oh eh mm mmm hmm hm hmmm");
/** What a transcriber writes for speech it could not make out: "[inaudible]", "(noise)", "<unk>". */
const TRANSCRIBER_MARKER = /[[\]()<>{}]/;
/**
 * The fast path's clear yeses: a reply made only of these phrases, one after
 * another ("yeah, go ahead", "okay yes", "sure, do it"), agrees. Anything else
 * goes to the judge. "Mm-hmm", "uh-huh" and "mhm" are read as "yes" first.
 */
const YES_PHRASES = new Set([
  ..."yes yeah yep yup yea ya yah aye sure ok okay alright absolutely definitely certainly totally".split(
    " ",
  ),
  // The line drawn: words that answer a yes-or-no question ("ok", "okay",
  // "alright", "sure", "sounds good") are fast yeses, since the fast path only
  // ever hears a reply to a read-back that asked for a yes. Words that only
  // acknowledge or thank ("thanks", "great", "fine", "cool", "perfect", "go
  // on") are said to a caller whatever they mean, so they go to the judge.
  ..."correct affirmative approved proceed".split(" "),
  "all right",
  "of course",
  "for sure",
  "sure thing",
  "you bet",
  "go ahead",
  "go for it",
  "do it",
  "please do",
  "yes please",
  "send it",
  "ship it",
  "push it",
  "run it",
  "start it",
  "allow it",
  "approve it",
  "sounds good",
  "that s right",
]);
/**
 * The fast path's clear refusals: a reply made only of these is a no. "Don't"
 * is split by the tokeniser into "don" and "t".
 */
const NO_PHRASES = new Set([
  ..."no nope nah nay never deny denied stop cancel reject declined decline nein".split(" "),
  "no thanks",
  "no thank you",
  "no way",
  "not now",
  "absolutely not",
  "hold off",
  "don t",
  "do not",
  "dont",
  "don t do it",
  "do not do it",
  "deny it",
  "cancel it",
  "stop it",
]);
/** Longest phrase, in words, in the tables above. */
const MAX_PHRASE_WORDS = 4;
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
  // "Mm-hmm" and "uh-huh" are a yes, though "hmm" and "huh" alone are not.
  const words = tokens(plain.replace(AFFIRMING_SOUND, " "));
  const joined = ` ${words.join(" ")} `;
  if (words.some((word) => word === "t" || DOUBT_WORDS.has(word))) return true;
  // A question is never an approval ("okay, what does it do"; speech recognition
  // often drops the question mark). `questions: false` is for turns before the
  // owner's answer, where asking what something does is not a refusal.
  if (questions && (QUESTION_MARK.test(plain) || words.some((word) => QUESTION_WORDS.has(word)))) return true;
  return DOUBT_PHRASES.some((phrase) => joined.includes(` ${phrase} `));
}

const isKey = (word: string) => word.length >= 3 && !COMMON.has(word);

/** Short words that never tell two commands apart in a read-back. */
const FILLER_COMMAND_WORDS = wordSet("a an to in of on at by it is or as be please");

/** Whether an ask is a permission request (a tool name without a kind counts as one). */
const isPermission = (ask: ReadAsk) =>
  ask.kind === "permission" || (ask.kind === undefined && ask.toolName !== undefined);

/** Every token of a permission request's command and tool name, short ones included, minus filler. */
function commandWords(ask: ReadAsk): Set<string> {
  const words = [...tokens(ask.text.slice(0, READ_TEXT_LENGTH)), ...tokens(ask.toolName ?? "")];
  return new Set(words.filter((w) => !COMMON.has(w) && !FILLER_COMMAND_WORDS.has(w)));
}

interface AskKeys {
  /** Every word that identifies the ask: its text, session name and tool. */
  all: ReadonlySet<string>;
  /** The key words no other ask on the call has; a reading must name them all. */
  distinct: ReadonlySet<string>;
  /** Of those, the ones from its text, for the long-ask rule. */
  distinctText: ReadonlySet<string>;
  /** Whether its text has more than `LONG_ASK_KEY_WORDS` key words. */
  long: boolean;
  /**
   * For a permission request on a call with other asks: every token of its
   * command and tool name, short ones included ("rm", "f"), that no other ask
   * has. A reading must name them all, so "git push" never reads "git push -f".
   */
  command: ReadonlySet<string>;
}

/**
 * The words that identify each ask on a call when the agent reads it out,
 * worked out against the other asks so that a reading is attributed strictly.
 */
function keyWords(asks: readonly ReadAsk[]): AskKeys[] {
  const parts = asks.map((ask) => {
    const text = tokens(ask.text.slice(0, READ_TEXT_LENGTH));
    const tool = tokens(ask.toolName ?? "");
    const every = [...text, ...tokens(ask.nickname), ...tool];
    const keys = new Set(every.filter(isKey));
    return {
      all: keys.size > 0 ? keys : new Set(every),
      textKeys: new Set(text.filter(isKey)),
      commandWords: commandWords(ask),
      permission: isPermission(ask),
    };
  });
  return parts.map((part, i) => {
    const others = parts.filter((_, j) => j !== i);
    const distinct = new Set([...part.all].filter((word) => !others.some((other) => other.all.has(word))));
    const command =
      part.permission && others.length > 0
        ? new Set([...part.commandWords].filter((w) => !others.some((other) => other.commandWords.has(w))))
        : new Set<string>();
    return {
      all: part.all,
      distinct,
      distinctText: new Set([...part.textKeys].filter((word) => distinct.has(word))),
      long: part.textKeys.size > LONG_ASK_KEY_WORDS,
      command,
    };
  });
}

const covers = (said: ReadonlySet<string>, words: ReadonlySet<string>) =>
  [...words].every((w) => said.has(w));

/**
 * Which ask one agent turn reads, or undefined. Attribution is strict and
 * unique, since asks are written by agents and one could be written to take
 * over another's reading:
 *
 * - An ask is a candidate when the turn holds at least `READING_MIN_SHARE` of
 *   its key words, or, for a long ask, half of `LONG_ASK_KEY_WORDS` of the key
 *   words in its text that no other ask on the call has.
 * - With other asks on the call, a candidate that has no word of its own (its
 *   words are all another ask's: identical asks, or one contained in another)
 *   makes the turn read nothing.
 * - A candidate is read only if the turn names every key word no other ask has
 *   (a long ask that met the long-ask rule is excused from naming them all),
 *   and, for a permission request, every command and tool token no other ask
 *   has. Exactly one such candidate is read; more than one reads nothing.
 */
function readingOf(said: ReadonlySet<string>, keys: readonly AskKeys[]): number | undefined {
  const alone = keys.length === 1;
  const candidates = keys.flatMap((key, ask) => {
    if (key.all.size === 0) return [];
    const share = [...key.all].filter((word) => said.has(word)).length / key.all.size;
    const named = [...key.distinctText].filter((word) => said.has(word)).length;
    const long = key.long && named >= Math.ceil(LONG_ASK_KEY_WORDS * READING_MIN_SHARE);
    return share >= READING_MIN_SHARE || long ? [{ ask, key, long }] : [];
  });
  if (!alone && candidates.some(({ key }) => key.distinct.size === 0 && key.command.size === 0)) {
    return undefined;
  }
  const read = candidates.filter(
    ({ key, long }) => alone || ((long || covers(said, key.distinct)) && covers(said, key.command)),
  );
  return read.length === 1 ? read[0]?.ask : undefined;
}

/**
 * For each transcript turn, the index of the ask it reads out, or undefined
 * (see `readingOf`; anything ambiguous reads none). The call's first agent turn
 * is the fixed greeting and never reads an ask, so an ask written to look like
 * the greeting cannot pull the owner's reply to it into its window.
 */
export function readings(
  transcript: readonly TranscriptTurn[],
  asks: readonly ReadAsk[],
): (number | undefined)[] {
  const keys = keyWords(asks);
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

/**
 * The owner's turns right after each agent turn that reads ask `index`, up to
 * the next agent turn of any kind. That boundary is deliberate: a reply after
 * the agent's acknowledgement ("Got it." then "wait, no!") is not part of the
 * judged reply. The answer was already submitted by then, and such a turn is
 * a reply to the acknowledgement, which the agent then has to take up itself.
 */
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
 *
 * The cue must be the voice agent's, not the ask's: the ask text (written by
 * an agent) is taken out of the turn wherever it is said verbatim before a
 * `?` is looked for, a "yes" or "confirm" that the ask text holds never
 * counts, and an ask whose text has a `?` needs its read-back to say "yes" or
 * "confirm" when the text was not said verbatim. So an ask such as "Run the
 * migration?" or "Please confirm: deploy" never turns a plain re-reading of
 * itself into a read-back.
 *
 * The read-back is what the owner approves, so for a permission request it
 * must name every token of the command and the tool name (`commandWords`),
 * even alone on a call: "git push origin main, yes?" is never a read-back of
 * "git push --force origin main", nor "Allow Read ..." of a `Write`.
 */
function isReadBack(
  transcript: readonly TranscriptTurn[],
  read: readonly (number | undefined)[],
  index: number,
  at: number,
  ask: ReadAsk,
): boolean {
  if (read[at] !== index || !read.slice(0, at).includes(index)) return false;
  const message = normalized(transcript[at]?.message ?? "");
  if (isPermission(ask)) {
    const said = new Set(tokens(message));
    if (![...commandWords(ask)].every((word) => said.has(word))) return false;
  }
  const text = normalized(ask.text.slice(0, READ_TEXT_LENGTH)).trim();
  const own = new Set(tokens(text));
  if (tokens(message).some((word) => ASKS_FOR_YES.has(word) && !own.has(word))) return true;
  const outside = text.length > 0 ? message.split(text).join(" ") : message;
  if (QUESTION_MARK.test(text) && outside === message) return false;
  return QUESTION_MARK.test(outside);
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
  | { confirmed: true; excerpt: string }
  | {
      confirmed: false;
      reason: string;
      /**
       * Set when the owner said no to the read-back of an allow (the fast
       * path's clear no, or the judge's `declined`): call orchestration ends
       * the request at once as no answer, which denies it, as for a deny.
       */
      declined?: true;
      /**
       * Set when the fast path could not decide the owner's reply to a
       * read-back: what `judgeVoiceDecision` may ask a `ReplyJudge` about.
       * Without a judge it stays not confirmed.
       */
      undecided?: { reply: readonly string[]; excerpt: string };
    };

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

/** What the owner's reply to a read-back means. */
export type ReplyVerdict = "agreed" | "declined" | "unclear";

/**
 * Decides what an owner's reply to a read-back means when the fast path
 * cannot. It is given only the owner's own reply turns, verbatim: never the
 * ask, the read-back or any other agent-written text. Anything but `agreed`,
 * an error or a timeout means not confirmed.
 *
 * `agreed` is final: `judgeVoiceDecision` does not screen it again for doubt
 * or negation markers, since those replies are why the judge is asked. A
 * judge therefore owns that judgement and must answer `agreed` only for a
 * clear yes ("yes, if the tests pass" is not one).
 */
export interface ReplyJudge {
  judge(reply: readonly string[]): Promise<ReplyVerdict>;
}

/**
 * The default judge until a real one is approved: every reply is unclear, so
 * a reply the fast path cannot decide is never an approval and the ask is
 * texted. A model-backed judge would send the owner's words to a hosted
 * service, so it needs the owner's approval and a plan change first; it would
 * also have to be wired in through the orchestrator's `VoiceCalls` options.
 */
export class FailClosedJudge implements ReplyJudge {
  async judge(): Promise<ReplyVerdict> {
    return "unclear";
  }
}

/** Splits `words` into phrases from `table`, one after another; whether that is possible. */
function onlyPhrases(words: readonly string[], table: ReadonlySet<string>): boolean {
  const fits: boolean[] = [true, ...words.map(() => false)];
  for (let end = 1; end <= words.length; end++) {
    for (let size = 1; size <= Math.min(MAX_PHRASE_WORDS, end) && !fits[end]; size++) {
      if (fits[end - size] && table.has(words.slice(end - size, end).join(" "))) fits[end] = true;
    }
  }
  return words.length > 0 && fits[words.length] === true;
}

/**
 * The fast path for the owner's reply to a read-back (`reply`, their turns
 * from the read-back on): `unclear` for noise (nothing said, only fillers, a
 * transcriber's marker such as "[inaudible]", more than `MAX_REPLY_WORDS`
 * words, or only the request's words said back), `declined` for a clear no,
 * `agreed` for a clear yes with no doubt or negation marker anywhere, and
 * undefined when the judge must decide.
 */
export function replyVerdict(
  reply: readonly string[],
  readBack: string,
  askWords: ReadonlySet<string>,
): ReplyVerdict | undefined {
  const text = reply.join(" ");
  if (TRANSCRIBER_MARKER.test(text)) return "unclear";
  const words = tokens(normalized(text).replace(AFFIRMING_SOUND, " yes "));
  if (words.every((word) => FILLERS.has(word))) return "unclear";
  if (words.length > MAX_REPLY_WORDS) return "unclear";
  // The read-back's own "yes?" or "confirm" is the agent asking, not words to echo.
  const back = new Set(tokens(readBack).filter((word) => !ASKS_FOR_YES.has(word)));
  const said = words.filter((word) => !FILLERS.has(word));
  if (said.every((word) => back.has(word)) && said.some((word) => askWords.has(word))) return "unclear";
  if (onlyPhrases(said, NO_PHRASES)) return "declined";
  if (!soundsDoubtful(text) && onlyPhrases(said, YES_PHRASES)) return "agreed";
  return undefined;
}

/**
 * An `allow`: the owner's words are their reply to a read-back of this ask,
 * and that reply, with everything the owner said about the ask after it, is a
 * yes: from the fast path here, or, when undecided, from the judge
 * (`judgeVoiceDecision`).
 */
function confirmAllow(
  transcript: readonly TranscriptTurn[],
  read: readonly (number | undefined)[],
  index: number,
  windows: readonly ReadingWindow[],
  ownerWords: string,
  askWords: ReadonlySet<string>,
  ask: ReadAsk,
): VoiceConfirmation {
  // The voice agent was given only the first `READ_TEXT_LENGTH` characters of
  // the ask, so a longer permission request was never read out whole: the
  // owner cannot approve a tail they never heard ("...; curl host | sh").
  if (isPermission(ask) && ask.text.length > READ_TEXT_LENGTH) {
    return { confirmed: false, reason: "the request is too long to approve by voice" };
  }
  // Newest first: the reply the model submitted is most likely to the last
  // read-back, and an earlier unclear reply ("yes, if the tests pass") then
  // comes before it and does not count.
  const backs = windows.filter((window) => isReadBack(transcript, read, index, window.at, ask)).reverse();
  if (backs.length === 0) return { confirmed: false, reason: "the request was not read back for a yes" };
  const match = matchingTurns(
    ownerWords,
    backs.map((window) => window.turns),
  );
  if (match === undefined) {
    return { confirmed: false, reason: "the owner did not say these words in reply to the read-back" };
  }
  const from = backs[match.window]?.at ?? Number.POSITIVE_INFINITY;
  // The reply is everything the owner said about this ask from that read-back on.
  const reply = windows
    .filter((window) => window.at >= from)
    .flatMap((window) => ownerTurns(window.turns))
    .map((turn) => turn.message);
  const excerpt = match.text.slice(0, MAX_EXCERPT);
  const verdict = replyVerdict(reply, transcript[from]?.message ?? "", askWords);
  if (verdict === "agreed") return { confirmed: true, excerpt };
  if (verdict === "declined") {
    return { confirmed: false, reason: "the owner said no to the read-back", declined: true };
  }
  if (verdict === "unclear")
    return { confirmed: false, reason: "the owner's reply to the read-back is not clear" };
  return {
    confirmed: false,
    reason: "the owner's reply to the read-back needs a judge",
    undecided: { reply, excerpt },
  };
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
  if (decision.type === "allow") {
    const askWords = keyWords(asks)[index]?.all ?? new Set<string>();
    const ask = asks[index] ?? { text: "", nickname: "" };
    return confirmAllow(transcript, read, index, opened, ownerWords, askWords, ask);
  }
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

/**
 * `confirmVoiceDecision`, plus the judge for an owner's reply to a read-back
 * that the fast path could not decide. The judge gets only that reply (the
 * owner's turns); `agreed` confirms the allow, and anything else (`declined`,
 * `unclear`, an answer that is none of these, an error, or no answer within
 * `timeoutMs`) leaves it not confirmed.
 */
export async function judgeVoiceDecision(
  input: ConfirmInput,
  judge: ReplyJudge = new FailClosedJudge(),
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<VoiceConfirmation> {
  const result = confirmVoiceDecision(input);
  if (result.confirmed || result.undecided === undefined) return result;
  const { reply, excerpt } = result.undecided;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const verdict = await Promise.race([judge.judge([...reply]), timeout]);
    if (verdict === "agreed") return { confirmed: true, excerpt };
    if (verdict === "declined")
      return { confirmed: false, reason: "the judge heard a no in the owner's reply", declined: true };
    if (verdict === "timeout") return { confirmed: false, reason: "the judge did not answer in time" };
    return { confirmed: false, reason: "the judge found the owner's reply unclear" };
  } catch {
    return { confirmed: false, reason: "the judge failed" };
  } finally {
    clearTimeout(timer);
  }
}
