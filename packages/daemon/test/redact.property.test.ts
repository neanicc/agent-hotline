// Property and fuzz tests for the redactor (HL-13, carried over from HL-04).
//
// Random secrets, PINs and phone numbers are embedded in JSON, form-encoded,
// URL-encoded, `.env`-style and YAML text, and nothing of them may survive:
// no run of `WINDOW` characters of the value, raw or in the encoding it was
// embedded with, appears in the output unless the surrounding text already
// held it. Every pass must also stay linear on random hostile shapes.
//
// Known gaps, accepted in docs/security.md rather than tested here: a
// registered secret re-encoded another way (base64, upper case, split across
// lines), a YAML block scalar under a secret name (only its first line goes),
// an unquoted multi-word value under a secret name (only its first word goes)
// and a phone number separated by slashes.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRedactor, MAX_REDACTED_TEXT } from "../src/index.js";
import { linearTime } from "./linear-time.js";

/** The shortest piece of a secret that counts as a leak. */
const WINDOW = 6;
const PLACEHOLDER = "\u0000";
/** Text the redactor itself writes. */
const MARKERS = "[REDACTED] [truncated] *** private key";

/** Every piece of `value` of `WINDOW` characters (or all of it, if shorter). */
function windows(value: string): string[] {
  if (value.length <= WINDOW) return [value];
  return Array.from({ length: value.length - WINDOW + 1 }, (_, i) => value.slice(i, i + WINDOW));
}

/**
 * The pieces of `forms` (a value and its encodings) that survive in `output`,
 * leaving out any piece the text around the value or the redactor's own
 * markers already hold.
 */
function leaks(output: string, template: string, forms: readonly string[]): string[] {
  const context = `${template}\n${MARKERS}`;
  return forms.flatMap(windows).filter((piece) => !context.includes(piece) && output.includes(piece));
}

// ---------------------------------------------------------------------------
// Formats. Each embeds `name` and `value` among ordinary fields and returns the
// text plus the form the value took in it.

interface Embedded {
  text: string;
  form: string;
}
type Format = (name: string, value: string) => Embedded;

const yamlQuoted = (value: string) => JSON.stringify(value);

const FORMATS: Readonly<Record<string, Format>> = {
  json: (name, value) => {
    const form = JSON.stringify(value).slice(1, -1);
    return { text: JSON.stringify({ voice: "Rachel", [name]: value, note: "done" }), form };
  },
  jsonNested: (name, value) => {
    const form = JSON.stringify(value).slice(1, -1);
    return { text: JSON.stringify({ request: { headers: { [name]: value } }, ok: true }), form };
  },
  form: (name, value) => {
    const text = new URLSearchParams([
      ["CallSid", "CA-fake"],
      [name, value],
      ["Body", "hello"],
    ]).toString();
    const form = new URLSearchParams([["", value]]).toString().slice(1);
    return { text, form };
  },
  url: (name, value) => {
    const form = encodeURIComponent(value);
    return { text: `GET /hooks/el/tool?a=1&${encodeURIComponent(name)}=${form}&b=2`, form };
  },
  envQuoted: (name, value) => {
    const form = JSON.stringify(value).slice(1, -1);
    return { text: `VOICE=Rachel\n${name.toUpperCase()}="${form}"\nREGION=us1`, form };
  },
  yamlQuoted: (name, value) => {
    const form = yamlQuoted(value).slice(1, -1);
    return { text: `voice: Rachel\n${name}: "${form}"\nregion: us1`, form };
  },
};

/** Formats that carry an unquoted value, which ends at the first separator. */
const UNQUOTED_FORMATS: Readonly<Record<string, Format>> = {
  env: (name, value) => ({ text: `VOICE=Rachel\n${name.toUpperCase()}=${value}\nREGION=us1`, form: value }),
  envExport: (name, value) => ({ text: `export ${name.toUpperCase()}=${value}`, form: value }),
  yaml: (name, value) => ({ text: `voice: Rachel\n${name}: ${value}\nregion: us1`, form: value }),
  header: (name, value) => ({ text: `${name}: ${value}\nuser-agent: test`, form: value }),
  logfmt: (name, value) => ({ text: `level=info ${name}=${value} msg=done`, form: value }),
};

const ALL_FORMATS = { ...FORMATS, ...UNQUOTED_FORMATS };

// ---------------------------------------------------------------------------
// Values

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Characters a token can hold without ending an unquoted value. */
const TOKEN_CHARS = `${ALNUM}_-./+=:@!$%^*~`;
const PRINTABLE = `${TOKEN_CHARS} ,;&"'{}[]()<>?#|\\\``;

