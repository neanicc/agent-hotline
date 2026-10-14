// SMS confirmation codes at rest (HL-13a). The daemon keeps only a salted
// scrypt hash of each code, with a fresh salt per code, so the plaintext code
// cannot be read from the store by a process that opens the database. Codes
// are compared in constant time. This is defence in depth, not a guarantee: a
// 6-digit code has only 10^6 candidates, so a same-user process can brute-force
// a hash offline in hours, sooner on several cores. Twilio's own record of the
// owner's reply (`provider-pull.ts`) is what stops a forged `YES <code>`.
//
// Each hash costs tens of milliseconds, so the text paths hash and compare
// asynchronously (libuv's thread pool): the daemon keeps serving webhooks and
// agent polls meanwhile. Only the one-time migration of plaintext codes saved
// by an older version, while the daemon starts, hashes synchronously.
import { randomBytes, type ScryptOptions, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const SCHEME = "scrypt1";
/** scrypt cost: N = 2^14, r = 8, p = 1 (about 16 MiB and tens of milliseconds per hash). */
const PARAMS: ScryptOptions = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const STORED = /^scrypt1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function derive(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code, salt, KEY_LENGTH, PARAMS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const stored = (salt: Buffer, key: Buffer) =>
  `${SCHEME}$${salt.toString("base64url")}$${key.toString("base64url")}`;

/** `scrypt1$<salt>$<hash>` for `code`, with a fresh 16-byte salt. */
export async function hashCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  return stored(salt, await derive(code, salt));
}

/**
 * `hashCode`, blocking the event loop while it runs. Only for migrating
 * plaintext codes an older version saved, once, while the daemon starts.
 */
export function hashCodeAtStart(code: string): string {
  const salt = randomBytes(16);
  return stored(salt, scryptSync(code, salt, KEY_LENGTH, PARAMS));
}

/** Whether `value` is a stored code hash (and not, say, a plaintext code from an older version). */
export function isCodeHash(value: string): boolean {
  return STORED.test(value);
}

/** True only when `presented` is the code `hash` was made from. Constant time; a malformed hash never matches. */
export async function codeMatches(presented: string, hash: string): Promise<boolean> {
  const parts = STORED.exec(hash);
  if (parts === null) return false;
  const expected = Buffer.from(parts[2] ?? "", "base64url");
  const actual = await derive(presented, Buffer.from(parts[1] ?? "", "base64url"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The hashes among `hashes` that `presented` matches, checked side by side off the event loop. */
export async function matchingHashes(presented: string, hashes: Iterable<string>): Promise<Set<string>> {
  const all = [...new Set(hashes)];
  const matches = await Promise.all(all.map((hash) => codeMatches(presented, hash)));
  return new Set(all.filter((_, index) => matches[index]));
}
