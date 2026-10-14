// Redaction for everything the daemon logs or writes to the audit log. Phone
// numbers keep their last four digits; secrets, PINs and keypresses are removed
// entirely. This is a safety net under the rule that callers never log secrets
// in the first place, so it errs towards removing too much.
//
// Every pattern here is either anchored or bounded, so redaction runs in linear
// time on long or hostile input.

export const REDACTED = "[REDACTED]";

/**
 * Name fragments that mark a value as secret: credentials, plus the owner's PIN
 * and keypresses (`pin`, `passcode`, `otp`, and Twilio's `Digits`). Matched
 * anywhere in a name, so `ownerPin` and `TWILIO_AUTH_TOKEN` count. That also
 * catches some innocent names such as `mapping`, which is the intended bias.
 */
const SECRET_NAME =
  "token|secret|passw(?:or)?d|pwd|passcode|pin|otp|digits|api[-_]?key|private[-_]?key|access[-_]?key|credential|signature|authorization|cookie";

/** Object keys whose values are always removed, whatever they hold. */
const SECRET_KEY = new RegExp(SECRET_NAME, "i");

/**
 * `name=value`, `name: value` and `"name": "value"` where the name looks secret.
 * The match starts at a name boundary and every repetition is bounded. Quoted
 * values honour backslash escapes, and anything after the closing quote up to the
 * next separator goes too. An opening quote with no closing quote within the
 * bound fails closed: everything to the end of the line is removed.
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?[A-Za-z0-9_.-]{0,64}(?:${SECRET_NAME})[A-Za-z0-9_.-]{0,64}["']?\s{0,8}[:=]\s{0,8})` +
    String.raw`("(?:[^"\\\r\n]|\\.){0,4096}"[^\s,;&}\]]*|'(?:[^'\\\r\n]|\\.){0,4096}'[^\s,;&}\]]*|["'][^\r\n]*|[^\s,;&"'}\]]+)`,
  "gi",
);

/** Longer strings are cut to this many characters before redaction; logs never need more. */
export const MAX_REDACTED_TEXT = 16 * 1024;

