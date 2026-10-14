// What Hotline texts the owner about an ask, and what an owner's text reply
// means for the asks waiting on texts. Pure: no I/O, no clock, no state; call
// orchestration (`orchestrator.ts`) carries the plan out.
//
// Safety rules this file keeps:
// - A reply answers only an ask Hotline texted that is still open, and only
//   one: a `YES <code>` names the ask with that code; without a code there
//   must be exactly one waiting ask, texted at least `MIN_REPLY_DELAY_MS`
//   before the message was first seen. Several waiting fail closed. So a reply
//   (or a replay) can never answer a request texted after it was written.
// - Approving a permission request always needs its code (core `smsAnswer`).
// - A code that matches no waiting ask burns every waiting code (the plan says
//   so); a code that matched is spent whatever happens next.
// - `smsAnswer` (core) decides what the words mean; free text never approves.
import { timingSafeEqual } from "node:crypto";
import { type Answer, type Ask, parseSmsReply, type SmsReply, smsAnswer } from "@hotline/core";

/** Agent text in an outgoing SMS, cut like the voice read-out. */
const SMS_ASK_LENGTH = 300;
const SMS_OPTION_LENGTH = 80;

/**
 * A reply without a code that arrives sooner than this after the text it would
 * answer is not bound to it: nobody reads a request and answers that fast, so
 * it was most likely meant for something earlier (a stray "yes").
 */
export const MIN_REPLY_DELAY_MS = 10_000;

/** One ask waiting on a text reply, with the confirmation code its text carried, if any. */
export interface WaitingText {
  ask: Ask;
  code?: string;
  /** When its text went out. */
  sentAt?: Date;
}

export type TextPlan =
  /** Not for Hotline to act on: an opt-out or carrier keyword, `stop`. */
  | { type: "ignore" }
  | { type: "call-me" }
  /** `status`: reply with what every live session is doing (HL-10). Never an answer. */
  | { type: "status" }
  | { type: "nothing-waiting" }
  /** Several asks wait on texts and the reply names none of them: nothing is recorded. */
  | { type: "ambiguous"; waiting: number }
  /**
   * A reply without a code first seen before, or too soon after, the one waiting
   * text: it cannot be an answer to it.
   */
  | { type: "too-soon" }
  /** A code that matches no waiting ask: burn every waiting code. */
  | { type: "code-mismatch" }
  /** The reply points at `ask` but does not answer it. `codeUsed`: spend its code. */
  | { type: "not-an-answer"; ask: Ask; reason: string; codeUsed: boolean }
  | { type: "answer"; ask: Ask; answer: Answer; codeUsed: boolean };

export interface TextReplyInput {
  body: string;
  messageSid: string;
  receivedAt: Date;
  /** When a message with this SID was first seen (the daemon's claim); `receivedAt` on a first delivery. */
  firstSeenAt: Date;
  /** Twilio sent `OptOutType`: it has already answered the message itself. */
  optedOut: boolean;
  /** Open asks Hotline texted (not duplicates), with their codes. */
  waiting: readonly WaitingText[];
}

