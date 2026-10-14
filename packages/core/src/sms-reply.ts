// The owner's text-message replies (plan section 4, flow E): an option number,
// yes/no, free text, `call me`, `status` or `stop`. Pure: no I/O, no clock.
//
// `parseSmsReply` says what a message is; `smsAnswer` turns it into an `Answer`
// for one ask, or "no answer". Matching is exact: a reply must be one of the
// known words, alone, to count as a yes or a no. Anything else is free text, and
// free text never approves a permission request.
import { type Answer, type Ask, answerProblem, type Decision } from "./contracts.js";

export const SmsCommand = ["call-me", "status", "stop"] as const;
export type SmsCommand = (typeof SmsCommand)[number];

export type SmsReply =
  /** A command for Hotline itself, never an answer to an ask. */
  | { type: "command"; command: SmsCommand }
  /** A bare option number, 1 to 9. */
  | { type: "option"; option: number }
  /** A clear yes, optionally followed by the confirmation code from the text it answers. */
  | { type: "yes"; code?: string }
  | { type: "no" }
  /** "done", "that's it": nothing more for a stopped agent. */
  | { type: "done" }
  /** One of Twilio's opt-in or help keywords, which Twilio answers itself. Never an answer. */
  | { type: "carrier-keyword" }
  /** Anything else, verbatim. */
  | { type: "text"; text: string };

const YES = new Set(["yes", "y", "yeah", "yep", "yup", "approve", "approved", "allow"]);
const NO = new Set(["no", "n", "nope", "deny", "denied", "reject"]);
const DONE = new Set(["done", "all done", "that's it", "thats it", "nothing"]);
const COMMANDS = new Map<string, SmsCommand>([
  ["call me", "call-me"],
  ["call", "call-me"],
  ["status", "status"],
  // Twilio's default opt-out keywords. Twilio blocks texts to the owner after
  // any of them until START, so Hotline must treat them all as "stop texting me".
  // https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
  ...["stop", "stopall", "unsubscribe", "end", "quit", "cancel", "revoke", "optout"].map(
    (word) => [word, "stop"] as [string, SmsCommand],
  ),
]);
/** Twilio's reserved opt-in and help keywords: Twilio sends its own reply. */
const CARRIER_KEYWORDS = new Set(["start", "unstop", "help", "info"]);

/** A one-time code the daemon puts in every permission request it texts: 4 to 10 digits. */
const CODE = /^\d{4,10}$/;

/** Lower case, single spaces, plain apostrophes, no trailing punctuation. */
function normalize(body: string): string {
  return body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

/** Classifies one text message from the owner. */
export function parseSmsReply(body: string): SmsReply {
  const words = normalize(body);
  const command = COMMANDS.get(words);
  if (command !== undefined) return { type: "command", command };
  if (CARRIER_KEYWORDS.has(words)) return { type: "carrier-keyword" };
  const option = /^#?([1-9])$/.exec(words);
  if (option?.[1] !== undefined) return { type: "option", option: Number(option[1]) };
  if (YES.has(words)) return { type: "yes" };
  const [first, code, ...rest] = words.split(" ");
  if (first !== undefined && YES.has(first) && code !== undefined && rest.length === 0 && CODE.test(code)) {
    return { type: "yes", code };
  }
  if (NO.has(words)) return { type: "no" };
  if (DONE.has(words)) return { type: "done" };
  return { type: "text", text: body };
}

/** Compares two codes without stopping at the first difference. */
function codesMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export interface SmsAnswerInput {
  /** The ask this message answers. */
  ask: Ask;
  /** The message text, verbatim; it becomes the answer's `ownerExcerpt`. */
  body: string;
  /** Twilio's message SID. */
  messageSid: string;
  /** The daemon's clock reading when the message arrived. */
  receivedAt: Date;
  /**
   * The one-time code the daemon put in the text this message replies to. A
   * reply of "yes <code>" with this code is a confirming text, which every
   * approval of a permission request by text needs, whatever its risk. Leave
   * unset when no code was sent; then no text can approve the request.
   */
  confirmationCode?: string;
}

export type SmsAnswerResult =
  | { outcome: "answered"; answer: Answer }
  /** Nobody decided: the agent gets "no answer" (a permission request is denied). */
  | { outcome: "no-answer"; reason: string };

function decide(
  ask: Ask,
  body: string,
  confirmationCode: string | undefined,
): { decision: Decision; confirmed: boolean } | string {
  const reply = parseSmsReply(body);
  // Free text keeps the owner's exact words, not the normalized form.
  const freeText = { decision: { type: "text", text: body } as Decision, confirmed: false };
  if (reply.type === "command") return `"${reply.command}" is a command, not an answer`;
  if (reply.type === "carrier-keyword") return "a carrier keyword is not an answer";
  switch (ask.kind) {
    case "question":
      if (reply.type !== "option" || ask.options.length === 0) return freeText;
      return reply.option <= ask.options.length
        ? { decision: { type: "option", option: reply.option }, confirmed: false }
        : "option is not one the ask offered";
    case "permission":
      if (reply.type === "no") return { decision: { type: "deny" }, confirmed: false };
      if (reply.type !== "yes") return "only a clear yes or no answers a permission request";
      // Every approval by text names its ask with that ask's single-use code, low
      // risk included: Twilio signatures carry no timestamp, so a bare "yes"
      // (replayed, or meant for something else) must never approve a new request.
      if (reply.code === undefined) return "an approval by text needs the confirmation code from the text";
      if (confirmationCode === undefined || !codesMatch(reply.code, confirmationCode)) {
        return "the confirmation code does not match";
      }
      return { decision: { type: "allow" }, confirmed: true };
    case "stop":
      if (reply.type === "done" || reply.type === "no")
        return { decision: { type: "done" }, confirmed: false };
      if (reply.type === "yes") return "a yes is not an instruction";
      return freeText;
    case "notify":
      return "a notification takes no answer";
  }
}

/**
 * The owner's answer to `ask` from one text message, or why there is none. Call
 * it only for a message from the owner's number on a verified webhook: the
 * `confirmation: "text"` it sets rests on that check and on the code.
 */
export function smsAnswer({
  ask,
  body,
  messageSid,
  receivedAt,
  confirmationCode,
}: SmsAnswerInput): SmsAnswerResult {
  if (body.trim().length === 0 || body.length > 2000) {
    return { outcome: "no-answer", reason: "empty or oversized message" };
  }
  if (Number.isNaN(receivedAt.getTime()))
    return { outcome: "no-answer", reason: "the arrival time is unknown" };
  const decided = decide(ask, body, confirmationCode);
  if (typeof decided === "string") return { outcome: "no-answer", reason: decided };
  const answer: Answer = {
    askId: ask.id,
    decision: decided.decision,
    channel: "sms",
    ownerExcerpt: body,
    sourceId: messageSid,
    confirmation: decided.confirmed ? "text" : "none",
    answeredAt: receivedAt.toISOString(),
  };
  const problem = answerProblem(ask, answer, receivedAt);
  return problem === undefined ? { outcome: "answered", answer } : { outcome: "no-answer", reason: problem };
}
