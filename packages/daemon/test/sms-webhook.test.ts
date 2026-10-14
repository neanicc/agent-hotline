import {
  type FormParams,
  MAX_SMS_LENGTH,
  PullError,
  type PulledMessage,
  twilioSignature,
} from "@hotline/providers";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookServer,
  createRedactor,
  GENERIC_SMS_REPLY,
  type LogOptions,
  OTHER_SENDER_LOOKUPS_IN_FLIGHT,
  OTHER_SENDER_LOOKUPS_PER_HOUR,
  OTHER_SENDER_REPLIES_PER_HOUR,
  type OwnerSms,
  parseFormBody,
  type TwilioSmsRouteOptions,
  twilioSmsRoute,
} from "../src/index.js";

const OWNER = "+15555550100";
const SMS_NUMBER = "+15555550101";
const STRANGER = "+15555550199";
const ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const AUTH_TOKEN = "fake-twilio-auth-token-for-tests";
const PUBLIC_URL = "https://hotline.example.test";
const PATH = "/hooks/twilio/sms";
/** Empty TwiML: what a text Twilio does not confirm gets, whatever it says and whoever it claims to be from. */
const BARE = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

let lines: string[];
let log: LogOptions;
let now: Date;
let received: OwnerSms[];
let others: string[];
let ownerReply: string | undefined;
let app: FastifyInstance;
let redactor: ReturnType<typeof createRedactor>;
let sidCounter = 0;
/**
 * Twilio's message log, as the route's lookup sees it (HL-13a). `post` adds
 * the message it delivers, as Twilio would have it, unless told it does not exist.
 */
let twilioLog: Map<string, PulledMessage>;
let unverified: { messageSid: string; forgery: boolean; reason: string }[];
/** Who each unconfirmed text claimed to be from, in order. */
let unverifiedSenders: string[];
/** Every SID the route looked up at Twilio, in order. */
let lookups: string[];

function sid(): string {
  sidCounter += 1;
  return `SM${sidCounter.toString(16).padStart(32, "0")}`;
}

function server(overrides: Partial<TwilioSmsRouteOptions> = {}): FastifyInstance {
  return buildWebhookServer({
    log,
    routes: [
      twilioSmsRoute({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        publicUrl: PUBLIC_URL,
        ownerNumber: OWNER,
        smsNumber: SMS_NUMBER,
        clock: () => now,
        redact: (text) => redactor.text(text),
        onOwnerMessage: (message) => {
          received.push(message);
          return ownerReply;
        },
        onOtherSender: (messageSid) => others.push(messageSid),
        lookup: async (messageSid) => {
          lookups.push(messageSid);
          const message = twilioLog.get(messageSid);
          if (message === undefined)
            throw new PullError("Twilio has no such record (HTTP 404)", "not-found", 404);
          return { ...message };
        },
        onUnverified: (messageSid, failure, sender) => {
          unverified.push({ messageSid, ...failure });
          unverifiedSenders.push(sender);
        },
        ...overrides,
      }),
    ],
  });
}

beforeEach(() => {
  lines = [];
  log = { level: "info", destination: { write: (line) => lines.push(line) }, redactor: createRedactor() };
  now = new Date("2026-10-13T22:00:00.000Z");
  received = [];
  others = [];
  ownerReply = undefined;
  twilioLog = new Map();
  unverified = [];
  unverifiedSenders = [];
  lookups = [];
  redactor = createRedactor([AUTH_TOKEN]);
  app = server();
});

afterEach(async () => {
  await app.close();
});

/** Twilio's incoming-message parameters (https://www.twilio.com/docs/messaging/guides/webhook-request). */
function message(overrides: Record<string, string> = {}): FormParams {
  return Object.entries({
    ToCountry: "US",
    SmsMessageSid: overrides.MessageSid ?? "",
    NumMedia: "0",
    SmsSid: overrides.MessageSid ?? "",
    SmsStatus: "received",
    Body: "yes",
    To: SMS_NUMBER,
    NumSegments: "1",
    MessageSid: sid(),
    AccountSid: ACCOUNT_SID,
    From: OWNER,
    ApiVersion: "2010-04-01",
    ...overrides,
  });
}

