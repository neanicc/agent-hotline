// Twilio Programmable Messaging: one form-encoded POST to the Messages resource.
// https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
//
// A small hand-written REST call rather than the `twilio` package: Hotline only
// sends one kind of request, and the HTTP layer stays injectable so tests never
// reach the network.
import { prepareSmsText, requirePhoneNumber, type SentSms, type SmsProvider, SmsSendError } from "./sms.js";

export const TWILIO_API_ORIGIN = "https://api.twilio.com";

/** The subset of `fetch` the client uses. Production passes `globalThis.fetch`; tests a fake. */
export type HttpFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TwilioSmsOptions {
  /** `AC` followed by 32 hex digits. */
  accountSid: string;
  authToken: string;
  /** The Twilio number texts come from. */
  fromNumber: string;
  /** The only number this provider will ever text. */
  ownerNumber: string;
  /** Applied to every text before it is sent, such as the daemon's redactor. */
  redact: (text: string) => string;
  /** Required, so nothing can reach the real API by accident. */
  fetch: HttpFetch;
  timeoutMs?: number;
}

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
export const DEFAULT_TWILIO_TIMEOUT_MS = 10_000;

function errorCode(body: unknown): number | undefined {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  readonly #options: TwilioSmsOptions;

  constructor(options: TwilioSmsOptions) {
    if (!ACCOUNT_SID.test(options.accountSid)) throw new TypeError("The Twilio account SID is malformed");
    if (options.authToken.length === 0) throw new TypeError("The Twilio auth token is empty");
    requirePhoneNumber(options.fromNumber, "The Twilio number");
    requirePhoneNumber(options.ownerNumber, "The owner's number");
    this.#options = options;
  }

  async sendToOwner(text: string): Promise<SentSms> {
    const { accountSid, authToken, fromNumber, ownerNumber, redact, fetch, timeoutMs } = this.#options;
    const body = prepareSmsText(text, redact);
    const url = `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${accountSid}/Messages.json`;
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ To: ownerNumber, From: fromNumber, Body: body }).toString(),
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SmsSendError("Could not reach Twilio", undefined, undefined, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      const code = errorCode(parsed);
      // Never Twilio's message text: it can quote the numbers involved.
      throw new SmsSendError(
        `Twilio refused the message (HTTP ${response.status}${code === undefined ? "" : `, error ${code}`})`,
        response.status,
        code,
      );
    }
    const sid = (parsed as { sid?: unknown } | null | undefined)?.sid;
    if (typeof sid !== "string" || !MESSAGE_SID.test(sid)) {
      throw new SmsSendError("Twilio's response did not include a message SID", response.status);
    }
    return { messageId: sid };
  }
}
