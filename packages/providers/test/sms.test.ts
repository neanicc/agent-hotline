import { describe, expect, it } from "vitest";
import {
  FakeSmsProvider,
  type HttpFetch,
  MAX_SMS_LENGTH,
  type SmsProvider,
  SmsSendError,
  sameE164,
  type TwilioSmsOptions,
  TwilioSmsProvider,
} from "../src/index.js";

const OWNER = "+15555550100";
const TWILIO_NUMBER = "+15555550101";
const ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const AUTH_TOKEN = "fake-auth-token";
const MESSAGE_SID = `SM${"a1".repeat(16)}`;

interface Captured {
  url: string;
  init: Parameters<HttpFetch>[1];
}

/** A fake HTTP layer: records each request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown, calls: Captured[] = []): HttpFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    };
  };
}

function twilio(overrides: Partial<TwilioSmsOptions> = {}): TwilioSmsProvider {
  return new TwilioSmsProvider({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: TWILIO_NUMBER,
    ownerNumber: OWNER,
    redact: (text) => text.replaceAll("sk_live_secret", "[REDACTED]"),
    fetch: fakeFetch(201, { sid: MESSAGE_SID, status: "queued" }),
    ...overrides,
  });
}

describe("sameE164", () => {
  it("matches only the identical, valid E.164 number, with no normalising", () => {
    const owner = "+15555550100";
    expect(sameE164(owner, owner)).toBe(true);
    for (const variant of [
      "15555550100",
      "+1 555 555 0100",
      "+1-555-555-0100",
      "(555) 555-0100",
      " +15555550100",
      "+15555550100​",
      "＋15555550100",
      undefined,
      null,
      "",
    ]) {
      expect(sameE164(variant, owner), String(variant)).toBe(false);
    }
    // A malformed expected number never matches, not even itself.
    expect(sameE164("15555550100", "15555550100")).toBe(false);
    expect(sameE164("", "")).toBe(false);
  });
});

describe("TwilioSmsProvider", () => {
  it("posts one form-encoded message to the owner from the Twilio number", async () => {
    const calls: Captured[] = [];
    const provider = twilio({ fetch: fakeFetch(201, { sid: MESSAGE_SID, status: "queued" }, calls) });
    await expect(provider.sendToOwner("Claude in demo-app asks: ship it? Reply YES or NO")).resolves.toEqual({
      messageId: MESSAGE_SID,
    });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Captured];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      To: OWNER,
      From: TWILIO_NUMBER,
      Body: "Claude in demo-app asks: ship it? Reply YES or NO",
    });
  });

  it("redacts the text before it leaves the machine", async () => {
    const calls: Captured[] = [];
    await twilio({ fetch: fakeFetch(201, { sid: MESSAGE_SID }, calls) }).sendToOwner(
      "key sk_live_secret leaked",
    );
    expect(calls[0]?.init.body).not.toContain("sk_live_secret");
    expect(new URLSearchParams(calls[0]?.init.body).get("Body")).toBe("key [REDACTED] leaked");
  });

  it("has no way to text anyone but the owner", () => {
    const provider: SmsProvider = twilio();
    expect(provider.sendToOwner.length).toBe(1);
    expect(Object.getOwnPropertyNames(TwilioSmsProvider.prototype).sort()).toEqual([
      "constructor",
      "sendToOwner",
    ]);
  });

  it("refuses empty and oversized texts without calling Twilio", async () => {
    const calls: Captured[] = [];
    const provider = twilio({ fetch: fakeFetch(201, { sid: MESSAGE_SID }, calls) });
    await expect(provider.sendToOwner("   ")).rejects.toThrow(SmsSendError);
    await expect(provider.sendToOwner("x".repeat(MAX_SMS_LENGTH + 1))).rejects.toThrow(/longer than 1600/);
    await expect(provider.sendToOwner("x".repeat(MAX_SMS_LENGTH))).resolves.toEqual({
      messageId: MESSAGE_SID,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports Twilio's error code without quoting its message", async () => {
    const provider = twilio({
      fetch: fakeFetch(400, {
        code: 21610,
        message: `Attempt to send to unsubscribed recipient ${OWNER}`,
        more_info: "https://www.twilio.com/docs/errors/21610",
        status: 400,
      }),
    });
    const error = await provider.sendToOwner("hello").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmsSendError);
    expect(error).toMatchObject({ status: 400, code: 21610 });
    expect((error as Error).message).toBe("Twilio refused the message (HTTP 400, error 21610)");
    expect((error as Error).message).not.toContain("5550100");
  });

  it("fails on a network error, an unreadable response or a missing SID", async () => {
    const offline: HttpFetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(twilio({ fetch: offline }).sendToOwner("hi")).rejects.toThrow("Could not reach Twilio");
    // Node's fetch error names the URL (with the account SID) in its cause: keep only the code.
    const refused: HttpFetch = async (url) => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" }),
      });
    };
    const error = (await twilio({ fetch: refused })
      .sendToOwner("hi")
      .catch((caught: unknown) => caught)) as SmsSendError;
    expect(error.message).toBe("Could not reach Twilio (ECONNREFUSED)");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(ACCOUNT_SID);
    await expect(
      twilio({ fetch: fakeFetch(500, new SyntaxError("bad json")) }).sendToOwner("hi"),
    ).rejects.toThrow("Twilio refused the message (HTTP 500)");
    await expect(twilio({ fetch: fakeFetch(201, { sid: "not-a-sid" }) }).sendToOwner("hi")).rejects.toThrow(
      /message SID/,
    );
    await expect(twilio({ fetch: fakeFetch(201, null) }).sendToOwner("hi")).rejects.toThrow(/message SID/);
  });

  it.each([
    ["a malformed account SID", { accountSid: "AC123" }],
    ["an empty auth token", { authToken: "" }],
    ["a malformed owner number", { ownerNumber: "5555550100" }],
    ["a malformed Twilio number", { fromNumber: "+1 555 555 0101" }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => twilio(overrides)).toThrow(TypeError);
  });
});

describe("FakeSmsProvider", () => {
  it("records texts to the owner with Twilio-shaped SIDs", async () => {
    const fake = new FakeSmsProvider({ ownerNumber: OWNER });
    const first = await fake.sendToOwner("one");
    const second = await fake.sendToOwner("two");
    expect(first.messageId).toMatch(/^SM[0-9a-f]{32}$/);
    expect(second.messageId).not.toBe(first.messageId);
    expect(fake.sent).toEqual([
      { to: OWNER, text: "one", messageId: first.messageId },
      { to: OWNER, text: "two", messageId: second.messageId },
    ]);
  });

  it("applies the same redaction and length rules as the real provider", async () => {
    const fake = new FakeSmsProvider({
      ownerNumber: OWNER,
      redact: (text) => text.replace("hunter2", "***"),
    });
    await fake.sendToOwner("pw hunter2");
    expect(fake.sent[0]?.text).toBe("pw ***");
    await expect(fake.sendToOwner("")).rejects.toThrow(SmsSendError);
    await expect(fake.sendToOwner("x".repeat(MAX_SMS_LENGTH + 1))).rejects.toThrow(SmsSendError);
  });

  it("fails on demand, once", async () => {
    const fake = new FakeSmsProvider({ ownerNumber: OWNER });
    fake.failNext();
    await expect(fake.sendToOwner("hi")).rejects.toMatchObject({ code: 21610 });
    await expect(fake.sendToOwner("hi")).resolves.toHaveProperty("messageId");
    expect(fake.sent).toHaveLength(1);
  });

  it("refuses a malformed owner number", () => {
    expect(() => new FakeSmsProvider({ ownerNumber: "owner" })).toThrow(TypeError);
  });
});
