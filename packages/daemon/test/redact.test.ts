import { describe, expect, it } from "vitest";
import { createRedactor, MAX_REDACTED_TEXT, REDACTED, redactingStream } from "../src/index.js";
import { linearTime } from "./linear-time.js";

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
    expect(linearTime(text, hostile)).toMatchObject({ linear: true });
    const out = text(hostile);
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
  ])("redacts 16 KiB of hostile shape %# in linear time", (input) => {
    expect(linearTime(text, input)).toMatchObject({ linear: true });
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

  it("removes a registered PIN wherever it appears, and any digit run around it", () => {
    const known = createRedactor();
    known.addShortSecret("1234");
    expect(known.text("the caller said 1234 twice: 1234.")).toBe(
      `the caller said ${REDACTED} twice: ${REDACTED}.`,
    );
    expect(known.value({ heard: "1234" })).toEqual({ heard: REDACTED });
    expect(() => known.addShortSecret("12")).toThrow();
    expect(() => known.addShortSecret("abcd")).toThrow();
  });

  it.each([
    ["12345", REDACTED],
    ["12341234", REDACTED],
    ["keys 991234 end", `keys ${REDACTED} end`],
    // A 12-digit run ending in the PIN is removed whole, never masked to ***1234.
    ["555555551234", REDACTED],
    ["x555555551234", `x${REDACTED}`],
    // The PIN inside a formatted phone number takes the whole number with it.
    ["+1 (555) 555-1234", REDACTED],
    ["call +15555551234 now", `call ${REDACTED} now`],
    ["From=%2B15555551234", `From=${REDACTED}`],
  ])("fails closed on the PIN inside %s", (input, expected) => {
    const known = createRedactor();
    known.addShortSecret("1234");
    const out = known.text(input);
    expect(out).toBe(expected);
    expect(out).not.toContain("1234");
  });

  it.each([
    "9".repeat(MAX_REDACTED_TEXT),
    "9 ".repeat(MAX_REDACTED_TEXT / 2),
    "(9-".repeat(MAX_REDACTED_TEXT / 3),
    "+9    ".repeat(MAX_REDACTED_TEXT / 6),
  ])("scans hostile digit shape %# for the PIN in linear time", (input) => {
    const known = createRedactor();
    known.addShortSecret("1234");
    expect(linearTime((s) => known.text(s), input)).toMatchObject({ linear: true });
  });

  it("still masks phone numbers that do not contain the PIN", () => {
    const known = createRedactor();
    known.addShortSecret("1234");
    expect(known.text(`call ${OWNER}`)).toBe("call ***0100");
  });

  it("redacts numbers that equal or contain a registered secret, under any key", () => {
    const known = createRedactor(["98765432"]);
    known.addShortSecret("1234");
    expect(known.value({ input: 1234, other: 512345, long: 98765432, count: 7, ratio: 0.5 })).toEqual({
      input: REDACTED,
      other: REDACTED,
      long: REDACTED,
      count: 7,
      ratio: 0.5,
    });
  });

  it("removes URL-encoded and JSON-escaped forms of a known secret", () => {
    const secret = 'tok/en+va"lue\\x=9';
    const known = createRedactor([secret]);
    const encoded = encodeURIComponent(secret);
    expect(known.text(`/hooks/x?k=${encoded}&a=1`)).toBe(`/hooks/x?k=${REDACTED}&a=1`);
    expect(known.text(`lower ${encoded.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())}`)).toBe(
      `lower ${REDACTED}`,
    );
    const json = JSON.stringify({ note: `pre ${secret} end` });
    expect(known.text(json)).toBe(`{"note":"pre ${REDACTED} end"}`);
    for (const out of [known.text(encoded), known.text(json)]) {
      expect(out).not.toContain("tok");
      expect(out).not.toContain("lue");
    }
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

  it("stops removing segments after an encoded secret at the closing quote, on any later line", () => {
    const out = text('{"token":"ab+cd,ef\ngh"}, "note": "kept words"\nnext line kept');
    expect(out).not.toMatch(/ab|cd|ef|gh/);
    expect(out).toContain('"note": "kept words"\nnext line kept');
  });

  it("removes everything after an encoded secret whose quote never closes, failing closed", () => {
    const out = text('{"token":"ab+cd,ef\nmore text here');
    expect(out).not.toMatch(/ab|cd|ef|more|text|here/);
    expect(out).toContain(REDACTED);
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

  it.each([
    ["Dig%69ts=1234&CallSid=CA1", `${REDACTED}&CallSid=CA1`],
    ["Digits+=1234&From=x", `${REDACTED}&From=x`],
    ["%44igits=1234", REDACTED],
    ["a=1&p%61ssword=hunter22&b=2", `a=1&${REDACTED}&b=2`],
    ['{"Dig%69ts":"1234"}', REDACTED],
  ])("removes a secret whose name is hidden by URL encoding in %s", (input, expected) => {
    const out = text(input);
    expect(out).toBe(expected);
    expect(out).not.toContain("1234");
  });

  it("removes a registered secret or PIN that is only recognisable once decoded", () => {
    const known = createRedactor(["plainword-secret"]);
    known.addShortSecret("4821");
    expect(known.text("k=%70lainword-secret&a=1")).toBe(`${REDACTED}&a=1`);
    expect(known.text("x=plainword%2Dsecret")).toBe(REDACTED);
    expect(known.text("said=%34%38%32%31 ok")).toBe(`${REDACTED} ok`);
    // A malformed escape still decodes the valid ones around it.
    expect(known.text("k=%70lainword-secret%E0%A4")).toBe(REDACTED);
  });

  it("leaves encoded segments without secrets alone", () => {
    expect(text("q=hello+world&path=%2Fv1%2Fhealth")).toBe("q=hello+world&path=%2Fv1%2Fhealth");
  });

  // Was "in under 50 ms", which flaked under parallel load (HL-10, #14). The
  // guarantee is linear time; comparing timings taken side by side (test/linear-time.ts)
  // keeps it without depending on how busy the machine is.
  it("decodes 16 KiB of hostile escapes in linear time", () => {
    const known = createRedactor(["plainword-secret"]);
    known.addShortSecret("4821");
    for (const input of [
      "%41".repeat(MAX_REDACTED_TEXT / 3),
      "+".repeat(MAX_REDACTED_TEXT),
      "%E0+".repeat(4096),
    ]) {
      expect(linearTime((s) => known.text(s), input)).toMatchObject({ linear: true });
    }
  });

  it.each([
    ["From=%2B15555550100&Digits=4821", `From=***0100&Digits=${REDACTED}`],
    ["PIN : 4821", `PIN : ${REDACTED}`],
    ["Digits=4821 then pin=4821, ok", `Digits=${REDACTED} then pin=${REDACTED}, ok`],
  ])("never leaves a stray bracket after an earlier pass redacted %s", (input, expected) => {
    const known = createRedactor();
    known.addShortSecret("4821");
    expect(known.text(input)).toBe(expected);
  });

  it("removes a whole encoded segment whose decoded form is secret, even if the raw form partly matched", () => {
    const known = createRedactor();
    known.addShortSecret("4821");
    // The raw segment already looks secret (`token=`), and its decoded copy also
    // reveals the PIN and a second name; none of it may survive.
    for (const input of ["token=abc%26pin%3D%34%38%32%31", "token=x+Digits=%34%38%32%31"]) {
      const out = known.text(input);
      expect(out).toBe(REDACTED);
    }
  });

  it.each([
    ["agent_", `agent_${"k".repeat(20)}${"7".repeat(20)}`],
    ["conv_", `conv_${"Q9".repeat(20)}`],
    ["phnum_", `phnum_${"a1".repeat(20)}`],
  ])("does not exempt a %s-prefixed 40-character secret", (_prefix, secret) => {
    expect(text(`id ${secret} end`)).toBe(`id ${REDACTED} end`);
  });

  it("removes UUID-shaped values, registered as secrets or not", () => {
    const uuidKey = "9f1c2d3e-4b5a-6789-abcd-ef0123456789";
    expect(text(`key ${uuidKey}`)).toBe(`key ${REDACTED}`);
    const known = createRedactor([uuidKey]);
    expect(known.text(`k=${uuidKey}&x=${encodeURIComponent(uuidKey)}`)).toBe(`k=${REDACTED}&x=${REDACTED}`);
  });

  it("still keeps Twilio SIDs, the one exempt id format", () => {
    const sid = `CA${"0a1b2c3d4e5f6a7b".repeat(2)}`;
    expect(text(`call ${sid}`)).toBe(`call ${sid}`);
    // Not 32 hex digits after the prefix: removed.
    expect(text(`call CA${"0a1b2c3d4e5f6a7b".repeat(2)}ff`)).toBe(`call ${REDACTED}`);
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
