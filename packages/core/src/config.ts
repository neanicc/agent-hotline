// The owner's settings file (`config.json` in the hotline home). Pure parsing
// only: the daemon package reads the file. Secrets are not part of it; see
// secrets.ts.
import { z } from "zod";
import { PhoneNumber, VoiceProviderName } from "./contracts.js";

/** Minimum scrypt cost (log2 N) accepted for the PIN hash. */
export const MIN_PIN_SCRYPT_LOG_N = 15;

/**
 * `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` with base64url salt (at least 16 bytes)
 * and hash (at least 32 bytes). Only the hash of the PIN is stored, never the PIN.
 */
const PIN_HASH = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,})\$([A-Za-z0-9_-]{43,})$/;

export interface PinHashParams {
  logN: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

/** Splits a PIN hash string into its parameters, or undefined if it is malformed. */
export function parsePinHash(value: string): PinHashParams | undefined {
  const match = PIN_HASH.exec(value);
  if (!match) return undefined;
  const [, logN, r, p, salt, hash] = match;
  if (!logN || !r || !p || !salt || !hash) return undefined;
  return { logN: Number(logN), r: Number(r), p: Number(p), salt, hash };
}

export const PinHash = z.string().refine((value) => {
  const params = parsePinHash(value);
  return params !== undefined && params.logN >= MIN_PIN_SCRYPT_LOG_N && params.r >= 1 && params.p >= 1;
}, `must be "scrypt$<log2 N>$<r>$<p>$<salt>$<hash>" with log2 N >= ${MIN_PIN_SCRYPT_LOG_N}`);

/** 24-hour local time, `HH:MM`. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)");

export const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "must be an IANA time zone such as America/Toronto");

/** Public tunnel origin: https, no credentials, path, query or fragment. */
export const TunnelUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  // zod runs refinements even after the URL check failed; leave that case to its message.
  if (!URL.canParse(value)) return true;
  const url = new URL(value);
  return url.username === "" && url.password === "" && url.pathname === "/" && !url.search && !url.hash;
}, "must be a bare https origin such as https://example.ngrok.app");

const count = (min: number, max: number, fallback: number) => z.int().min(min).max(max).default(fallback);

export const SmsProviderName = z.enum(["twilio", "fake"]);
export type SmsProviderName = z.infer<typeof SmsProviderName>;

export const SecretStoreChoice = z.enum(["auto", "keychain", "file"]);
export type SecretStoreChoice = z.infer<typeof SecretStoreChoice>;

export const Config = z.strictObject({
  version: z.literal(1),
  owner: z.strictObject({
    /** The only number Hotline calls or texts, and the only one it answers. */
    phoneNumber: PhoneNumber,
    pinHash: PinHash,
  }),
  /** Text instead of calling between `start` and `end` (may wrap past midnight). Always on. */
  quietHours: z.strictObject({
    start: ClockTime.default("22:00"),
    end: ClockTime.default("08:00"),
    timeZone: TimeZone,
    allowUrgentCalls: z.boolean().default(false),
  }),
  /** Always on; a limit cannot be zero or switched off. */
  rateLimits: z
    .strictObject({
      callsPerHour: count(1, 30, 4),
      callsPerDay: count(1, 200, 20),
      textsPerHour: count(1, 60, 10),
      textsPerDay: count(1, 500, 50),
    })
    .prefault({}),
  policy: z
    .strictObject({
      /** Asks arriving within this window share one call. */
      batchWindowSeconds: count(0, 300, 20),
      /** An unanswered ask returns "no answer" after this long. */
      askTimeoutMinutes: count(1, 240, 30),
      /** Away-mode Stop continuations in a row before Hotline lets the agent stop. */
      maxConsecutiveContinuations: count(1, 20, 5),
    })
    .prefault({}),
  voice: z
    .strictObject({
      provider: VoiceProviderName.default("elevenlabs"),
      /** ElevenLabs voice, including a cloned one. Unset means the agent definition's default. */
      voiceId: z.string().min(1).max(100).optional(),
      agentId: z.string().min(1).max(100).optional(),
      agentPhoneNumberId: z.string().min(1).max(100).optional(),
    })
    .prefault({}),
  sms: z
    .strictObject({
      provider: SmsProviderName.default("twilio"),
      /** The Twilio number texts come from. */
      fromNumber: PhoneNumber.optional(),
    })
    .prefault({}),
  tunnel: z
    .strictObject({
      /** Public origin that forwards `/hooks/*` to the daemon. Unset until the tunnel is set up. */
      publicUrl: TunnelUrl.optional(),
    })
    .prefault({}),
  daemon: z.strictObject({ port: count(1024, 65535, 7341) }).prefault({}),
  secrets: z.strictObject({ store: SecretStoreChoice.default("auto") }).prefault({}),
  /** Spoken session names keyed by repository folder name, overriding "<agent> in <folder>". */
  nicknames: z.record(z.string().min(1).max(255), z.string().min(1).max(60)).default({}),
});
/** A parsed config with every default filled in. */
export type Config = z.infer<typeof Config>;
/** What a config file may contain: everything with a default is optional. */
export type ConfigInput = z.input<typeof Config>;

/** Key names that look like credentials. They belong in the secret store, never in the config. */
const SECRET_LIKE_KEY = /token|secret|password|passwd|api[-_]?key|auth|sid|credential|private/i;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    /** One line per problem, `path: message`. Never includes the offending value. */
    readonly issues: readonly string[],
  ) {
    super(issues.length > 0 ? `${message}:\n  ${issues.join("\n  ")}` : message);
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map(String).join(".");
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [`${formatPath(issue.path)}: ${issue.message}`];
    return issue.keys.map((key) => {
      const where = formatPath([...issue.path, key]);
      return SECRET_LIKE_KEY.test(key)
        ? `${where}: looks like a secret; secrets belong in the Keychain or the 0600 secrets file, not the config`
        : `${where}: unknown setting`;
    });
  });
}

/** Validates an already-decoded config object and fills in defaults. Throws ConfigError. */
export function parseConfig(input: unknown): Config {
  const result = Config.safeParse(input);
  if (!result.success) throw new ConfigError("Invalid hotline config", describeIssues(result.error.issues));
  return result.data;
}

/** Parses the text of a config file. Throws ConfigError, without echoing the file's contents. */
export function parseConfigText(text: string): Config {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new ConfigError("Hotline config is not valid JSON", []);
  }
  return parseConfig(decoded);
}