function sameCode(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What an owner's text means for the asks waiting on texts. */
export function planTextReply({
  body,
  messageSid,
  receivedAt,
  firstSeenAt,
  optedOut,
  waiting,
}: TextReplyInput): TextPlan {
  const reply = parseSmsReply(body);
  if (optedOut || reply.type === "carrier-keyword") return { type: "ignore" };
  if (reply.type === "command") {
    if (reply.command === "call-me") return { type: "call-me" };
    return reply.command === "status" ? { type: "status" } : { type: "ignore" };
  }
  const code = reply.type === "yes" ? reply.code : undefined;
  let target: WaitingText | undefined;
  if (code !== undefined) {
    target = waiting.find((w) => w.code !== undefined && sameCode(code, w.code));
    if (target === undefined) return { type: "code-mismatch" };
  } else if (waiting.length === 0) {
    return { type: "nothing-waiting" };
  } else if (waiting.length > 1) {
    return { type: "ambiguous", waiting: waiting.length };
  } else {
    target = waiting[0];
    // Unknown send time fails closed too.
    const sentAt = target?.sentAt?.getTime();
    if (sentAt === undefined || firstSeenAt.getTime() - sentAt < MIN_REPLY_DELAY_MS) {
      return { type: "too-soon" };
    }
  }
  if (target === undefined) return { type: "nothing-waiting" };
  const result = smsAnswer({
    ask: target.ask,
    body,
    messageSid,
    receivedAt,
    ...(target.code === undefined ? {} : { confirmationCode: target.code }),
  });
  const codeUsed = code !== undefined;
  return result.outcome === "answered"
    ? { type: "answer", ask: target.ask, answer: result.answer, codeUsed }
    : { type: "not-an-answer", ask: target.ask, reason: result.reason, codeUsed };
}

/** What the owner's reply is, for the audit log: never the words. */
export function replyKind(body: string): string {
  const reply: SmsReply = parseSmsReply(body);
  return reply.type === "command" ? reply.command : reply.type;
}

/** The fixed replies Hotline sends back. */
export const TEXT_REPLIES = {
  calling: "Hotline: calling you now.",
  nothingWaiting: "Hotline: nothing is waiting for an answer right now.",
  codeMismatch:
    "Hotline: that code does not match a waiting request, so nothing was approved, and the codes in earlier texts no longer work. Text CALL ME to answer by phone.",
  answered: "Hotline: got it.",
  notRecorded: "Hotline: that answer could not be recorded.",
  notHandled: "Hotline: something went wrong and your text was not recorded. Please send it again.",
  interrupted:
    "Hotline: it restarted while handling a text from you, which may not have been recorded. If it still matters, please send it again.",
  ambiguous: (waiting: number) =>
    `Hotline: ${waiting} requests are waiting, so a reply cannot say which one it answers. Nothing was recorded. Text CALL ME to go through them by phone.`,
  notCalling: (reason: string) => `Hotline: not calling, ${reason}.`,
  tooSoon:
    "Hotline: that reply came before you could have read the latest request, so it was not used. Read it, then reply again.",
  statusUnavailable: "Hotline: status is not available right now.",
} as const;

/** One plain line of agent text, cut to `max`. */
function flat(text: string, max: number): string {
  const one = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The text that asks the owner one thing. Agent text is flattened and cut; the provider redacts it all. */
export function textFor(ask: Ask, nickname: string, code: string | undefined): string {
  const who = flat(nickname, 60);
  const text = flat(ask.text, SMS_ASK_LENGTH);
  switch (ask.kind) {
    case "question": {
      const options = ask.options
        .map((option, i) => `\n${i + 1}) ${flat(option, SMS_OPTION_LENGTH)}`)
        .join("");
      const how = ask.options.length > 0 ? "an option number or your answer" : "your answer";
      return `Hotline: ${who} asks: ${text}${options}\nReply with ${how}.`;
    }
    case "permission": {
      const tool = flat(ask.toolName ?? "a tool", 80);
      const risk = ask.risk === "high" ? "HIGH RISK. " : "";
      const how =
        code === undefined
          ? `It can only be approved on a call${ask.risk === "high" ? " with your PIN" : ""}. Reply NO to deny, or CALL ME.`
          : `Reply YES ${code} to allow, or NO to deny.`;
      return `Hotline: ${who} wants to use ${tool}: ${text}\n${risk}${how}`;
    }
    case "stop":
      return `Hotline: ${who} finished its turn: ${text}\nReply with what to do next, or DONE.`;
    case "notify":
      return `Hotline: ${who}: ${text}`;
  }
}

/** What to reply when a text did not answer the one waiting ask. */
export function replyHint(ask: Ask): string {
  switch (ask.kind) {
    case "permission":
      return "Hotline: not recorded. Reply YES with the code from the text, or NO.";
    case "question":
      return "Hotline: not recorded. Reply with an option number or your answer.";
    case "stop":
      return "Hotline: not recorded. Reply with what to do next, or DONE.";
    case "notify":
      return TEXT_REPLIES.nothingWaiting;
  }
}