function encode(params: FormParams): string {
  return params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
}

interface PostOptions {
  params?: FormParams;
  body?: string;
  url?: string;
  signedUrl?: string;
  token?: string;
  signature?: string | null;
  contentType?: string;
  /** The message does not exist at Twilio: a forged webhook. */
  unknownAtTwilio?: boolean;
}

/** Adds the message `params` describe to Twilio's log, received now, unless one with its SID is there. */
function recordAtTwilio(params: FormParams): void {
  const get = (name: string) => params.find(([key]) => key === name)?.[1];
  const sid = get("MessageSid");
  if (sid === undefined || twilioLog.has(sid)) return;
  twilioLog.set(sid, {
    sid,
    direction: "inbound",
    from: get("From") ?? null,
    to: get("To") ?? null,
    body: get("Body") ?? null,
    status: "received",
    dateCreated: now,
  });
}

function post({
  params = message(),
  body,
  url = PATH,
  signedUrl,
  token = AUTH_TOKEN,
  signature,
  contentType = "application/x-www-form-urlencoded",
  unknownAtTwilio = false,
}: PostOptions = {}) {
  if (!unknownAtTwilio) recordAtTwilio(params);
  const headers: Record<string, string> = { "content-type": contentType };
  const sig =
    signature === undefined ? twilioSignature(token, signedUrl ?? `${PUBLIC_URL}${url}`, params) : signature;
  if (sig !== null) headers["x-twilio-signature"] = sig;
  return app.inject({ method: "POST", url, headers, payload: body ?? encode(params) });
}

/** Lets pending I/O and promise callbacks run. */
async function ticks(count = 20) {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}

const rejections = () =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.msg === "rejected webhook");

function expectBare403(response: { statusCode: number; body: string }) {
  expect(response.statusCode).toBe(403);
  expect(response.body).toBe("");
}

