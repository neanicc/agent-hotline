// Confirms an owner instruction (`send_instruction`) against the post-call
// transcript before it is queued for a session (HL-10).
//
// The voice model writes the tool's `instruction` and `owner_words`, and the
// status it read out holds agent-written text, so the model's word proves
// nothing. An instruction becomes a coding agent's next prompt, so it counts
// only when the owner's own turns back it:
//
// - The instruction itself must be words the owner said (`ownerSaid`: case and
//   punctuation ignored, whole words, owner turns only), within one run of
//   consecutive owner turns. A paraphrase never counts. On an inbound call only
//   turns after the PIN are the owner's (`parsePostCallEvent`).
// - `owner_words` must also be the owner's, in that stretch of the call or the
//   one just before it (the owner may name the session, then say what to do).
// - The session must be the one the owner named there: by its number from the
//   status ("session two", "the second one", "2"), or by its name, matching it
//   better than any other session the status listed. With one session listed,
//   that one is meant.
// - Anything the owner said after it, up to the end of their reply to the
//   agent's next turn (the read-back), that sounds doubtful takes it back: "no
//   wait", "never mind", "actually", "cancel that" (`soundsDoubtful`, without
//   counting questions). The instruction's own words are not checked, since an
//   instruction may well say "don't", and nor is a later turn that gives
//   another instruction from the same call.
//
// Everything fails closed: not confirmed means not queued. Pure: no I/O, no clock.
import { ownerSaid, type TranscriptTurn } from "@hotline/providers";
import { soundsDoubtful, type VoiceConfirmation } from "./voice-confirm.js";

const MAX_EXCERPT = 2000;
const NUMBER_WORDS = "one two three four five six seven eight nine ten".split(" ");
const ORDINALS = "first second third fourth fifth sixth seventh eighth ninth tenth".split(" ");
/** Words in a nickname too common to tell sessions apart. */
const COMMON = new Set(["the", "and", "for", "unnamed", "folder"]);
const APOSTROPHES = /[’‘ʼ`´′]/g;

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
  /** The other instructions `send_instruction` gave on the same call. */
  otherInstructions?: readonly string[];
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(APOSTROPHES, "'")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function nameWords(nickname: string): string[] {
  return tokens(nickname).filter((word) => word.length >= 3 && !COMMON.has(word));
}

/** Whether `said` names session `n` of `listed`: by number, or by name better than any other. */
export function namesSession(said: readonly string[], n: number, listed: readonly string[]): boolean {
  if (listed.length === 1 && n === 1) return true;
  if (
    said.includes(String(n)) ||
    said.includes(ORDINALS[n - 1] ?? "") ||
    said.includes(NUMBER_WORDS[n - 1] ?? "")
  )
    return true;
  const shares = listed.map((nickname) => {
    const words = nameWords(nickname);
    return words.length === 0 ? 0 : words.filter((word) => said.includes(word)).length / words.length;
  });
  const target = shares[n - 1] ?? 0;
  return target > 0 && shares.every((share, i) => i === n - 1 || share < target);
}

/** The person turns between two agent turns, in order. */
function stretches(transcript: readonly TranscriptTurn[]): TranscriptTurn[][] {
  const result: TranscriptTurn[][] = [];
  let current: TranscriptTurn[] | undefined;
  for (const turn of transcript) {
    if (turn.role === "agent") {
      current = undefined;
      continue;
    }
    if (current === undefined) {
      current = [];
      result.push(current);
    }
    current.push(turn);
  }
  return result;
}

const owners = (turns: readonly TranscriptTurn[] | undefined) =>
  (turns ?? []).filter((t) => t.role === "owner");

/** Whether the post-call transcript backs a held instruction; see the top of this file. */
export function confirmInstruction(
  transcript: readonly TranscriptTurn[],
  held: HeldInstruction,
): VoiceConfirmation {
  const parts = stretches(transcript);
  let reason = "the instruction is not the owner's own words";
  for (const [k, stretch] of parts.entries()) {
    for (let end = 0; end < stretch.length; end++) {
      if (stretch[end]?.role !== "owner") continue;
      // The shortest run of owner turns ending here that holds the instruction.
      let start = end;
      while (
        start >= 0 &&
        stretch[start]?.role === "owner" &&
        !ownerSaid(held.instruction, stretch.slice(start, end + 1))
      )
        start -= 1;
      if (start < 0 || stretch[start]?.role !== "owner") continue;
      const nearby = [...owners(parts[k - 1]), ...owners(stretch)];
      if (!ownerSaid(held.ownerWords, owners(stretch)) && !ownerSaid(held.ownerWords, owners(parts[k - 1]))) {
        reason = "the owner did not say these words";
        continue;
      }
      if (
        !namesSession(
          nearby.flatMap((turn) => tokens(turn.message)),
          held.sessionNumber,
          held.listed,
        )
      ) {
        reason = "the owner did not name this session";
        continue;
      }
      // A turn that gives another instruction from this call is not a take-back,
      // though that instruction may say "don't".
      const later = [...owners(stretch.slice(end + 1)), ...owners(parts[k + 1])].filter(
        (turn) => !(held.otherInstructions ?? []).some((other) => ownerSaid(other, [turn])),
      );
      if (later.some((turn) => soundsDoubtful(turn.message, false))) {
        reason = "the owner took the instruction back";
        continue;
      }
      const excerpt = stretch
        .slice(start, end + 1)
        .map((turn) => turn.message)
        .join(" ")
        .slice(0, MAX_EXCERPT);
      return { confirmed: true, excerpt };
    }
  }
  return { confirmed: false, reason };
}
