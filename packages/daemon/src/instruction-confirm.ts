// Confirms an owner instruction (`send_instruction`) against the post-call
// transcript before it is queued for a session (HL-10).
//
// The voice model writes the tool's `instruction`, `owner_words` and
// `session_number`, and the status it read out holds agent-written text, so the
// model's word proves nothing. An instruction becomes a coding agent's next
// prompt, so it counts only when the call went like this, in the owner's own
// turns (on an inbound call only turns after the PIN are the owner's; agent and
// caller turns never count):
//
// 1. The owner's utterance: one stretch of owner turns between two agent turns
//    that is the instruction and nothing else. Its words are the instruction's
//    words, in order, preceded at most by a session reference ("session two",
//    "tell Codex to", "the second one") and filler ("um", "okay"), and followed
//    at most by filler ("thanks"). Any other word, before or after, means not
//    confirmed: "don't push to main" never confirms "push to main", and "push
//    after the tests pass" never confirms "push". Every word of the instruction
//    therefore comes from the owner's own turns.
// 2. The session: exactly one session is identified in the owner's session
//    reference (or, when the utterance has none, in an owner stretch just before
//    it that is only a session reference), by number ("session two", "number
//    2", an ordinal, a bare digit) or by a name that matches it better than any
//    other session the status listed. Words inside the instruction never name a
//    session. Two identifiers, or none with more than one session listed, mean
//    not confirmed.
// 3. The read-back: the agent's next turn names "session <n>" and repeats the
//    instruction's words ("For session 2, Codex in api: rebase on main. Send
//    it?"), and the owner's reply to it is a clear yes: a yes word, nothing
//    doubtful, no question, no take-back.
// 4. No take-back: the owner's next stretch after that (their reply to the
//    agent's following turn) holds no retraction ("never mind", "cancel that",
//    "scratch that", "forget it", "don't send", "actually no", "wait").
//    Nothing the model sent can mask one.
//
// `owner_words` must also be the owner's words in the utterance. Every
// comparison uses one tokeniser (`speechTokens`, shared with `ownerSaid` and
// voice-confirm.ts). Everything fails closed. Pure: no I/O, no clock.
import { ownerSaid, speechTokens, type TranscriptTurn } from "@hotline/providers";
import { soundsDoubtful, type VoiceConfirmation } from "./voice-confirm.js";

const MAX_EXCERPT = 2000;
const NUMBER_WORDS = "one two three four five six seven eight nine ten".split(" ");
const ORDINALS = "first second third fourth fifth sixth seventh eighth ninth tenth".split(" ");
const set = (words: string) => new Set(words.split(" "));
/** Words that carry nothing: allowed around an instruction. */
const FILLER = set("um umm uh uhh er erm hmm oh so well ok okay alright right hey yeah yes please");
/** Words a session reference may use besides numbers and the sessions' names. */
const ROUTING = set("session sessions number tell ask the to and for in can you could would");
/** Allowed after the instruction, besides filler. */
const CLOSING = set("thanks thank you");
/** Words that make the reply to a read-back a yes. */
const YES = set(
  "yes yeah yep yup yea sure ok okay go send correct right fine absolutely definitely confirm confirmed",
);
/** Retractions. Phrases are compared as `speechTokens`, so "don't" is "don t". */
const TAKE_BACKS = [
  "never mind",
  "nevermind",
  "cancel that",
  "cancel it",
  "scratch that",
  "forget it",
  "forget that",
  "don't send",
  "do not send",
  "actually no",
  "no wait",
  "wait",
  "hold on",
  "hang on",
  "take that back",
  "undo that",
].map((phrase) => ` ${speechTokens(phrase).join(" ")} `);
/** Words in a nickname too common to tell sessions apart. */
const COMMON = set("the and for unnamed folder");

/** An instruction as `send_instruction` gave it, with what the call's status listed. */
export interface HeldInstruction {
  /** The model's `instruction`: what would be queued. */
  instruction: string;
  /** The model's `owner_words`. */
  ownerWords: string;
  /** 1-based, as the status on this call numbered the sessions. */
  sessionNumber: number;
  /** The spoken names of the sessions the status listed, in order: session N is `listed[N - 1]`. */
  listed: readonly string[];
}

/** Whether `text` holds a retraction. */
export function takesBack(text: string): boolean {
  const joined = ` ${speechTokens(text).join(" ")} `;
  return TAKE_BACKS.some((phrase) => joined.includes(phrase));
}

const nameWords = (nickname: string) =>
  speechTokens(nickname).filter((word) => word.length >= 3 && !COMMON.has(word) && !/^\d+$/.test(word));

const numberOf = (word: string | undefined): number | undefined => {
  if (word === undefined) return undefined;
  if (/^\d{1,2}$/.test(word)) return Number(word);
  const index = NUMBER_WORDS.indexOf(word);
  return index >= 0 ? index + 1 : undefined;
};

/**
 * The sessions (1-based) that `words`, a session reference, identifies: by
 * "session N" or "number N", an ordinal, a bare digit, or a name that matches
 * one listed session better than every other (a tie identifies none, and
 * counts as ambiguous: 0 is added). A bare number word ("one") is not an
 * identifier, since "the second one" names session 2 only.
 */
