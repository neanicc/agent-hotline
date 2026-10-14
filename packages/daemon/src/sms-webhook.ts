// POST /hooks/twilio/sms: Twilio's incoming-message webhook.
// https://www.twilio.com/docs/messaging/guides/webhook-request
//
// Fails closed at every step:
// - before the body is read, the request must carry `X-Twilio-Signature` and a
//   form content type (`precheck`);
// - the body is parsed strictly, and a parse error is the same bare 403;
// - the signature is checked against the exact public URL and the form
//   parameters, in constant time, and the account SID must be ours (`verify`);
// - only a text from the owner's number to the Hotline number reaches
//   `onOwnerMessage`. Anyone else gets one generic reply that reveals nothing,
//   and a few per hour at most, so a stranger cannot run up the bill;
// - a valid signature is not enough (HL-13a): a same-user process can read the
//   auth token and sign a webhook itself. So before any text has any effect,
//   the owner's or anyone else's, opt-out keywords included (HL-13c), the
//   message is fetched from Twilio's REST API by SID (`lookup`) and must
//   exist, be inbound, from the sender to the number the webhook names, with
//   the same body, and recent (`smsMismatch`). Anything else gets the bare
//   empty TwiML and is not handled at all; it is reported (`onUnverified`), a
//   mismatch as a possible forgery;
// - the HTTP response goes back to whoever posted the webhook, so it never
//   carries the status (what the owner's sessions are doing): the owner
//   handler texts that to the owner's number itself (HL-13c). A reply it
//   returns is a short acknowledgement of a text Twilio confirmed, redacted
//   before it goes back to Twilio, like every other outgoing text;
// - a message SID counts as handled only once its handler has succeeded. A
//   retry that arrives while the first delivery is still being handled waits
//   for it, and handles the message itself if that first attempt failed.
//
// Bodies, numbers and message text are never logged; only the message SID and
// whether the sender was the owner.
import {
  type FormParams,
  type PulledMessage,
  prepareSmsText,
  sameE164,
  validTwilioSignature,
} from "@hotline/providers";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type ExpectedSms, pullFailure, smsMismatch, type Unverified } from "./provider-pull.js";
import type { WebhookRoute } from "./server.js";

/** Below `/hooks`. Point the Twilio number's "A message comes in" webhook at `<publicUrl>/hooks/twilio/sms`. */
export const TWILIO_SMS_PATH = "/twilio/sms";
/** All anyone but the owner ever hears back. Says nothing about Hotline, agents or the owner. */
export const GENERIC_SMS_REPLY = "Sorry, this number does not accept messages.";
export const OTHER_SENDER_REPLIES_PER_HOUR = 5;
/** How many message SIDs to remember, to drop Twilio retries and replays of a recent message. */
const SEEN_MESSAGES = 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface OwnerSms {
  /** Twilio's message SID (`SM` or `MM` plus 32 hex digits). */
  messageSid: string;
  /**
   * The text verbatim as Twilio's own record has it (the webhook's `Body`
   * matched it up to whitespace and Unicode normalisation). Untrusted until
   * parsed; never log it.
   */
  body: string;
  receivedAt: Date;
  /**
   * When Twilio's own record says the message came in (`date_created`). Only
   * a reply written after a text went out can answer it, however late its
   * webhook arrives.
   */
  writtenAt?: Date;
  /**
   * `STOP`, `START` or `HELP` when Twilio matched one of its opt-out, opt-in or
   * help keywords. Twilio has already replied, so Hotline does not.
   */
  optOutType?: string;
}