describe("POST /hooks/twilio/sms", () => {
  it("hands a verified text from the owner to the handler, verbatim", async () => {
    const params = message({ Body: "  Use SQLite & ship <it> " });
    const response = await post({ params });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/xml/);
    expect(response.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(received).toEqual([
      {
        messageSid: new Map(params).get("MessageSid"),
        body: "  Use SQLite & ship <it> ",
        receivedAt: now,
        writtenAt: now,
      },
    ]);
    expect(others).toEqual([]);
  });

  it("sends the handler's reply back as escaped TwiML", async () => {
    ownerReply = `Approved <"Bash"> & done`;
    const response = await post();
    expect(response.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Approved &#60;&#34;Bash&#34;&#62; &#38; done</Message></Response>',
    );
  });

  it("redacts the handler's reply before it goes back to Twilio", async () => {
    ownerReply = `Done. token=abc123def456 and ${AUTH_TOKEN} were in the output`;
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<Message>");
    expect(response.body).toContain("[REDACTED]");
    expect(response.body).not.toContain(AUTH_TOKEN);
    expect(response.body).not.toContain("abc123def456");
  });

  it("drops a reply that is empty after redaction or longer than one message", async () => {
    await app.close();
    app = server({ redact: () => "   " });
    ownerReply = "anything";
    const blank = await post();
    expect([blank.statusCode, blank.body]).toEqual([
      200,
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    ]);

    await app.close();
    app = server();
    ownerReply = "x".repeat(MAX_SMS_LENGTH + 1);
    const params = message();
    const long = await post({ params });
    expect(long.statusCode).toBe(200);
    expect(long.body).not.toContain("<Message>");
    // The message itself was handled: a retry is not handled again.
    await post({ params });
    expect(received).toHaveLength(2);
    expect(lines.join("")).not.toContain("xxxxxxxx");
  });

  it("verifies the exact public URL, including the query string", async () => {
    expect((await post({ url: `${PATH}?attempt=1` })).statusCode).toBe(200);
    // Signed for a different query, path, origin or scheme: refused.
    expectBare403(await post({ url: `${PATH}?attempt=2`, signedUrl: `${PUBLIC_URL}${PATH}?attempt=1` }));
    expectBare403(await post({ signedUrl: `${PUBLIC_URL}/hooks/twilio/other` }));
    expectBare403(await post({ signedUrl: `https://attacker.example.test${PATH}` }));
    expectBare403(await post({ signedUrl: `http://hotline.example.test${PATH}` }));
    expect(received).toHaveLength(1);
  });

  it("refuses a wrong signature, a wrong auth token and another account", async () => {
    expectBare403(await post({ signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=" }));
    expectBare403(await post({ token: "another-token" }));
    expectBare403(await post({ params: message({ AccountSid: `AC${"f".repeat(32)}` }) }));
    // A parameter changed after signing.
    const params = message();
    const signature = twilioSignature(AUTH_TOKEN, `${PUBLIC_URL}${PATH}`, params);
    const tampered = params.map(([n, v]) => [n, n === "Body" ? "yes 482913" : v] as [string, string]);
    expectBare403(await post({ params: tampered, signature }));
    // A repeated parameter, even if signed.
    expectBare403(await post({ params: [...message(), ["Body", "no"]] }));
    expect(received).toEqual([]);
    expect(rejections().every((entry) => entry.reason === "verification failed")).toBe(true);
  });

  it("refuses a request without the signature header before reading the body", async () => {
    expectBare403(await post({ signature: null }));
    expectBare403(await post({ signature: "" }));
    // A malformed body without the header is refused by the precheck, not the parser.
    expectBare403(await post({ signature: null, body: "Body=%ZZ" }));
    expect(rejections().map((entry) => entry.reason)).toEqual([
      "precheck failed",
      "precheck failed",
      "precheck failed",
    ]);
    expect(received).toEqual([]);
  });

  it.each([
    ["a bad percent escape", "Body=%ZZ&From=%2B15555550100"],
    ["invalid UTF-8", "Body=%C3%28"],
    ["an empty segment", "Body=yes&&From=x"],
  ])("answers a malformed body (%s) with the same bare 403", async (_name, body) => {
    expectBare403(await post({ body, signature: "c2lnbmF0dXJl" }));
    expect(rejections().at(-1)).toMatchObject({ reason: "unreadable request", path: PATH });
    expect(received).toEqual([]);
  });

  it("answers an oversized body with the same bare 403", async () => {
    expectBare403(await post({ body: `Body=${"x".repeat(300 * 1024)}`, signature: "c2lnbmF0dXJl" }));
    expect(received).toEqual([]);
  });

  it.each(["application/json", "text/plain", "multipart/form-data; boundary=x"])(
    "refuses content type %s before parsing",
    async (contentType) => {
      expectBare403(await post({ contentType, body: '{"Body":"yes"}' }));
      expect(rejections().at(-1)).toMatchObject({ reason: "precheck failed" });
    },
  );

  it("gives every rejection the same response as a path with no route", async () => {
    const responses = [
      await app.inject({ method: "POST", url: "/hooks/twilio/voice" }),
      await post({ signature: null }),
      await post({ signature: "wrong" }),
      await post({ body: "Body=%ZZ", signature: "wrong" }),
      await post({ contentType: "application/json", body: "{" }),
    ];
    for (const response of responses) {
      expect([response.statusCode, response.body, response.headers["content-length"]]).toEqual([
        403,
        "",
        "0",
      ]);
    }
  });

  it("gives any other number one generic reply and never reaches the handler", async () => {
    const params = message({ From: STRANGER, Body: "status" });
    const response = await post({ params });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${GENERIC_SMS_REPLY}</Message></Response>`,
    );
    expect(GENERIC_SMS_REPLY).not.toMatch(/hotline|agent|owner|claude|codex|pin/i);
    expect(received).toEqual([]);
    expect(others).toEqual([new Map(params).get("MessageSid")]);
  });

  it("treats a text to another number on the account as not from the owner", async () => {
    await post({ params: message({ To: "+15555550102" }) });
    expect(received).toEqual([]);
    expect(others).toHaveLength(1);
  });

  it("limits generic replies to other numbers per hour", async () => {
    const replies = async () => {
      const response = await post({ params: message({ From: STRANGER }) });
      return response.body.includes("<Message>");
    };
    for (let i = 0; i < OTHER_SENDER_REPLIES_PER_HOUR; i++) expect(await replies()).toBe(true);
    expect(await replies()).toBe(false);
    now = new Date(now.getTime() + 60 * 60 * 1000);
    expect(await replies()).toBe(true);
    expect(received).toEqual([]);
  });

  it("handles each message SID once", async () => {
    const params = message();
    expect((await post({ params })).statusCode).toBe(200);
    const again = await post({ params });
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain("<Message>");
    expect(received).toHaveLength(1);
  });

  it("lets a retry through when the handler failed", async () => {
    let fail = true;
    await app.close();
    app = server({
      onOwnerMessage: (msg) => {
        if (fail) throw new Error("orchestrator down");
        received.push(msg);
        return undefined;
      },
    });
    const params = message();
    expect((await post({ params })).statusCode).toBe(500);
    fail = false;
    expect((await post({ params })).statusCode).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("makes a retry wait for an attempt in progress, and handles it if that attempt fails", async () => {
    await app.close();
    const attempts: Array<{ resolve: (reply: string | undefined) => void; reject: (error: Error) => void }> =
      [];
    let started = () => {};
    app = server({
      onOwnerMessage: (msg) => {
        received.push(msg);
        started();
        return new Promise((resolve, reject) => attempts.push({ resolve, reject }));
      },
    });
    const params = message();
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = post({ params });
    await firstStarted;
    let retrySettled = false;
    const retry = post({ params }).then((response) => {
      retrySettled = true;
      return response;
    });
    await ticks();
    // The retry neither succeeds early nor runs the handler a second time.
    expect(retrySettled).toBe(false);
    expect(attempts).toHaveLength(1);

    const retryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    attempts[0]?.reject(new Error("orchestrator down"));
    expect((await first).statusCode).toBe(500);
    await retryStarted;
    expect(attempts).toHaveLength(2);
    attempts[1]?.resolve("Got it.");
    const response = await retry;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<Message>Got it.</Message>");
    expect(received).toHaveLength(2);
  });

  it("answers a retry of an attempt in progress after it succeeds, without handling it again", async () => {
    await app.close();
    const attempts: Array<(reply: string | undefined) => void> = [];
    let started = () => {};
    app = server({
      onOwnerMessage: (msg) => {
        received.push(msg);
        started();
        return new Promise((resolve) => attempts.push(resolve));
      },
    });
    const params = message();
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = post({ params });
    await firstStarted;
    const retry = post({ params });
    await ticks();
    attempts[0]?.("Got it.");
    expect((await first).body).toContain("<Message>Got it.</Message>");
    const again = await retry;
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain("<Message>");
    expect(attempts).toHaveLength(1);
    expect(received).toHaveLength(1);
  });

  it("lets a retry through when recording another sender failed", async () => {
    let fail = true;
    await app.close();
    app = server({
      onOtherSender: (messageSid) => {
        if (fail) throw new Error("audit write failed");
        others.push(messageSid);
      },
    });
    const params = message({ From: STRANGER });
    expect((await post({ params })).statusCode).toBe(500);
    fail = false;
    const retry = await post({ params });
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toContain(GENERIC_SMS_REPLY);
    expect(others).toEqual([new Map(params).get("MessageSid")]);
    // Handled now: a further copy is a duplicate.
    expect((await post({ params })).body).not.toContain("<Message>");
    expect(others).toHaveLength(1);
  });

  it("passes Twilio's opt-out type along and does not reply on top of Twilio", async () => {
    ownerReply = "Paused.";
    const response = await post({ params: message({ Body: "STOP", OptOutType: "STOP" }) });
    expect(response.body).not.toContain("<Message>");
    expect(received[0]).toMatchObject({ body: "STOP", optOutType: "STOP" });
    const stranger = await post({ params: message({ From: STRANGER, Body: "STOP", OptOutType: "STOP" }) });
    expect(stranger.body).not.toContain("<Message>");
  });

  it("ignores a verified request without a valid message SID", async () => {
    const response = await post({ params: message({ MessageSid: "nope" }) });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual([]);
  });

  it("never logs bodies, numbers, signatures or the auth token", async () => {
    await post({ params: message({ Body: "approve body-marker" }) });
    await post({ params: message({ From: STRANGER, Body: "stranger body-marker" }) });
    await post({ signature: "signature-marker" });
    await post({ body: "Body=%ZZbody-marker", signature: "signature-marker" });
    const text = lines.join("");
    for (const marker of [
      "body-marker",
      "approve",
      "signature-marker",
      AUTH_TOKEN,
      "5550100",
      "5550199",
      "5550101",
    ]) {
      expect(text).not.toContain(marker);
    }
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.msg === "sms received").map((entry) => entry.sender)).toEqual([
      "owner",
      "other",
    ]);
  });
});

describe("verify by pull (HL-13a)", () => {
  it("never hands on a correctly signed owner's text whose SID Twilio does not have", async () => {
    const params = message({ Body: "yes 482913" });
    const response = await post({ params, unknownAtTwilio: true });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BARE);
    expect(received).toEqual([]);
    const messageSid = params.find(([name]) => name === "MessageSid")?.[1];
    expect(unverified).toEqual([{ messageSid, forgery: true, reason: "the provider has no such record" }]);
  });

  const pulled = (overrides: Partial<PulledMessage>): PulledMessage => ({
    sid: "",
    direction: "inbound",
    from: OWNER,
    to: SMS_NUMBER,
    body: "yes",
    status: "received",
    dateCreated: now,
    ...overrides,
  });

  it.each([
    ["another message", { sid: `SM${"e".repeat(32)}` }, "the provider returned another message"],
    ["an outbound message", { direction: "outbound-api" }, "the message is not inbound"],
    ["a message not received", { status: "failed" }, "the message was not received"],
    ["a message from someone else", { from: STRANGER }, "the message is not from the owner's number"],
    [
      "a message from a variant of the owner's number",
      { from: "15555550100" },
      "the message is not from the owner's number",
    ],
    ["a message to another number", { to: "+15555550102" }, "the message is not to the Hotline number"],
    ["a message with other words", { body: "no" }, "the message text differs from the provider's"],
    ["a message without a time", { dateCreated: undefined }, "the message has no time"],
    [
      "a message from an hour ago",
      { dateCreated: new Date(Date.parse("2026-10-13T21:00:00.000Z")) },
      "the message is not recent",
    ],
    [
      "a message from the future",
      { dateCreated: new Date(Date.parse("2026-10-13T22:06:00.000Z")) },
      "the message is not recent",
    ],
  ] as const)("refuses an owner's text when Twilio has %s", async (_name, overrides, reason) => {
    const params = message({ Body: "yes" });
    const messageSid = params.find(([name]) => name === "MessageSid")?.[1] ?? "";
    twilioLog.set(messageSid, pulled({ sid: messageSid, ...overrides }));
    const response = await post({ params });
    expect(response.body).toBe(BARE);
    expect(received).toEqual([]);
    expect(unverified).toEqual([{ messageSid, forgery: true, reason }]);
  });

  it("refuses a text when Twilio cannot be reached, and handles the retry once it can", async () => {
    let down = true;
    await app.close();
    app = server({
      lookup: async (messageSid) => {
        if (down) throw new PullError("Could not reach Twilio (ECONNREFUSED)", "unreachable");
        return twilioLog.get(messageSid) as PulledMessage;
      },
    });
    const params = message({ Body: "yes" });
    expect((await post({ params })).body).toBe(BARE);
    expect(unverified.map((u) => [u.forgery, u.reason])).toEqual([
      [false, "the provider lookup failed (unreachable)"],
    ]);
    // Not remembered as handled: Twilio's retry of the same SID gets through.
    down = false;
    ownerReply = "Hotline: got it.";
    expect((await post({ params })).body).toContain("Hotline: got it.");
    expect(received).toHaveLength(1);
  });

  it("looks up a text from another number too, before any reply or record (HL-13c)", async () => {
    const params = message({ From: STRANGER });
    const messageSid = new Map(params).get("MessageSid");
    expect((await post({ params })).body).toContain(GENERIC_SMS_REPLY);
    expect(lookups).toEqual([messageSid]);
    expect(others).toEqual([messageSid]);
  });
});

describe("every text path is pulled before any effect (HL-13c)", () => {
  const sidOf = (params: FormParams) => new Map(params).get("MessageSid") ?? "";

  it.each([
    ["status", OWNER, {}],
    ["call me", OWNER, {}],
    ["STOP", OWNER, { OptOutType: "STOP" }],
    ["stop", OWNER, {}],
    ["START", OWNER, { OptOutType: "START" }],
    ["HELP", OWNER, { OptOutType: "HELP" }],
    ["yes 482913", OWNER, {}],
    ["use postgres", OWNER, {}],
    ["status", STRANGER, {}],
    ["STOP", STRANGER, { OptOutType: "STOP" }],
  ] as const)(
    "a forged %j from %s with an unknown SID has no effect and gets bare TwiML",
    async (body, from, extra) => {
      ownerReply = "Hotline: 2 live sessions. Claude in secret-project: deploying.";
      const params = message({ Body: body, From: from, ...extra });
      const response = await post({ params, unknownAtTwilio: true });
      expect([response.statusCode, response.body]).toEqual([200, BARE]);
      // No handler ran: nothing reached call orchestration, nothing was recorded or counted.
      expect(received).toEqual([]);
      expect(others).toEqual([]);
      expect(unverified).toEqual([
        { messageSid: sidOf(params), forgery: true, reason: "the provider has no such record" },
      ]);
      expect(unverifiedSenders).toEqual([from === OWNER ? "owner" : "other"]);
      expect(response.body).not.toContain("secret-project");
    },
  );

  it("keeps the generic-reply limit when lookups finish out of order", async () => {
    await app.close();
    let hold = false;
    const pending: (() => void)[] = [];
    app = server({
      lookup: async (messageSid) => {
        if (hold) await new Promise<void>((resolve) => pending.push(resolve));
        return twilioLog.get(messageSid) as PulledMessage;
      },
    });
    // Two replies spent one after the other, then as many lookups at once as allowed.
    const before = OTHER_SENDER_REPLIES_PER_HOUR + 1 - OTHER_SENDER_LOOKUPS_IN_FLIGHT;
    const bodies: string[] = [];
    for (let i = 0; i < before; i++) {
      bodies.push((await post({ params: message({ From: STRANGER }) })).body);
      now = new Date(now.getTime() + 1000);
    }
    hold = true;
    const responses = [];
    for (let i = 0; i < OTHER_SENDER_LOOKUPS_IN_FLIGHT; i++) {
      responses.push(post({ params: message({ From: STRANGER }) }));
      while (pending.length <= i) await ticks(1);
      now = new Date(now.getTime() + 1000);
    }
    // The newest lookup finishes first, the oldest last.
    for (let i = OTHER_SENDER_LOOKUPS_IN_FLIGHT - 1; i >= 0; i--) {
      pending[i]?.();
      await ticks();
    }
    for (const response of responses) bodies.push((await response).body);
    expect(bodies).toHaveLength(OTHER_SENDER_REPLIES_PER_HOUR + 1);
    expect(bodies.filter((body) => body.includes(GENERIC_SMS_REPLY))).toHaveLength(
      OTHER_SENDER_REPLIES_PER_HOUR,
    );
    expect(others).toHaveLength(OTHER_SENDER_REPLIES_PER_HOUR + 1);
  });

  it("limits lookups for other numbers, never for the owner", async () => {
    await app.close();
    const pending: (() => void)[] = [];
    app = server({
      lookup: async (messageSid) => {
        lookups.push(messageSid);
        await new Promise<void>((resolve) => pending.push(resolve));
        return twilioLog.get(messageSid) as PulledMessage;
      },
    });
    // As many strangers' lookups at once as allowed; one more is not looked up.
    const held = [];
    for (let i = 0; i < OTHER_SENDER_LOOKUPS_IN_FLIGHT; i++) {
      held.push(post({ params: message({ From: STRANGER }) }));
      while (pending.length <= i) await ticks(1);
    }
    const over = await post({ params: message({ From: STRANGER }) });
    expect([over.statusCode, over.body]).toEqual([200, BARE]);
    expect(lookups).toHaveLength(OTHER_SENDER_LOOKUPS_IN_FLIGHT);
    // The owner's text is still looked up and handled.
    ownerReply = "Hotline: got it.";
    const owner = post({ params: message() });
    while (pending.length <= OTHER_SENDER_LOOKUPS_IN_FLIGHT) await ticks(1);
    for (const release of pending) release();
    expect((await owner).body).toContain("Hotline: got it.");
    await Promise.all(held);
    expect(received).toHaveLength(1);
    expect(others).toHaveLength(OTHER_SENDER_LOOKUPS_IN_FLIGHT);
  });

  it(`looks up at most ${OTHER_SENDER_LOOKUPS_PER_HOUR} texts from other numbers an hour`, async () => {
    for (let i = 0; i < OTHER_SENDER_LOOKUPS_PER_HOUR; i++) {
      await post({ params: message({ From: STRANGER }), unknownAtTwilio: true });
    }
    expect(lookups).toHaveLength(OTHER_SENDER_LOOKUPS_PER_HOUR);
    expect((await post({ params: message({ From: STRANGER }) })).body).toBe(BARE);
    expect((await post({ params: message({ From: STRANGER }) })).body).toBe(BARE);
    expect(lookups).toHaveLength(OTHER_SENDER_LOOKUPS_PER_HOUR);
    expect(others).toEqual([]);
    // A flood over the limit is reported once an hour, not per text.
    const overLimit = unverified.filter(
      (u) => u.reason === "texts from other numbers are over the lookup limit",
    );
    expect(overLimit).toEqual([expect.objectContaining({ forgery: false })]);
    // The owner is never limited.
    expect((await post({ params: message() })).statusCode).toBe(200);
    expect(received).toHaveLength(1);
    // An hour later strangers are looked up again.
    now = new Date(now.getTime() + 60 * 60 * 1000);
    expect((await post({ params: message({ From: STRANGER }) })).body).toContain(GENERIC_SMS_REPLY);
  });

  it("gives a lookup slot back when the lookup fails", async () => {
    await app.close();
    app = server({
      lookup: async () => {
        throw new PullError("Could not reach Twilio (ECONNREFUSED)", "unreachable");
      },
    });
    for (let i = 0; i < OTHER_SENDER_LOOKUPS_IN_FLIGHT * 3; i++) {
      expect((await post({ params: message({ From: STRANGER }) })).body).toBe(BARE);
    }
    // Every one was looked up (and failed): no slot was kept by a failed lookup.
    expect(unverified.map((u) => u.reason)).toEqual(
      Array(OTHER_SENDER_LOOKUPS_IN_FLIGHT * 3).fill("the provider lookup failed (unreachable)"),
    );
  });

  it("never lets forged texts from other numbers spend the generic replies", async () => {
    for (let i = 0; i < OTHER_SENDER_REPLIES_PER_HOUR * 2; i++) {
      expect((await post({ params: message({ From: STRANGER }), unknownAtTwilio: true })).body).toBe(BARE);
    }
    expect((await post({ params: message({ From: STRANGER }) })).body).toContain(GENERIC_SMS_REPLY);
    expect(others).toHaveLength(1);
  });

  it.each([
    [
      "the owner's message",
      { From: STRANGER },
      { from: OWNER },
      "the message is not from the sender's number",
    ],
    [
      "another sender's message",
      { From: STRANGER },
      { from: "+15555550198" },
      "the message is not from the sender's number",
    ],
    [
      "a message to another number",
      { From: STRANGER },
      { to: "+15555550102" },
      "the message is not to the number it was sent to",
    ],
    [
      "other words",
      { From: STRANGER, Body: "hi" },
      { body: "bye" },
      "the message text differs from the provider's",
    ],
  ] as const)(
    "refuses another sender's text when Twilio has %s",
    async (_name, overrides, record, reason) => {
      const params = message(overrides);
      const messageSid = sidOf(params);
      const get = (name: string) => params.find(([key]) => key === name)?.[1] ?? null;
      twilioLog.set(messageSid, {
        sid: messageSid,
        direction: "inbound",
        from: get("From"),
        to: get("To"),
        body: get("Body"),
        status: "received",
        dateCreated: now,
        ...record,
      });
      expect((await post({ params })).body).toBe(BARE);
      expect(others).toEqual([]);
      expect(unverified).toEqual([{ messageSid, forgery: true, reason }]);
      expect(unverifiedSenders).toEqual(["other"]);
    },
  );

  it("puts nothing in the response for a reply the handler does not give", async () => {
    // The status is texted by call orchestration; the route just has no reply.
    ownerReply = undefined;
    expect((await post({ params: message({ Body: "status" }) })).body).toBe(BARE);
    expect(received).toHaveLength(1);
  });
});

describe("the body comparison tolerates whitespace and Unicode normalisation only (HL-13c)", () => {
  /** Posts `webhookBody` while Twilio's record has `recordBody`. */
  async function compare(webhookBody: string, recordBody: string | null) {
    const params = message({ Body: webhookBody });
    const messageSid = new Map(params).get("MessageSid") ?? "";
    twilioLog.set(messageSid, {
      sid: messageSid,
      direction: "inbound",
      from: OWNER,
      to: SMS_NUMBER,
      body: recordBody,
      status: "received",
      dateCreated: now,
    });
    return post({ params });
  }

  it.each([
    ["trailing whitespace", "yes 482913 ", "yes 482913"],
    ["leading whitespace and a line break", "\n yes 482913", "yes 482913"],
    ["a run of spaces", "yes   482913", "yes 482913"],
    ["a tab and a CRLF", "yes\t482913\r\n", "yes 482913"],
    ["a no-break space", "yes 482913", "yes 482913"],
    ["a decomposed accent", "café first", "café first"],
    ["a composed accent against a decomposed record", "café first", "café first"],
  ])(
    "accepts a genuine reply that differs by %s, with Twilio's text",
    async (_name, webhookBody, recordBody) => {
      const response = await compare(webhookBody, recordBody);
      expect(response.body).toBe(BARE);
      expect(unverified).toEqual([]);
      expect(received).toHaveLength(1);
      // The handler gets the text as Twilio's own record has it.
      expect(received[0]?.body).toBe(recordBody);
    },
  );

  it.each([
    ["a changed word", "yes deploy now", "yes deploy later"],
    ["a changed digit", "yes 482913", "yes 482914"],
    ["a word run together", "no thanks", "nothanks"],
    ["a compatibility character", "yes ﬁle", "yes file"],
    ["a different case", "Yes", "yes"],
    ["a missing body", "yes", null],
  ])("still refuses %s", async (_name, webhookBody, recordBody) => {
    expect((await compare(webhookBody, recordBody)).body).toBe(BARE);
    expect(received).toEqual([]);
    expect(unverified).toEqual([
      expect.objectContaining({ forgery: true, reason: "the message text differs from the provider's" }),
    ]);
  });
});

describe("parseFormBody", () => {
  it("decodes names and values, keeping order and repeats", () => {
    expect(parseFormBody("From=%2B15555550100&Body=yes+please&Body=again&Flag")).toEqual([
      ["From", "+15555550100"],
      ["Body", "yes please"],
      ["Body", "again"],
      ["Flag", ""],
    ]);
    expect(parseFormBody("")).toEqual([]);
  });

  it.each(["%ZZ=1", "a=%E0%A4%A", "a=1&&b=2", "&", "a=%C3%28"])("throws on %j", (body) => {
    expect(() => parseFormBody(body)).toThrow();
  });
});
