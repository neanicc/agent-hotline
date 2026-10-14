// An in-memory SMS provider for tests and the scenario suite. It keeps the same
// rules as the real one (owner only, redaction, length) and records what it sent.
//
// It also plays Twilio's message log (HL-13a): every text it sent, and every
// text someone sent to the Hotline number through `receive`, can be fetched back
// by SID with `fetchMessage`, as the daemon does before a reply counts. A
// webhook made up without `receive` has no record, like a forged one.
import { PullError } from "./pull.js";
import {
  type PulledMessage,
  prepareSmsText,
  requirePhoneNumber,
  type SentSms,
  type SmsProvider,
  SmsSendError,
} from "./sms.js";

export interface FakeSentSms {
  to: string;
  text: string;
  messageId: string;
}

/** A text someone sent to the Hotline number, as Twilio would have recorded it. */
export interface FakeReceivedSms {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
}

export interface FakeSmsOptions {
  ownerNumber: string;
  /** The Hotline number texts go out from and come in to (default `+15555550101`). */
  hotlineNumber?: string;
  redact?: (text: string) => string;
  /** Stamps each message's `dateCreated` (normally the scenario's fake clock). */
  clock?: () => Date;
}

const hex32 = (n: number) => n.toString(16).padStart(32, "0");

export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  /** Every text sent, oldest first. */
  readonly sent: FakeSentSms[] = [];
  /** Every text received through `receive`, oldest first. */
  readonly received: FakeReceivedSms[] = [];
  readonly #ownerNumber: string;
  readonly #hotlineNumber: string;
  readonly #redact: (text: string) => string;
  readonly #clock: () => Date;
  readonly #failures: Error[] = [];
  readonly #fetchFailures: Error[] = [];
  /** The message log `fetchMessage` reads, by SID. */
  readonly #log = new Map<string, PulledMessage>();
  #count = 0;
  #inboundCount = 0;

  constructor({ ownerNumber, hotlineNumber, redact = (text) => text, clock }: FakeSmsOptions) {
    this.#ownerNumber = requirePhoneNumber(ownerNumber, "The owner's number");
    this.#hotlineNumber = requirePhoneNumber(hotlineNumber ?? "+15555550101", "The Hotline number");
    this.#redact = redact;
    this.#clock = clock ?? (() => new Date());
  }

  /** Makes the next send reject with `error` (default: an opted-out recipient, Twilio 21610). */
  failNext(
    error: Error = new SmsSendError("Twilio refused the message (HTTP 400, error 21610)", 400, 21610),
  ): void {
    this.#failures.push(error);
  }

  /** Makes the next `fetchMessage` reject with `error` (default: Twilio cannot be reached). */
  failNextFetch(error: Error = new PullError("Could not reach Twilio (ECONNREFUSED)", "unreachable")): void {
    this.#fetchFailures.push(error);
  }

  async sendToOwner(text: string): Promise<SentSms> {
    const body = prepareSmsText(text, this.#redact);
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.#count += 1;
    const messageId = `SM${hex32(this.#count)}`;
    this.sent.push({ to: this.#ownerNumber, text: body, messageId });
    this.#log.set(messageId, {
      sid: messageId,
      direction: "outbound-api",
      from: this.#hotlineNumber,
      to: this.#ownerNumber,
      body,
      status: "delivered",
      dateCreated: this.#clock(),
    });
    return { messageId };
  }

  /**
   * Someone (the owner by default) texts `body` to the Hotline number: Twilio
   * records the message, and the returned record is what its webhook carries.
   * `messageSid` names the SID: for one received before (a Twilio retry or a
   * replay), Twilio's record stays as it was and is returned.
   */
  receive(body: string, { from, messageSid }: { from?: string; messageSid?: string } = {}): FakeReceivedSms {
    const earlier = this.received.find((message) => message.messageSid === messageSid);
    if (earlier !== undefined) return earlier;
    let sid = messageSid;
    if (sid === undefined) {
      this.#inboundCount += 1;
      // `SM` and 32 hex digits, starting with `f` so it never collides with a sent message.
      sid = `SMf${hex32(this.#inboundCount).slice(1)}`;
    }
    const message: FakeReceivedSms = {
      messageSid: sid,
      from: from ?? this.#ownerNumber,
      to: this.#hotlineNumber,
      body,
      receivedAt: this.#clock(),
    };
    this.received.push(message);
    this.#log.set(sid, {
      sid,
      direction: "inbound",
      from: message.from,
      to: message.to,
      body,
      status: "received",
      dateCreated: message.receivedAt,
    });
    return message;
  }

  /** Twilio's record of a message this fake sent or received; `not-found` for any other SID. */
  async fetchMessage(messageSid: string): Promise<PulledMessage> {
    const failure = this.#fetchFailures.shift();
    if (failure !== undefined) throw failure;
    const record = this.#log.get(messageSid);
    if (record === undefined) throw new PullError("Twilio has no such record (HTTP 404)", "not-found", 404);
    return { ...record };
  }
}