/** Characters that end a word for truncation and unquoted values. */
const SEPARATOR = /[\s,;&"'}\]]/;

/**
 * The first `max` characters of `text`, minus the word the cut went through, so
 * no fragment of a token survives. A backward scan, linear in `max`.
 */
function cutBeforeWord(text: string, max: number): string {
  let end = max;
  while (end > 0 && !SEPARATOR.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/** `Authorization` schemes followed by a credential. */
const AUTH_SCHEME = /\b([Bb]earer|Basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,}/g;

/** Credential formats recognisable on their own, wherever they appear. */
const KNOWN_TOKENS: readonly RegExp[] = [
  /\bsk[-_][A-Za-z0-9_-]{16,}/g, // OpenAI- and ElevenLabs-style API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b(?:AC|SK)[0-9a-f]{32}\b/g, // Twilio account and API key SIDs
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
];

/**
 * Long runs of letters and digits look like keys or tokens (a Twilio auth token is
 * 32 hex digits, the daemon token 43 base64url characters). Identifiers that are
 * not secrets are kept so logs stay useful: Twilio call and message SIDs,
 * ElevenLabs conversation and agent ids, and UUIDs.
 */
const OPAQUE_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const NOT_SECRET_IDS =
  /^(?:(?:CA|SM|MM|PN|MG)[0-9a-f]{32}|(?:conv|agent|phnum)_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function hasLetterAndDigit(text: string): boolean {
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

/**
 * Formatted phone numbers: an optional `+` (or `%2B`, its URL encoding), then
 * digits with spaces, dots, dashes or parentheses between them. A run is a phone
 * number when it has 8 to 15 digits after a `+`, or 10 to 15 without one. Dates
 * (8 digits), times, versions and IP addresses stay below those counts. A URL
 * escape such as `%3D` right before it counts as a boundary.
 */
const PHONE_CANDIDATE =
  /(?:(?<=%[0-9A-Fa-f]{2})|(?<![A-Za-z0-9_-]))(?:\+|%2[Bb])?\(?\d[\d\s().-]{5,22}\d(?![A-Za-z0-9_])/g;

/** Any bare run of 10 to 15 digits, even inside a word: masked as a phone number. */
const DIGIT_RUN = /(?<!\d)\d{10,15}(?!\d)/g;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, "");
  const international = match.startsWith("+") || /^%2b/i.test(match);
  // `%2B` contributes the digit 2; do not count it.
  const count = /^%2b/i.test(match) ? digits.length - 1 : digits.length;
  const min = international ? 8 : 10;
  if (count < min || count > 15) return match;
  return `***${digits.slice(-4)}`;
}

/** A number that could be a phone number written without formatting. */
function looksLikePhoneNumber(value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  const digits = String(Math.abs(value)).length;
  return digits >= 10 && digits <= 15;
}

export interface Redactor {
  /** Redacts one string. */
  text(input: string): string;
  /**
   * Deeply redacts a JSON-like value: strings and object keys go through `text`,
   * numbers that look like phone numbers are masked, and values under
   * secret-looking keys are removed.
   */
  value(input: unknown): unknown;
  /** Also removes this exact value wherever it appears (values shorter than 8 characters are ignored). */
  addSecret(secret: string): void;
  /**
   * Also removes a short all-digit secret, the owner's PIN, wherever it stands on
   * its own (not inside a longer digit run). Accepts 4 to 8 digits.
   */
  addShortSecret(digits: string): void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(values: Iterable<string>): string {
  // Longest first, so a secret that contains another is removed whole.
  return [...values]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

const MAX_DEPTH = 12;

/** A redactor that also removes `knownSecrets`, such as the daemon's own API token. */
export function createRedactor(knownSecrets: Iterable<string> = []): Redactor {
  const secrets = new Set<string>();
  const shortSecrets = new Set<string>();
  let exact: RegExp | undefined;
  let exactShort: RegExp | undefined;

  const addSecret = (secret: string) => {
    if (secret.length < 8 || secrets.has(secret)) return;
    secrets.add(secret);
    exact = new RegExp(alternation(secrets), "g");
  };
  for (const secret of knownSecrets) addSecret(secret);

  const addShortSecret = (digits: string) => {
    if (!/^\d{4,8}$/.test(digits)) throw new Error("A short secret must be 4 to 8 digits");
    shortSecrets.add(digits);
    exactShort = new RegExp(`(?<!\\d)(?:${alternation(shortSecrets)})(?!\\d)`, "g");
  };

  const text = (input: string): string => {
    let out = input;
    if (exact) out = out.replace(exact, REDACTED);
    if (out.length > MAX_REDACTED_TEXT) out = `${cutBeforeWord(out, MAX_REDACTED_TEXT)} [truncated]`;
    out = out.replace(PRIVATE_KEY_BLOCK, `${REDACTED} private key`);
    out = out.replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`);
    out = out.replace(SECRET_ASSIGNMENT, (_match, name: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      const closed = quote !== "" && value.length >= 2 && value.indexOf(quote, 1) !== -1;
      return closed ? `${name}${quote}${REDACTED}${quote}` : `${name}${REDACTED}`;
    });
    for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, REDACTED);
    out = out.replace(OPAQUE_RUN, (run) =>
      run !== REDACTED && hasLetterAndDigit(run) && !NOT_SECRET_IDS.test(run) ? REDACTED : run,
    );
    out = out.replace(PHONE_CANDIDATE, maskPhone);
    out = out.replace(DIGIT_RUN, (run) => `***${run.slice(-4)}`);
    // Last, so removing a PIN can never break up a phone number before it is masked.
    if (exactShort) out = out.replace(exactShort, REDACTED);
    return out;
  };

  const value = (input: unknown, depth = 0): unknown => {
    if (typeof input === "string") return text(input);
    if (typeof input === "number") return looksLikePhoneNumber(input) ? text(String(input)) : input;
    if (input === null || typeof input !== "object") return input;
    if (depth >= MAX_DEPTH) return REDACTED;
    if (Array.isArray(input)) return input.map((item) => value(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const secretKey = SECRET_KEY.test(key) && item !== null && typeof item !== "boolean";
      out[text(key)] = secretKey ? REDACTED : value(item, depth + 1);
    }
    return out;
  };

  return { text, value: (input) => value(input), addSecret, addShortSecret };
}