export function sessionsNamed(words: readonly string[], listed: readonly string[]): Set<number> {
  const named = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if ((word === "session" || word === "number") && numberOf(words[i + 1]) !== undefined) {
      named.add(numberOf(words[i + 1]) as number);
      i += 1;
    } else if (ORDINALS.includes(word)) named.add(ORDINALS.indexOf(word) + 1);
    else if (/^\d{1,2}$/.test(word)) named.add(Number(word));
  }
  const shares = listed.map((nickname) => {
    const keys = nameWords(nickname);
    return keys.length === 0 ? 0 : keys.filter((key) => words.includes(key)).length / keys.length;
  });
  const best = Math.max(0, ...shares);
  if (best > 0) {
    const top = shares.flatMap((share, i) => (share === best ? [i + 1] : []));
    named.add(top.length === 1 ? (top[0] as number) : 0);
  }
  return named;
}

/** Words a session reference may hold: routing, filler, numbers, ordinals, the listed names. */
function referenceWords(listed: readonly string[]): Set<string> {
  return new Set([
    ...FILLER,
    ...ROUTING,
    ...NUMBER_WORDS,
    ...ORDINALS,
    ...listed.flatMap((nickname) => speechTokens(nickname)),
  ]);
}

type Block = { kind: "agent"; turn: TranscriptTurn } | { kind: "person"; turns: TranscriptTurn[] };

function blocks(transcript: readonly TranscriptTurn[]): Block[] {
  const result: Block[] = [];
  for (const turn of transcript) {
    const last = result.at(-1);
    if (turn.role === "agent") result.push({ kind: "agent", turn });
    else if (last?.kind === "person") last.turns.push(turn);
    else result.push({ kind: "person", turns: [turn] });
  }
  return result;
}

/** The owner's turns of a person block, or undefined when anyone else spoke in it. */
function ownerBlock(block: Block | undefined): TranscriptTurn[] | undefined {
  if (block?.kind !== "person" || block.turns.some((turn) => turn.role !== "owner")) return undefined;
  return block.turns;
}

const textOf = (turns: readonly TranscriptTurn[]) => turns.map((turn) => turn.message).join(" ");

/** Every start of `needle` as a run of consecutive words in `haystack`. */
function occurrences(haystack: readonly string[], needle: readonly string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) starts.push(start);
  }
  return starts;
}

/** Whether the post-call transcript backs a held instruction; see the top of this file. */
export function confirmInstruction(
  transcript: readonly TranscriptTurn[],
  held: HeldInstruction,
): VoiceConfirmation {
  const wanted = speechTokens(held.instruction);
  if (wanted.length === 0) return { confirmed: false, reason: "the instruction has no words" };
  const words = referenceWords(held.listed);
  const allowed = { has: (word: string) => words.has(word) || /^\d{1,2}$/.test(word) };
  const parts = blocks(transcript);
  let reason = "the instruction is not the owner's own words";
  for (const [i, block] of parts.entries()) {
    const turns = ownerBlock(block);
    if (turns === undefined) continue;
    const said = speechTokens(textOf(turns));
    for (const start of occurrences(said, wanted)) {
      const before = said.slice(0, start);
      const after = said.slice(start + wanted.length);
      // 1. The utterance is the instruction, a session reference and filler, nothing more.
      if (
        !before.every((word) => allowed.has(word)) ||
        !after.every((word) => FILLER.has(word) || CLOSING.has(word))
      ) {
        reason = "the owner said more than the instruction";
        continue;
      }
      if (!ownerSaid(held.ownerWords, turns)) {
        reason = "the owner did not say these words";
        continue;
      }
      // 2. Exactly one session, named outside the instruction's own words.
      let named = sessionsNamed(before, held.listed);
      const previous = ownerBlock(parts[i - 2]);
      if (named.size === 0 && previous !== undefined) {
        const reference = speechTokens(textOf(previous));
        if (reference.length > 0 && reference.every((word) => allowed.has(word))) {
          named = sessionsNamed(reference, held.listed);
        }
      }
      if (named.size === 0 && held.listed.length === 1) named = new Set([1]);
      if (named.size !== 1 || !named.has(held.sessionNumber)) {
        reason = "the owner did not name exactly this session";
        continue;
      }
      // 3. Read back with the session's number, and a clear yes to it.
      const readBack = parts[i + 1];
      const back = readBack?.kind === "agent" ? speechTokens(readBack.turn.message) : [];
      const numbered = back.some(
        (word, at) => word === "session" && numberOf(back[at + 1]) === held.sessionNumber,
      );
      if (!numbered || occurrences(back, wanted).length === 0) {
        reason = "the instruction was not read back for the owner to confirm";
        continue;
      }
      const reply = ownerBlock(parts[i + 2]);
      const clearYes =
        reply?.some((turn) => speechTokens(turn.message).some((word) => YES.has(word))) === true &&
        !reply.some((turn) => soundsDoubtful(turn.message) || takesBack(turn.message));
      if (!clearYes) {
        reason = "the owner did not confirm the read-back";
        continue;
      }
      // 4. No retraction in the owner's next reply. Nothing is excused from this check.
      const next = parts[i + 4];
      if (
        next?.kind === "person" &&
        next.turns.some((turn) => turn.role === "owner" && takesBack(turn.message))
      ) {
        reason = "the owner took the instruction back";
        continue;
      }
      return { confirmed: true, excerpt: textOf(turns).slice(0, MAX_EXCERPT) };
    }
  }
  return { confirmed: false, reason };
}