const stringOf = (chars: string, minLength: number, maxLength: number) =>
  fc
    .array(fc.constantFrom(...chars), { minLength, maxLength })
    .map((parts) => parts.join(""))
    .filter((value) => /[A-Za-z0-9]{2}/.test(value));

const SECRET_NAMES = [
  "token",
  "apiKey",
  "api_key",
  "TWILIO_AUTH_TOKEN",
  "ELEVENLABS_API_KEY",
  "password",
  "passwd",
  "client_secret",
  "x-twilio-signature",
  "authorization",
  "cookie",
  "access_key",
  "private_key",
  "credential",
  "ownerPin",
  "Digits",
  "otp",
];
const PLAIN_NAMES = ["voiceId", "note", "detail", "agent", "conversation"];

// ---------------------------------------------------------------------------

describe("redactor fuzzing: secrets", () => {
  it("removes a registered secret wherever it is embedded, raw or encoded", () => {
    fc.assert(
      fc.property(
        stringOf(PRINTABLE, 8, 40),
        fc.constantFrom(...PLAIN_NAMES, ...SECRET_NAMES),
        fc.constantFrom(...Object.keys(FORMATS)),
        (secret, name, format) => {
          const { text, form } = FORMATS[format]?.(name, secret) ?? { text: "", form: "" };
          const template = FORMATS[format]?.(name, PLACEHOLDER).text ?? "";
          const output = createRedactor([secret]).text(text);
          expect(leaks(output, template, [secret, form]), JSON.stringify({ text, output })).toEqual([]);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("removes a registered secret in free text and unquoted fields", () => {
    fc.assert(
      fc.property(
        stringOf(TOKEN_CHARS, 8, 40),
        fc.constantFrom(...PLAIN_NAMES),
        fc.constantFrom(...Object.keys(UNQUOTED_FORMATS)),
        (secret, name, format) => {
          const { text } = UNQUOTED_FORMATS[format]?.(name, secret) ?? { text: "" };
          const template = UNQUOTED_FORMATS[format]?.(name, PLACEHOLDER).text ?? "";
          const free = `the agent read ${secret} and stopped`;
          const known = createRedactor([secret]);
          for (const [input, around] of [
            [text, template],
            [free, "the agent read \u0000 and stopped"],
          ] as const) {
            const output = known.text(input);
            expect(leaks(output, around, [secret]), JSON.stringify({ input, output })).toEqual([]);
          }
        },
      ),
      { numRuns: 4000 },
    );
  });

  it("removes any value under a secret-looking name in a quoted or encoded format", () => {
    fc.assert(
      fc.property(
        stringOf(PRINTABLE, 8, 40),
        fc.constantFrom(...SECRET_NAMES),
        fc.constantFrom(...Object.keys(FORMATS)),
        (value, name, format) => {
          const { text, form } = FORMATS[format]?.(name, value) ?? { text: "", form: "" };
          const template = FORMATS[format]?.(name, PLACEHOLDER).text ?? "";
          const output = createRedactor().text(text);
          expect(leaks(output, template, [value, form]), JSON.stringify({ text, output })).toEqual([]);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("removes a token-like value under a secret-looking name in an unquoted format", () => {
    fc.assert(
      fc.property(
        stringOf(TOKEN_CHARS, 8, 40),
        fc.constantFrom(...SECRET_NAMES),
        fc.constantFrom(...Object.keys(UNQUOTED_FORMATS)),
        (value, name, format) => {
          const { text } = UNQUOTED_FORMATS[format]?.(name, value) ?? { text: "" };
          const template = UNQUOTED_FORMATS[format]?.(name, PLACEHOLDER).text ?? "";
          const output = createRedactor().text(text);
          expect(leaks(output, template, [value]), JSON.stringify({ text, output })).toEqual([]);
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe("redactor fuzzing: PINs and phone numbers", () => {
  const pin = fc.stringMatching(/^\d{4,8}$/);

  it("never lets a registered PIN through, in any format or in random text", () => {
    const carrier = fc.oneof(
      fc
        .constantFrom(...Object.keys(ALL_FORMATS))
        .chain((format) =>
          fc.constantFrom(...PLAIN_NAMES, ...SECRET_NAMES).map((name) => ({ format, name })),
        ),
      fc.constant(undefined),
    );
    const noise = fc.string({ unit: fc.constantFrom(..."0123456789 +-().%2Bx=&:"), maxLength: 40 });
    fc.assert(
      fc.property(pin, carrier, noise, noise, (secret, where, before, after) => {
        const known = createRedactor();
        known.addShortSecret(secret);
        const embedded =
          where === undefined
            ? `${before}${secret}${after}`
            : `${before} ${ALL_FORMATS[where.format]?.(where.name, secret).text ?? ""} ${after}`;
        const output = known.text(embedded);
        expect(output.includes(secret), JSON.stringify({ embedded, output })).toBe(false);
        // Its encoded digits are as secret as the digits.
        const encoded = [...secret].map((digit) => `%3${digit}`).join("");
        expect(known.text(`said=${encoded} ok`).includes(secret)).toBe(false);
      }),
      { numRuns: 5000 },
    );
  });

  // Numbers in the fictional 555-0100 to 555-0199 range, and the UK's 07700 900xxx.
  const phone = fc.oneof(
    fc
      .tuple(fc.integer({ min: 201, max: 989 }), fc.integer({ min: 100, max: 199 }))
      .map(([area, line]) => ({ country: "1", national: `${area}555${String(line).padStart(4, "0")}` })),
    fc.integer({ min: 100, max: 999 }).map((line) => ({ country: "44", national: `7700900${line}` })),
  );
  const formats: readonly ((country: string, national: string) => string)[] = [
    (c, n) => `+${c}${n}`,
    (c, n) => `%2B${c}${n}`,
    (c, n) => `+${c} ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`,
    (c, n) => `+${c} (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`,
    (c, n) => `+${c}.${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6)}`,
    (c, n) => `${c}-${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`,
    (c, n) => (c === "1" ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : `0${n}`),
    (c, n) => (c === "1" ? n : `0${n}`),
  ];

  it("keeps at most the last four digits of a phone number, in any format", () => {
    fc.assert(
      fc.property(
        phone,
        fc.integer({ min: 0, max: formats.length - 1 }),
        fc.constantFrom(...Object.keys(ALL_FORMATS), "text"),
        fc.constantFrom("to", "From", "caller", "owner_phone"),
        ({ country, national }, which, format, name) => {
          const written = formats[which]?.(country, national) ?? "";
          const embed = (value: string) =>
            format === "text" ? `calling ${value} now` : (ALL_FORMATS[format]?.(name, value).text ?? "");
          const text = embed(written);
          const template = embed(PLACEHOLDER);
          const output = createRedactor().text(text);
          const digits = `${country}${national}`;
          // Everything but the last four digits: as written, and as bare digits.
          const head = written.slice(0, written.length - 4);
          const forms = [digits.slice(0, -4), national.slice(0, -4)].filter((form) => form.length >= WINDOW);
          const context = `${template}\n${MARKERS}`;
          if (!context.includes(head) && head.replace(/\D/g, "").length >= 6) {
            expect(output.includes(head), JSON.stringify({ text, output })).toBe(false);
          }
          expect(leaks(output, template, forms), JSON.stringify({ text, output })).toEqual([]);
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe("redactor fuzzing: linear time", () => {
  const known = createRedactor(["plainword-secret"]);
  known.addShortSecret("4821");
  const piece = fc.constantFrom(
    "a",
    "9",
    " ",
    "=",
    ":",
    '"',
    "'",
    "\\",
    "%",
    "%2B",
    "%E0",
    "+",
    "(",
    "-",
    ".",
    ",",
    "&",
    "token",
    "pin",
    "Digits=",
    'password="',
    "Bearer ",
    "sk-",
    "eyJ",
    "-----BEGIN ",
    "PRIVATE KEY-----",
    "\n",
    "4821",
    "plainword-",
    "CA",
    "0123456789abcdef",
  );

  it("redacts random 16 KiB hostile shapes in linear time", () => {
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 6 }), (parts) => {
        const unit = parts.join("");
        const hostile = unit.repeat(Math.ceil(MAX_REDACTED_TEXT / unit.length)).slice(0, MAX_REDACTED_TEXT);
        const measured = linearTime((input) => known.text(input), hostile);
        expect(measured, JSON.stringify(unit)).toMatchObject({ linear: true });
      }),
      { numRuns: 80 },
    );
  });

  // Found by the property above: the JWT pattern scanned to the end of the run
  // from every `eyJ` in it.
  it.each(["eyJ-", "eyJplainword-", "eyJ.", "eyJaaaaa.aaaaa."])(
    "redacts 16 KiB of %j in linear time",
    (unit) => {
      const hostile = unit.repeat(Math.ceil(MAX_REDACTED_TEXT / unit.length)).slice(0, MAX_REDACTED_TEXT);
      expect(linearTime((input) => known.text(input), hostile)).toMatchObject({ linear: true });
    },
  );
});
