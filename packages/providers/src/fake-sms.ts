// An in-memory SMS provider for tests and the scenario suite. It keeps the same
// rules as the real one (owner only, redaction, length) and records what it sent.
import { prepareSmsText, requirePhoneNumber, type SentSms, type SmsProvider, SmsSendError } from "./sms.js";

export interface FakeSentSms {
  to: string;
  text: string;
  messageId: string;
}

export interface FakeSmsOptions {
  ownerNumber: string;
  redact?: (text: string) => string;
}

export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  /** Every text sent, oldest first. */
  readonly sent: FakeSentSms[] = [];
  readonly #ownerNumber: string;
  readonly #redact: (text: string) => string;
  readonly #failures: Error[] = [];
  #count = 0;

  constructor({ ownerNumber, redact = (text) => text }: FakeSmsOptions) {
    this.#ownerNumber = requirePhoneNumber(ownerNumber, "The owner's number");
    this.#redact = redact;
  }

  /** Makes the next send reject with `error` (default: an opted-out recipient, Twilio 21610). */
  failNext(
    error: Error = new SmsSendError("Twilio refused the message (HTTP 400, error 21610)", 400, 21610),
  ): void {
    this.#failures.push(error);
  }

  async sendToOwner(text: string): Promise<SentSms> {
    const body = prepareSmsText(text, this.#redact);
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.#count += 1;
    const messageId = `SM${this.#count.toString(16).padStart(32, "0")}`;
    this.sent.push({ to: this.#ownerNumber, text: body, messageId });
    return { messageId };
  }
}
