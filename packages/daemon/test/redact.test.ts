import { describe, expect, it } from "vitest";
import { createRedactor, MAX_REDACTED_TEXT, REDACTED, redactingStream } from "../src/index.js";

// Obviously fake values only. Each literal is built at runtime so no scanner
// mistakes this file for a leak.
const OWNER = "+15555550100";
const TWILIO_AUTH_TOKEN = "0123456789abcdef".repeat(2);
const TWILIO_ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const ELEVENLABS_KEY = `sk_${"f".repeat(48)}`;
const AWS_KEY_ID = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const DAEMON_TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

const redactor = createRedactor();
const text = (input: string) => redactor.text(input);

describe("phone numbers", () => {
  it.each([
    [`calling ${OWNER} now`, "calling ***0100 now"],
    ["From=%2B15555550100&Body=yes", "From=***0100&Body=yes"],
    ["+1 (555) 555-0100", "***0100"],
    ["+1 555 555 0100", "***0100"],
    ["(555) 555-0100", "***0100"],
    ["555-555-0100", "***0100"],
    ["555.555.0100", "***0100"],
    ["5555550100", "***0100"],
    // UK number from Ofcom's range reserved for fiction (07700 900xxx).
    ["+447700900123", "***0123"],
  ])("masks %s to its last four digits", (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it.each([
    "2026-10-13T21:58:00.000Z",
    "127.0.0.1:7341",
    "version 5.12.5",
    "took 1234 ms",
    "123e4567-e89b-12d3-a456-4266a4174b00",
    `CA${"0a1b2c3d4e5f6a7b".repeat(2)}`,
  ])("leaves %s alone", (input) => {
    expect(text(input)).toBe(input);
  });

  it("masks numbers nested in objects and arrays", () => {
    expect(redactor.value({ to: OWNER, list: [OWNER, { from: OWNER }] })).toEqual({
      to: "***0100",
      list: ["***0100", { from: "***0100" }],
    });
  });
});

describe("secrets", () => {
  it.each([
    [`Authorization: Bearer ${DAEMON_TOKEN}`],
    [`TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}`],
    [`ELEVENLABS_API_KEY="${ELEVENLABS_KEY}"`],
    [`{"apiKey": "${ELEVENLABS_KEY}"}`],
    [`password: hunter2-but-longer`],
    [`client_secret='abc123xyz'`],
    [`/hooks/el/tool?token=${DAEMON_TOKEN}&x=1`],
    [`twilio sid ${TWILIO_ACCOUNT_SID}`],
    [`key ${ELEVENLABS_KEY} in the middle`],
    [`raw ${TWILIO_AUTH_TOKEN} hex`],
    [`gh token ghp_${"a1".repeat(18)}`],
    [`aws ${AWS_KEY_ID}`],
    ["jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl"],
  ])("removes the secret in %s", (input) => {
    const out = text(input);
    expect(out).toContain(REDACTED);
    for (const secret of [
      DAEMON_TOKEN,
      TWILIO_AUTH_TOKEN,
      TWILIO_ACCOUNT_SID,
      ELEVENLABS_KEY,
      "hunter2",
      "abc123xyz",
      AWS_KEY_ID,
      "c2lnbmF0dXJl",
      "a1a1a1a1",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("keeps the names of redacted settings and the rest of the line", () => {
    expect(text(`TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN} region=us1`)).toBe(
      `TWILIO_AUTH_TOKEN=${REDACTED} region=us1`,
    );
    expect(text(`{"apiKey": "${ELEVENLABS_KEY}", "voice": "Rachel"}`)).toBe(
      `{"apiKey": "${REDACTED}", "voice": "Rachel"}`,
    );
  });

  it("removes a PEM private key block", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`;
    const out = text(`key:\n${pem}\ndone`);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(out).toContain("done");
  });

  it("removes values under secret-looking keys whatever they hold", () => {
    expect(
      redactor.value({
        authorization: "anything",
        headers: { "x-twilio-signature": "abc", "xi-api-key": "short", cookie: "a=b" },
        nested: { apiToken: { value: "x" } },
        tokenCount: 3,
        hasToken: true,
        voice: "Rachel",
      }),
    ).toEqual({
      authorization: REDACTED,
      headers: { "x-twilio-signature": REDACTED, "xi-api-key": REDACTED, cookie: REDACTED },
      nested: { apiToken: REDACTED },
      tokenCount: REDACTED,
      hasToken: true,
      voice: "Rachel",
    });
  });

  it("removes known secret values even when no pattern matches them", () => {
    const known = createRedactor(["plainword-secret"]);
    expect(known.text("the value is plainword-secret.")).toBe(`the value is ${REDACTED}.`);
    known.addSecret("another-known-one");
    expect(known.value({ note: "x another-known-one y" })).toEqual({ note: `x ${REDACTED} y` });
  });

  it("ignores known secrets too short to match safely", () => {
    const known = createRedactor(["abc"]);
    expect(known.text("abc abc")).toBe("abc abc");
  });

  it("handles long hostile input in linear time and caps its length", () => {
    for (const input of [
      "a".repeat(200_000),
      "token".repeat(40_000),
      'token="'.repeat(30_000),
      "-----BEGIN PRIVATE KEY-----".repeat(5_000),
    ]) {
      const started = performance.now();
      const out = text(input);
      expect(performance.now() - started).toBeLessThan(1_000);
      // Replacements can lengthen the capped text a little, never without bound.
      expect(out.length).toBeLessThanOrEqual(2 * MAX_REDACTED_TEXT);
      expect(out.length).toBeLessThan(input.length);
    }
  });

  it("never leaves part of a secret at the truncation point", () => {
    const secret = "0123456789abcdef".repeat(4);
    const padding = "x ".repeat(MAX_REDACTED_TEXT / 2 - 10);
    const out = text(`${padding}${secret} tail`);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out).not.toMatch(/[0-9a-f]{6,}/);
    // A known secret straddling the cut is removed before cutting.
    const known = createRedactor(["straddling-known-secret"]);
    const cut = known.text(`${"y ".repeat(MAX_REDACTED_TEXT / 2 - 5)}straddling-known-secret`);
    expect(cut).not.toContain("straddl");
  });

  it("keeps ordinary log text readable", () => {
    for (const line of [
      "agent API: missing or wrong token",
      "rejected webhook",
      "hotline daemon listening",
      "GET /v1/health 200",
      "/Users/example/projects/demo-app",
    ]) {
      expect(text(line)).toBe(line);
    }
  });
});

describe("bypasses closed after the security review", () => {
  it("cuts a 16 KiB hostile line in linear time", () => {
    // A long run of non-separator characters with a separator near the end used to
    // make the truncation pattern backtrack quadratically.
    const hostile = `${"a".repeat(MAX_REDACTED_TEXT - 2)}, ${"b".repeat(MAX_REDACTED_TEXT)}`;
    const started = performance.now();
    const out = text(hostile);
    expect(performance.now() - started).toBeLessThan(50);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out).not.toContain("b");
  });

  it.each([
    "a".repeat(MAX_REDACTED_TEXT),
    `${"x".repeat(MAX_REDACTED_TEXT - 100)}token=${"y".repeat(90)}`,
    `password="${"\\a".repeat(MAX_REDACTED_TEXT / 2)}`,
    `${"5".repeat(9)}x`.repeat(MAX_REDACTED_TEXT / 10),
    `${"%2B".repeat(MAX_REDACTED_TEXT / 3)}`,
    `${"-----BEGIN ".repeat(MAX_REDACTED_TEXT / 11)}`,
  ])("redacts 16 KiB of hostile shape %# in under 50 ms", (input) => {
    const started = performance.now();
    text(input);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it.each([
    ["Digits=1234&CallSid=CAxyz", "1234"],
    ['{"Digits":"1234"}', "1234"],
    ["pin: 4821", "4821"],
    ["passcode=9090", "9090"],
    ["otp=123456", "123456"],
    ["ownerPin=5555", "5555"],
  ])("removes PINs and keypresses in %s", (input, secret) => {
    const out = text(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(secret);
  });

  it("removes PIN and keypress values in objects", () => {
    expect(redactor.value({ Digits: "1234", pin: 4821, passcode: "9090", otp: "123456" })).toEqual({
      Digits: REDACTED,
      pin: REDACTED,
      passcode: REDACTED,
      otp: REDACTED,
    });
  });

  it("removes a registered PIN wherever it stands alone, never inside longer numbers", () => {
    const known = createRedactor();
    known.addShortSecret("4821");
    expect(known.text("the caller said 4821 twice: 4821.")).toBe(
      `the caller said ${REDACTED} twice: ${REDACTED}.`,
    );
    expect(known.text("order 948210 and 14821")).toBe("order 948210 and 14821");
    expect(known.value({ heard: "4821" })).toEqual({ heard: REDACTED });
    // A phone number ending in the PIN is still masked as a phone number first.
    expect(known.text("+15555554821")).toBe(`***${REDACTED}`);
    expect(() => known.addShortSecret("12")).toThrow();
    expect(() => known.addShortSecret("abcd")).toThrow();
  });

  it("masks phone numbers used as object keys and as numbers", () => {
    expect(redactor.value({ [OWNER]: "owner", caller: 15555550100, calls: 3, ms: 1234.5 })).toEqual({
      "***0100": "owner",
      caller: "***0100",
      calls: 3,
      ms: 1234.5,
    });
  });

  it.each([
    ['password="qv\\"zw" next', "zw"],
    [`password="qv"zw" next`, "zw"],
    [`token='it\\'s-secret' next`, "secret"],
    [`password="never-closed ${"x".repeat(20)}`, "never-closed"],
    [`password="${"z".repeat(5000)}" tail`, "zzzz"],
  ])("removes the whole quoted value in %s, failing closed", (input, fragment) => {
    const out = text(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(fragment);
  });

  it("keeps text after a properly closed quoted secret", () => {
    expect(text('password="qv\\"zw" next')).toBe(`password="${REDACTED}" next`);
  });

  it.each([
    ["From%3D%2B15555550100", "From%3D***0100"],
    ["x15555550100", "x***0100"],
    ["id:abc5555550100def", "id:abc***0100def"],
    ["tel:+15555550100", "tel:***0100"],
  ])("masks the phone number in %s", (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it("over-redacts 10-digit runs inside identifiers rather than risk a leak", () => {
    expect(text(`CA${"0123456789abcdef".repeat(2)}`)).not.toContain("0123456789");
  });

  it("keeps pino's own timestamp in log lines", () => {
    const lines: string[] = [];
    redactingStream({ write: (line) => lines.push(line) }, createRedactor()).write(
      `${JSON.stringify({ time: 1760392680000, caller: 15555550100 })}\n`,
    );
    expect(JSON.parse(lines[0] ?? "")).toEqual({ time: 1760392680000, caller: "***0100" });
  });
});

describe("redactingStream", () => {
  it("redacts every field of a JSON log line, including the message", () => {
    const lines: string[] = [];
    const stream = redactingStream({ write: (line) => lines.push(line) }, createRedactor([DAEMON_TOKEN]));
    stream.write(
      `${JSON.stringify({
        level: 30,
        time: 1760392680000,
        msg: `texting ${OWNER} with ${DAEMON_TOKEN}`,
        req: {
          url: `/x?to=${encodeURIComponent(OWNER)}`,
          headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
        },
      })}\n`,
    );
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("5555550100");
    expect(line).not.toContain(DAEMON_TOKEN);
    const parsed = JSON.parse(line) as { time: number; msg: string; req: { url: string } };
    expect(parsed.time).toBe(1760392680000);
    expect(parsed.msg).toBe(`texting ***0100 with ${REDACTED}`);
    expect(parsed.req.url).toBe("/x?to=***0100");
  });

  it("redacts a line that is not JSON as text", () => {
    const lines: string[] = [];
    redactingStream({ write: (line) => lines.push(line) }, createRedactor()).write(`oops ${OWNER}\n`);
    expect(lines).toEqual(["oops ***0100\n"]);
  });
});