export interface TwilioSmsRouteOptions {
  /** The `twilio.accountSid` secret; a webhook for another account is refused. */
  accountSid: string;
  /** The `twilio.authToken` secret, the HMAC key. */
  authToken: string;
  /** `config.tunnel.publicUrl`: the origin Twilio posts to. */
  publicUrl: string;
  /** `config.owner.phoneNumber`. */
  ownerNumber: string;
  /** `config.sms.fromNumber`: the Twilio number the owner texts. */
  smsNumber: string;
  clock: () => Date;
  /**
   * Applied to a reply before it goes back to Twilio, such as the daemon's
   * redactor. Required: nothing reaches Twilio unredacted.
   */
  redact: (text: string) => string;
  /**
   * A text from the owner that Twilio's record confirms. A returned string is
   * redacted and sent back as the reply in the HTTP response, so it must be a
   * short acknowledgement, never the status of the owner's sessions (that
   * goes out as a text to the owner's number instead). One that is
   * empty after redaction or longer than one message is dropped, and the
   * owner gets no reply.
   */
  onOwnerMessage: (message: OwnerSms) => string | undefined | Promise<string | undefined>;
  /** A text from any other number that Twilio's record confirms. It never reaches `onOwnerMessage`. */
  onOtherSender?: (messageSid: string) => void;
  /**
   * Fetches the message from Twilio by SID: the SMS provider's `fetchMessage`.
   * Rejects with `PullError`. Required: no text has any effect without it.
   */
  lookup: (messageSid: string) => Promise<PulledMessage>;
  /**
   * A signed text, the owner's (`owner`) or another number's (`other`), that
   * Twilio's records do not confirm. It has no effect at all.
   */
  onUnverified?: (messageSid: string, failure: Unverified, sender: "owner" | "other") => void | Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function twiml(reply: FastifyReply, message: string | undefined) {
  const inner = message === undefined ? "" : `<Message>${escapeXml(message)}</Message>`;
  return reply
    .code(200)
    .header("content-type", "text/xml; charset=utf-8")
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formParams(request: FastifyRequest): FormParams | undefined {
  return Array.isArray(request.body) ? (request.body as FormParams) : undefined;
}

export function twilioSmsRoute(options: TwilioSmsRouteOptions): WebhookRoute {
  const origin = new URL(options.publicUrl).origin;
  /** SIDs whose handler succeeded, oldest first. */
  const handled = new Set<string>();
  /** SIDs being handled now, settling when that attempt ends either way. */
  const inFlight = new Map<string, Promise<void>>();
  let otherSenderReplies: number[] = [];

  const markHandled = (messageSid: string) => {
    handled.add(messageSid);
    if (handled.size > SEEN_MESSAGES) handled.delete(handled.values().next().value as string);
  };

  /** The reply as it may leave the machine, or nothing. */
  const ownerReply = (request: FastifyRequest, messageSid: string, text: string | undefined) => {
    if (text === undefined) return undefined;
    try {
      return prepareSmsText(text, options.redact);
    } catch {
      request.log.warn({ messageSid }, "sms reply dropped: empty or too long after redaction");
      return undefined;
    }
  };

  const mayReplyToOtherSender = (now: number): boolean => {
    otherSenderReplies = otherSenderReplies.filter((at) => now - at < HOUR_MS && at <= now);
    if (otherSenderReplies.length >= OTHER_SENDER_REPLIES_PER_HOUR) return false;
    otherSenderReplies.push(now);
    return true;
  };

  return {
    method: "POST",
    url: TWILIO_SMS_PATH,
    precheck: (request) =>
      header(request, "x-twilio-signature") !== undefined &&
      (header(request, "content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"),
    verify: (request) => {
      const params = formParams(request);
      if (params === undefined) return false;
      // The exact URL Twilio requested: our public origin plus the raw path and query.
      const url = `${origin}${request.url}`;
      if (!validTwilioSignature(options.authToken, url, params, header(request, "x-twilio-signature"))) {
        return false;
      }
      return params.some(([name, value]) => name === "AccountSid" && value === options.accountSid);
    },
    handler: async (request, reply) => {
      const params = new Map(formParams(request) ?? []);
      const messageSid = params.get("MessageSid") ?? "";
      if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(messageSid)) {
        request.log.warn("sms webhook without a valid message SID");
        return twiml(reply, undefined);
      }
      // Wait out an attempt already in progress; if it failed, this one handles the message.
      let pending = inFlight.get(messageSid);
      while (pending !== undefined) {
        await pending;
        pending = inFlight.get(messageSid);
      }
      if (handled.has(messageSid)) {
        request.log.info({ messageSid }, "duplicate sms ignored");
        return twiml(reply, undefined);
      }
      // No await between the checks above and this claim, so only one attempt runs at a time.
      let settle = () => {};
      inFlight.set(
        messageSid,
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      try {
        const outcome = await handle(request, params, messageSid);
        // A text Twilio did not confirm stays unhandled: a genuine delivery of
        // that SID, if one ever comes, is pulled and checked afresh.
        if (outcome.handled) markHandled(messageSid);
        return twiml(reply, outcome.text);
      } finally {
        inFlight.delete(messageSid);
        settle();
      }
    },
  };

  /** Twilio's record when it confirms the text the webhook describes, or why it does not. */
  async function confirmed(
    messageSid: string,
    expected: Omit<ExpectedSms, "messageSid">,
  ): Promise<{ pulled: PulledMessage & { body: string } } | { failure: Unverified }> {
    let pulled: PulledMessage;
    try {
      pulled = await options.lookup(messageSid);
    } catch (error) {
      return { failure: pullFailure(error) };
    }
    const reason = smsMismatch(pulled, { messageSid, ...expected });
    if (reason !== undefined || pulled.body === null) {
      return { failure: { forgery: true, reason: reason ?? "the message text differs from the provider's" } };
    }
    return { pulled: { ...pulled, body: pulled.body } };
  }

  /**
   * Handles one verified message: the TwiML reply text, if any, and whether the
   * SID now counts as handled. Throws to leave it unhandled.
   */
  async function handle(
    request: FastifyRequest,
    params: Map<string, string>,
    messageSid: string,
  ): Promise<{ text: string | undefined; handled: boolean }> {
    const receivedAt = options.clock();
    const optOutType = params.get("OptOutType") || undefined;
    const from = params.get("From") ?? "";
    const to = params.get("To") ?? "";
    // Strict E.164 on both sides: a number variant never collides with the owner's.
    const fromOwner = sameE164(from, options.ownerNumber) && sameE164(to, options.smsNumber);
    const sender = fromOwner ? "owner" : "other";
    request.log.info({ messageSid, sender }, "sms received");

    // Every path, the owner's commands, opt-out keywords and free text and any
    // other sender alike, is pulled before it has any effect (HL-13c): a
    // forged webhook must not place a call, spend the generic-reply budget or
    // get a reply.
    const check = await confirmed(messageSid, {
      body: params.get("Body") ?? "",
      fromNumber: fromOwner ? options.ownerNumber : from,
      toNumber: fromOwner ? options.smsNumber : to,
      fromOwner,
      receivedAt,
    });
    if ("failure" in check) {
      const { failure } = check;
      request.log.warn(
        { messageSid, sender, forgery: failure.forgery },
        "sms not confirmed by twilio; ignored",
      );
      try {
        await options.onUnverified?.(messageSid, failure, sender);
      } catch (error) {
        request.log.error({ err: error, messageSid }, "could not report an unconfirmed sms");
      }
      // Bare empty TwiML: the response goes to whoever posted the webhook.
      return { text: undefined, handled: false };
    }

    if (!fromOwner) {
      options.onOtherSender?.(messageSid);
      const answer = optOutType === undefined && mayReplyToOtherSender(receivedAt.getTime());
      return { text: answer ? GENERIC_SMS_REPLY : undefined, handled: true };
    }
    const response = await options.onOwnerMessage({
      messageSid,
      body: check.pulled.body,
      receivedAt,
      ...(check.pulled.dateCreated === undefined ? {} : { writtenAt: check.pulled.dateCreated }),
      ...(optOutType === undefined ? {} : { optOutType }),
    });
    return {
      text: optOutType === undefined ? ownerReply(request, messageSid, response) : undefined,
      handled: true,
    };
  }
}
