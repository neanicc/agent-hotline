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
 * next separator goes too. An unquoted value runs to the next separator, quotes
 * inside it included (`token=a'b`, HL-13). An opening quote with no closing quote
 * within the bound fails closed: everything to the end of the line is removed.
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?[A-Za-z0-9_.-]{0,64}(?:${SECRET_NAME})[A-Za-z0-9_.-]{0,64}["']?\s{0,8}[:=]\s{0,8})` +
    String.raw`(\[REDACTED\]|"(?:[^"\\\r\n]|\\.){0,4096}"[^\s,;&}\]]*|'(?:[^'\\\r\n]|\\.){0,4096}'[^\s,;&}\]]*|["'][^\r\n]*|[^\s,;&"'}\]][^\s,;&}\]]*)`,
  "gi",
);

/** Non-global copies for `test`, which must not carry `lastIndex` between calls. */
const SECRET_ASSIGNMENT_TEST = new RegExp(SECRET_ASSIGNMENT.source, "i");

/** Splits text into form and URL segments, keeping the delimiters. */
const SEGMENT_DELIMITER = /([&;?#,\s]+)/;

/**
 * Decodes a segment the way a form or query parser would: `+` becomes a space,
 * then `%XX` escapes are decoded. A run of escapes that is not valid UTF-8 is
 * decoded byte by byte instead of failing, so malformed input still decodes.
 */
function formDecode(segment: string): string {
  return segment.replace(/\+/g, " ").replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}

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
const AUTH_SCHEME_TEST = new RegExp(AUTH_SCHEME.source);

/** Credential formats recognisable on their own, wherever they appear. */
const KNOWN_TOKENS: readonly RegExp[] = [
  /\bsk[-_][A-Za-z0-9_-]{16,}/g, // OpenAI- and ElevenLabs-style API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b(?:AC|SK)[0-9a-f]{32}\b/g, // Twilio account and API key SIDs
  // JWTs. Not after a token character: with `\b`, every `eyJ` in `eyJ-eyJ-...`
  // started a scan to the end of the run, which was quadratic (HL-13 fuzzing).
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
];

/**
 * Long runs of letters and digits look like keys or tokens (a Twilio auth token is
 * 32 hex digits, the daemon token 43 base64url characters). The only exemption is
 * an exact, well-known non-secret format: a Twilio call, message, phone-number or
 * messaging-service SID (`CA`, `SM`, `MM`, `PN`, `MG` plus 32 hex digits). Anything
 * else of that shape, ElevenLabs ids and UUIDs included, is removed: a provider can
 * issue keys that look like ids, and the daemon logs its own ids through
 * structured fields it controls.
 */
const OPAQUE_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const NOT_SECRET_IDS = /^(?:CA|SM|MM|PN|MG)[0-9a-f]{32}$/;

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

/**
 * Digits, optionally joined by short runs of phone formatting (`+`, `%2B`,
 * spaces, dots, dashes, parentheses). Each repetition consumes a digit and the
 * separators are never digits, so matching is linear.
 */
const DIGIT_CLUSTER = /(?:\+|%2[Bb])?\(?\d(?:[\s().-]{0,3}\d)*/g;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, "");
  const international = match.startsWith("+") || /^%2b/i.test(match);
  // `%2B` contributes the digit 2; do not count it.
  const count = /^%2b/i.test(match) ? digits.length - 1 : digits.length;
  const min = international ? 8 : 10;
  if (count < min || count > 15) return match;
  return `***${digits.slice(-4)}`;
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
  /**
   * Also removes this exact value wherever it appears, raw, URL-encoded or
   * JSON-escaped (values shorter than 8 characters are ignored).
   */
  addSecret(secret: string): void;
  /**
   * Also removes a short all-digit secret, the owner's PIN (4 to 8 digits). Any
   * digit run or formatted number containing it is removed whole, which errs
   * towards removing too much.
   */
  addShortSecret(digits: string): void;
}

/** `text` without its backslash escapes, so an escaped quote is not taken for a closing one. */
function withoutEscapes(text: string): string {
  return text.replace(/\\[\s\S]/g, "");
}

/** The quote a segment leaves open (an odd number of unescaped `"`, else of `'`), if any. */
function unclosedQuote(segment: string): string | undefined {
  const unescaped = withoutEscapes(segment);
  for (const quote of ['"', "'"]) {
    if (unescaped.split(quote).length % 2 === 0) return quote;
  }
  return undefined;
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

  const addSecret = (secret: string) => {
    if (secret.length < 8) return;
    // Also the forms a secret takes inside a URL or a JSON string.
    const uri = encodeURIComponent(secret);
    const forms = [secret, uri, uri.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())];
    forms.push(JSON.stringify(secret).slice(1, -1));
    const before = secrets.size;
    for (const form of forms) secrets.add(form);
    if (secrets.size !== before) exact = new RegExp(alternation(secrets), "g");
  };
  for (const secret of knownSecrets) addSecret(secret);

  const addShortSecret = (digits: string) => {
    if (!/^\d{4,8}$/.test(digits)) throw new Error("A short secret must be 4 to 8 digits");
    shortSecrets.add(digits);
  };

  /**
   * Removes every digit cluster (a run of digits, possibly formatted as a phone
   * number) whose digits contain a registered short secret anywhere, whole. Runs
   * before phone masking, so a masked number can never print the PIN as its last
   * four digits, and a PIN inside a longer run or a formatted number is not missed.
   */
  const removeShortSecrets = (input: string): string => {
    if (shortSecrets.size === 0) return input;
    return input.replace(DIGIT_CLUSTER, (cluster) => {
      const digits = cluster.replace(/\D/g, "");
      for (const secret of shortSecrets) if (digits.includes(secret)) return REDACTED;
      return cluster;
    });
  };

  /** Whether `segment` holds something the passes below would redact. */
  const looksSecret = (segment: string): boolean =>
    SECRET_ASSIGNMENT_TEST.test(segment) ||
    AUTH_SCHEME_TEST.test(segment) ||
    KNOWN_TOKENS.some((pattern) => new RegExp(pattern.source).test(segment)) ||
    (exact !== undefined && new RegExp(exact.source).test(segment)) ||
    removeShortSecrets(segment) !== segment;

  /**
   * Form and URL parsers decode `%XX` and `+` before they read a name, so
   * `Dig%69ts=1234` or `Digits+=1234` reaches Twilio's parser as `Digits=1234`
   * while the raw text slips past the patterns. Each segment (between `&`, `;`,
   * `?`, `#`, `,` and whitespace) that holds an escape or a `+` is decoded too. If
   * the decoded copy looks secret at all, the whole raw segment is removed,
   * whatever the raw form looks like (fail closed).
   */
  const removeEncodedSecrets = (input: string): string => {
    if (!/%[0-9A-Fa-f]{2}|\+/.test(input)) return input;
    // A removed segment can end inside a quoted value that goes on past the
    // delimiter (`"token":"+,rest"`): then every segment up to the closing
    // quote goes too, since the later passes no longer see the name (HL-13).
    let openQuote: string | undefined;
    return input
      .split(SEGMENT_DELIMITER)
      .map((segment, index) => {
        // Odd indexes are the delimiters the split captured.
        if (index % 2 === 1) return segment;
        if (openQuote !== undefined) {
          if (withoutEscapes(segment).includes(openQuote)) openQuote = undefined;
          return REDACTED;
        }
        if (!/%[0-9A-Fa-f]{2}|\+/.test(segment) || !looksSecret(formDecode(segment))) return segment;
        openQuote = unclosedQuote(segment);
        return REDACTED;
      })
      .join("");
  };

  const text = (input: string): string => {
    let out = input;
    if (exact) out = out.replace(exact, REDACTED);
    out = removeShortSecrets(out);
    if (out.length > MAX_REDACTED_TEXT) out = `${cutBeforeWord(out, MAX_REDACTED_TEXT)} [truncated]`;
    out = removeEncodedSecrets(out);
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
    return out.replace(DIGIT_RUN, (run) => `***${run.slice(-4)}`);
  };

  const value = (input: unknown, depth = 0): unknown => {
    if (typeof input === "string") return text(input);
    if (typeof input === "number") {
      // A number is redacted like its decimal text: phone-shaped, a registered
      // secret, or containing the PIN.
      const decimal = String(input);
      const redacted = text(decimal);
      return redacted === decimal ? input : redacted;
    }
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
