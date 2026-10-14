// SMS confirmation codes at rest (HL-13a). The daemon keeps only a salted
// scrypt hash of each code, with a fresh salt per code, so the plaintext code
// cannot be read from the store by a process that opens the database. Codes
// are compared in constant time. Short codes can still be brute-forced from a
// hash given enough time; the cost below makes that take hours per code on one
// core, longer than an ask waits, and Twilio's own record of the owner's reply
// (`provider-pull.ts`) is what stops a forged `YES <code>` in the first place.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCHEME = "scrypt1";
/** scrypt cost: N = 2^14, r = 8, p = 1 (about 16 MiB and tens of milliseconds per hash). */
const PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const STORED = /^scrypt1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function derive(code: string, salt: Buffer): Buffer {
  return scryptSync(code, salt, KEY_LENGTH, PARAMS);
}

/** `scrypt1$<salt>$<hash>` for `code`, with a fresh 16-byte salt. */
export function hashCode(code: string): string {
  const salt = randomBytes(16);
  return `${SCHEME}$${salt.toString("base64url")}$${derive(code, salt).toString("base64url")}`;
}

/** Whether `value` is a stored code hash (and not, say, a plaintext code from an older version). */
export function isCodeHash(value: string): boolean {
  return STORED.test(value);
}

/** True only when `presented` is the code `stored` was made from. Constant time; a malformed hash never matches. */
export function codeMatches(presented: string, stored: string): boolean {
  const parts = STORED.exec(stored);
  if (parts === null) return false;
  const expected = Buffer.from(parts[2] ?? "", "base64url");
  const actual = derive(presented, Buffer.from(parts[1] ?? "", "base64url"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
