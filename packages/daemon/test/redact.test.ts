import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED, redactingStream } from "../src/index.js";

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
    "123e4567-e89b-12d3-a456-426614174000",
    `CA${"0123456789abcdef".repeat(2)}`,
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
