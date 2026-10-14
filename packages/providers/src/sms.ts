// What every SMS provider offers the daemon. A provider is bound to the owner's
// number when it is created, and `sendToOwner` takes no recipient, so no caller
// can text anyone else.
import { PhoneNumber, type SmsProviderName } from "@hotline/core";

/** Twilio's limit for one message body. https://www.twilio.com/docs/messaging/api/message-resource */
export const MAX_SMS_LENGTH = 1600;

export interface SentSms {
  /** The provider's id for the message: a Twilio message SID (`SM` + 32 hex digits). */
  messageId: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  /**
   * Texts the owner. The text is redacted before it leaves the machine. Rejects
   * with `SmsSendError` when the provider refuses or cannot be reached.
   */
  sendToOwner(text: string): Promise<SentSms>;
}

/** A failed send. The message never quotes the provider's response, which can echo numbers. */
export class SmsSendError extends Error {
  override readonly name = "SmsSendError";
  constructor(
    message: string,
    /** HTTP status of the provider's response, when there was one. */
    readonly status?: number,
    /** The provider's numeric error code, such as Twilio's 21610 (recipient opted out). */
    readonly code?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Validates an E.164 number, throwing a message that does not quote it. */
/**
 * Whether `candidate` is exactly `expected`, both valid E.164 numbers. Nothing
 * is normalised or stripped, so a variant such as "+1 555 555 0100" or
 * "15555550100" never matches, and a malformed number on either side fails.
 */
export function sameE164(candidate: string | null | undefined, expected: string): boolean {
  return (
    typeof candidate === "string" &&
    PhoneNumber.safeParse(candidate).success &&
    PhoneNumber.safeParse(expected).success &&
    candidate === expected
  );
}

export function requirePhoneNumber(value: string, what: string): string {
  if (!PhoneNumber.safeParse(value).success) throw new TypeError(`${what} must be an E.164 phone number`);
  return value;
}

/** Redacts `text` and checks it can be sent as one message. */
export function prepareSmsText(text: string, redact: (text: string) => string): string {
  const redacted = redact(text);
  if (redacted.trim().length === 0) throw new SmsSendError("The text to send is empty");
  if (redacted.length > MAX_SMS_LENGTH) {
    throw new SmsSendError(`The text to send is longer than ${MAX_SMS_LENGTH} characters`);
  }
  return redacted;
}
