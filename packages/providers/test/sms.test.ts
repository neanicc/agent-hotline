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
  init: Parameters<HttpFetch>[1] & { body: string };
}

/** A fake HTTP layer: records each request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown, calls: Captured[] = []): HttpFetch {
  return async (url, init) => {
    calls.push({ url, init: { ...init, body: init.body ?? "" } });
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
    // `fetchMessage` only reads one message back (HL-13a); it never sends.
    expect(Object.getOwnPropertyNames(TwilioSmsProvider.prototype).sort()).toEqual([
      "constructor",
      "fetchMessage",
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

  it("keeps Twilio's message log: what it sent and received can be fetched back, nothing else", async () => {
    const at = new Date("2026-10-13T22:00:00.000Z");
    const fake = new FakeSmsProvider({ ownerNumber: OWNER, hotlineNumber: TWILIO_NUMBER, clock: () => at });
    const { messageId } = await fake.sendToOwner("Reply YES 482913");
    const reply = fake.receive("yes 482913");
    expect(reply).toEqual({
      messageSid: expect.stringMatching(/^SM[0-9a-f]{32}$/),
      from: OWNER,
      to: TWILIO_NUMBER,
      body: "yes 482913",
      receivedAt: at,
    });
    expect(reply.messageSid).not.toBe(messageId);
    await expect(fake.fetchMessage(reply.messageSid)).resolves.toEqual({
      sid: reply.messageSid,
      direction: "inbound",
      from: OWNER,
      to: TWILIO_NUMBER,
      body: "yes 482913",
      status: "received",
      dateCreated: at,
    });
    await expect(fake.fetchMessage(messageId)).resolves.toMatchObject({
      direction: "outbound-api",
      from: TWILIO_NUMBER,
      to: OWNER,
    });
    // A SID it never saw, as in a forged webhook.
    await expect(fake.fetchMessage(`SM${"e".repeat(32)}`)).rejects.toMatchObject({
      name: "PullError",
      reason: "not-found",
    });
    // Receiving a known SID again (a retry) keeps Twilio's first record.
    expect(fake.receive("no", { messageSid: reply.messageSid })).toBe(reply);
    expect((await fake.fetchMessage(reply.messageSid)).body).toBe("yes 482913");
    fake.failNextFetch();
    await expect(fake.fetchMessage(reply.messageSid)).rejects.toMatchObject({ reason: "unreachable" });
  });
});

describe("TwilioSmsProvider.fetchMessage", () => {
  const SID = `SM${"ab".repeat(16)}`;
  const record = {
    account_sid: ACCOUNT_SID,
    api_version: "2010-04-01",
    body: "yes 482913",
    date_created: "Tue, 13 Oct 2026 22:00:00 +0000",
    direction: "inbound",
    from: OWNER,
    sid: SID,
    status: "received",
    to: TWILIO_NUMBER,
  };

  it("GETs the message by SID with the account's credentials", async () => {
    const calls: Captured[] = [];
    const provider = twilio({ fetch: fakeFetch(200, record, calls) });
    await expect(provider.fetchMessage(SID)).resolves.toEqual({
      sid: SID,
      direction: "inbound",
      from: OWNER,
      to: TWILIO_NUMBER,
      body: "yes 482913",
      status: "received",
      dateCreated: new Date("2026-10-13T22:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${SID}.json`,
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBe("");
    expect(calls[0]?.init.headers.authorization).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
    );
  });

  it.each([
    [
      "a 404",
      fakeFetch(404, { code: 20404, message: `The requested resource ${OWNER} was not found` }),
      "not-found",
    ],
    ["a 401", fakeFetch(401, { code: 20003 }), "refused"],
    ["another message", fakeFetch(200, { ...record, sid: `SM${"cd".repeat(16)}` }), "malformed"],
    [
      "another account's message",
      fakeFetch(200, { ...record, account_sid: `AC${"f".repeat(32)}` }),
      "malformed",
    ],
    ["a body that is no message", fakeFetch(200, null), "malformed"],
    ["no JSON", fakeFetch(200, new Error("bad json")), "malformed"],
    [
      "a network failure",
      (async () => {
        throw Object.assign(new Error(`fetch failed for ${ACCOUNT_SID}`), {
          cause: { code: "ECONNREFUSED" },
        });
      }) as HttpFetch,
      "unreachable",
    ],
  ])("rejects with a PullError on %s, quoting nothing from the answer", async (_name, fetch, reason) => {
    const error = await twilio({ fetch })
      .fetchMessage(SID)
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ name: "PullError", reason });
    expect(String((error as Error).message)).not.toContain(OWNER);
    expect(String((error as Error).message)).not.toContain(ACCOUNT_SID);
  });

  it("never requests a malformed SID", async () => {
    const calls: Captured[] = [];
    const provider = twilio({ fetch: fakeFetch(200, record, calls) });
    await expect(provider.fetchMessage("SM../../Calls")).rejects.toMatchObject({ reason: "malformed" });
    expect(calls).toEqual([]);
  });
});
