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
//   and a few per hour at most, so a stranger cannot run up the bill.
//
// Bodies, numbers and message text are never logged; only the message SID and
// whether the sender was the owner.
import { type FormParams, validTwilioSignature } from "@hotline/providers";
import type { FastifyReply, FastifyRequest } from "fastify";
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
  /** The text, verbatim. Untrusted until parsed; never log it. */
  body: string;
  receivedAt: Date;
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
  /** A verified text from the owner. A returned string is sent back as the reply. */
  onOwnerMessage: (message: OwnerSms) => string | undefined | Promise<string | undefined>;
  /** A verified text from any other number. It never reaches `onOwnerMessage`. */
  onOtherSender?: (messageSid: string) => void;
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
  const seen = new Set<string>();
  let otherSenderReplies: number[] = [];

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
      if (seen.has(messageSid)) {
        request.log.info({ messageSid }, "duplicate sms ignored");
        return twiml(reply, undefined);
      }
      seen.add(messageSid);
      if (seen.size > SEEN_MESSAGES) seen.delete(seen.values().next().value as string);

      const receivedAt = options.clock();
      const optOutType = params.get("OptOutType") || undefined;
      const fromOwner = params.get("From") === options.ownerNumber && params.get("To") === options.smsNumber;
      if (!fromOwner) {
        request.log.info({ messageSid, sender: "other" }, "sms received");
        options.onOtherSender?.(messageSid);
        const answer = optOutType === undefined && mayReplyToOtherSender(receivedAt.getTime());
        return twiml(reply, answer ? GENERIC_SMS_REPLY : undefined);
      }

      request.log.info({ messageSid, sender: "owner" }, "sms received");
      let response: string | undefined;
      try {
        response = await options.onOwnerMessage({
          messageSid,
          body: params.get("Body") ?? "",
          receivedAt,
          ...(optOutType === undefined ? {} : { optOutType }),
        });
      } catch (error) {
        // Let a Twilio retry through: the message was not handled.
        seen.delete(messageSid);
        throw error;
      }
      return twiml(reply, optOutType === undefined ? response : undefined);
    },
  };
}
