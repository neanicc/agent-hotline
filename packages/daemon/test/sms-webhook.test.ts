import { type FormParams, twilioSignature } from "@hotline/providers";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookServer,
  createRedactor,
  GENERIC_SMS_REPLY,
  type LogOptions,
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

let lines: string[];
let log: LogOptions;
let now: Date;
let received: OwnerSms[];
let others: string[];
let ownerReply: string | undefined;
let app: FastifyInstance;
let sidCounter = 0;

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
        onOwnerMessage: (message) => {
          received.push(message);
          return ownerReply;
        },
        onOtherSender: (messageSid) => others.push(messageSid),
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
}

function post({
  params = message(),
  body,
  url = PATH,
  signedUrl,
  token = AUTH_TOKEN,
  signature,
  contentType = "application/x-www-form-urlencoded",
}: PostOptions = {}) {
  const headers: Record<string, string> = { "content-type": contentType };
  const sig =
    signature === undefined ? twilioSignature(token, signedUrl ?? `${PUBLIC_URL}${url}`, params) : signature;
  if (sig !== null) headers["x-twilio-signature"] = sig;
  return app.inject({ method: "POST", url, headers, payload: body ?? encode(params) });
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
      { messageSid: new Map(params).get("MessageSid"), body: "  Use SQLite & ship <it> ", receivedAt: now },
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
