// Twilio Programmable Messaging: one form-encoded POST to the Messages resource.
// https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
//
// A small hand-written REST call rather than the `twilio` package: Hotline only
// sends one kind of request, and the HTTP layer stays injectable so tests never
// reach the network.
import { PullError, pullJson } from "./pull.js";
import {
  type PulledMessage,
  prepareSmsText,
  requirePhoneNumber,
  type SentSms,
  type SmsProvider,
  SmsSendError,
} from "./sms.js";

export const TWILIO_API_ORIGIN = "https://api.twilio.com";

/**
 * The subset of `fetch` the clients use: a POST with a body, or a GET without
 * one (HL-13a's pulls). Production passes `globalThis.fetch`; tests a fake.
 */
export type HttpFetch = (
  url: string,
  init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string; signal: AbortSignal },
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

  #authorization(): string {
    const { accountSid, authToken } = this.#options;
    return `Basic ${Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64")}`;
  }

  /**
   * Fetches one message of this account by SID (HL-13a).
   * https://www.twilio.com/docs/messaging/api/message-resource#fetch-a-message-resource
   * Rejects with `PullError`: `not-found` for a SID Twilio does not know.
   */
  async fetchMessage(messageSid: string): Promise<PulledMessage> {
    const { accountSid, fetch, timeoutMs } = this.#options;
    if (!MESSAGE_SID.test(messageSid)) throw new PullError("The message SID is malformed", "malformed");
    const url = `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`;
    const body = await pullJson(
      fetch,
      url,
      { authorization: this.#authorization() },
      timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS,
      "Twilio",
    );
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
    const sid = text("sid");
    const direction = text("direction");
    const status = text("status");
    // Only the message asked for, in this account: anything else is not a lookup result.
    if (sid !== messageSid || direction === null || status === null || text("account_sid") !== accountSid) {
      throw new PullError("Twilio's answer is not the message asked for", "malformed");
    }
    const created = Date.parse(text("date_created") ?? "");
    return {
      sid,
      direction,
      from: text("from"),
      to: text("to"),
      body: text("body"),
      status,
      ...(Number.isNaN(created) ? {} : { dateCreated: new Date(created) }),
    };
  }

  async sendToOwner(text: string): Promise<SentSms> {
    const { accountSid, fromNumber, ownerNumber, redact, fetch, timeoutMs } = this.#options;
    const body = prepareSmsText(text, redact);
    const url = `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${accountSid}/Messages.json`;
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: this.#authorization(),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ To: ownerNumber, From: fromNumber, Body: body }).toString(),
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS),
      });
    } catch (error) {
      // Only the system error code (such as ECONNREFUSED), never the original error:
      // its message or cause can name the request URL, which holds the account SID.
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
      const reason =
        typeof cause?.code === "string" && /^[A-Z_]{1,40}$/.test(cause.code) ? ` (${cause.code})` : "";
      throw new SmsSendError(`Could not reach Twilio${reason}`);
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
