// Redaction for everything the daemon logs or writes to the audit log. Phone
// numbers keep their last four digits; secrets are removed entirely. This is a
// safety net under the rule that callers never log secrets in the first place,
// so it errs towards removing too much.

export const REDACTED = "[REDACTED]";

/** Object keys whose values are always removed, whatever they hold. */
const SECRET_KEY =
  /token|secret|passw(?:or)?d|pwd|api[-_]?key|private[-_]?key|access[-_]?key|credential|signature|authorization|cookie/i;

/** `name=value`, `name: value` and `"name": "value"` where the name looks like a credential. */
const SECRET_ASSIGNMENT =
  /(["']?[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|private[-_]?key|access[-_]?key|credential|signature|authorization|cookie)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** `Authorization` schemes followed by a credential. */
const AUTH_SCHEME = /\b([Bb]earer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

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
 * Phone-number-like runs: an optional `+` (or `%2B`, its URL encoding), then
 * digits with spaces, dots, dashes or parentheses between them. A run is a phone
 * number when it has 8 to 15 digits after a `+`, or 10 to 15 without one. Dates
 * (8 digits), times, versions and IP addresses stay below those counts.
 */
const PHONE_CANDIDATE = /(?<![A-Za-z0-9_-])(?:\+|%2[Bb])?\(?\d[\d\s().-]{5,22}\d(?![A-Za-z0-9_])/g;

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
  /** Deeply redacts strings in a JSON-like value; values under secret-looking keys are removed. */
  value(input: unknown): unknown;
  /** Also removes this exact value wherever it appears (values shorter than 8 characters are ignored). */
  addSecret(secret: string): void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_DEPTH = 12;

/** A redactor that also removes `knownSecrets`, such as the daemon's own API token. */
export function createRedactor(knownSecrets: Iterable<string> = []): Redactor {
  const secrets = new Set<string>();
  let exact: RegExp | undefined;

  const addSecret = (secret: string) => {
    if (secret.length < 8 || secrets.has(secret)) return;
    secrets.add(secret);
    // Longest first, so a secret that contains another is removed whole.
    const alternatives = [...secrets].sort((a, b) => b.length - a.length).map(escapeRegExp);
    exact = new RegExp(alternatives.join("|"), "g");
  };
  for (const secret of knownSecrets) addSecret(secret);

  const text = (input: string): string => {
    let out = input;
    if (exact) out = out.replace(exact, REDACTED);
    out = out.replace(PRIVATE_KEY_BLOCK, `${REDACTED} private key`);
    out = out.replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`);
    out = out.replace(SECRET_ASSIGNMENT, (_match, name: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${name}${quote}${REDACTED}${quote}`;
    });
    for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, REDACTED);
    out = out.replace(OPAQUE_RUN, (run) =>
      run !== REDACTED && hasLetterAndDigit(run) && !NOT_SECRET_IDS.test(run) ? REDACTED : run,
    );
    return out.replace(PHONE_CANDIDATE, maskPhone);
  };

  const value = (input: unknown, depth = 0): unknown => {
    if (typeof input === "string") return text(input);
    if (input === null || typeof input !== "object") return input;
    if (depth >= MAX_DEPTH) return REDACTED;
    if (Array.isArray(input)) return input.map((item) => value(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const secretKey = SECRET_KEY.test(key) && item !== null && typeof item !== "boolean";
      out[key] = secretKey ? REDACTED : value(item, depth + 1);
    }
    return out;
  };

  return { text, value: (input) => value(input), addSecret };
}
