// The owner's PIN: checking it against the scrypt hash in the config, and the
// attempt limits for `verify_pin`. The PIN is never logged or stored; only its
// hash is in the config.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { parsePinHash, pinScryptMaxmem } from "@hotline/core";

/** A PIN is 4 to 8 digits. */
export const PIN_PATTERN = /^\d{4,8}$/;
/** Wrong PINs one call may try before the voice agent must end it. */
export const PIN_ATTEMPTS_PER_CALL = 2;
/**
 * Wrong PINs across all calls of one direction in a rolling hour before every
 * PIN check on calls of that direction fails, right or wrong.
 */
export const PIN_FAILURES_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;
/** How long a call's PIN state is kept. Longer than any call. */
const CALL_STATE_MS = 2 * HOUR_MS;
const MAX_TRACKED_CALLS = 1000;

function scryptAsync(pin: string, salt: Buffer, length: number, logN: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      pin,
      salt,
      length,
      { N: 2 ** logN, r, p, maxmem: pinScryptMaxmem({ logN, r, p }) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A config `owner.pinHash` for `pin`. For `hotline init` (HL-11) and tests. */
export async function hashPin(pin: string, { logN = 15, r = 8, p = 1 } = {}): Promise<string> {
  if (!PIN_PATTERN.test(pin)) throw new TypeError("A PIN is 4 to 8 digits");
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32, logN, r, p);
  return `scrypt$${logN}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** True only when `pin` is 4 to 8 digits and matches `pinHash`, compared in constant time. */
export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;
  const params = parsePinHash(pinHash);
  if (params === undefined) return false;
  const expected = Buffer.from(params.hash, "base64url");
  try {
    const actual = await scryptAsync(
      pin,
      Buffer.from(params.salt, "base64url"),
      expected.length,
      params.logN,
      params.r,
      params.p,
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface PinAttempt {
  verified: boolean;
  /** Wrong PINs this call may still try. */
  attemptsLeft: number;
  /** The voice agent must end the call: attempts used up, or every PIN check is locked for now. */
  endCall: boolean;
}

export interface PinGateOptions {
  /** Checks a PIN, normally `verifyPin(pin, config.owner.pinHash)`. */
  check: (pin: string) => Promise<boolean>;
  clock: () => Date;
  /** Called once with the PIN after it verified, so the redactor can learn it (`addShortSecret`). */
  onVerified?: (pin: string) => void;
}

interface CallPinState {
  failures: number;
  verified: boolean;
  /** When this call first tried a PIN. */
  since: number;
  /** Fixed by the first attempt, so a call cannot move to the other budget. */
  direction: PinCallDirection;
}

/**
 * Which failure budget an attempt draws on. Inbound calls (anyone can spoof the
 * owner's caller ID) have their own, so guessing on inbound calls never locks
 * the PIN on calls Hotline placed to the owner's number.
 */
export type PinCallDirection = "inbound" | "outbound";

/**
 * Tracks which calls proved the PIN, and limits guessing: `PIN_ATTEMPTS_PER_CALL`
 * wrong PINs per call, then `PIN_FAILURES_PER_HOUR` across all calls of one
 * direction, after which every check on that direction fails until the hour has
 * passed. Only this gate, never the voice model, says a call is verified.
 */
export class PinGate {
  readonly #options: PinGateOptions;
  readonly #calls = new Map<string, CallPinState>();
  #failures: Record<PinCallDirection, number[]> = { inbound: [], outbound: [] };

  constructor(options: PinGateOptions) {
    this.#options = options;
  }

  /** Whether `conversationId` gave the right PIN. */
  isVerified(conversationId: string): boolean {
    const state = this.#calls.get(conversationId);
    if (state?.verified !== true) return false;
    return this.#options.clock().getTime() - state.since < CALL_STATE_MS;
  }

  async attempt(conversationId: string, spoken: string, direction: PinCallDirection): Promise<PinAttempt> {
    const now = this.#options.clock().getTime();
    this.#prune(now);
    let state = this.#calls.get(conversationId);
    if (state === undefined) {
      state = { failures: 0, verified: false, since: now, direction };
      this.#calls.set(conversationId, state);
    }
    const failures = this.#failures[state.direction];
    if (state.verified)
      return { verified: true, attemptsLeft: PIN_ATTEMPTS_PER_CALL - state.failures, endCall: false };
    const exhausted = () => ({ verified: false, attemptsLeft: 0, endCall: true });
    if (state.failures >= PIN_ATTEMPTS_PER_CALL || failures.length >= PIN_FAILURES_PER_HOUR) {
      return exhausted();
    }
    // Count the attempt before the slow check, so concurrent guesses cannot exceed the limit.
    state.failures += 1;
    failures.push(now);
    const pin = spoken.replace(/[\s-]/g, "");
    const ok = await this.#options.check(pin).catch(() => false);
    if (ok) {
      state.failures -= 1;
      failures.splice(failures.indexOf(now), 1);
      state.verified = true;
      this.#options.onVerified?.(pin);
      return { verified: true, attemptsLeft: PIN_ATTEMPTS_PER_CALL - state.failures, endCall: false };
    }
    const attemptsLeft = Math.max(0, PIN_ATTEMPTS_PER_CALL - state.failures);
    const locked = failures.length >= PIN_FAILURES_PER_HOUR;
    return {
      verified: false,
      attemptsLeft: locked ? 0 : attemptsLeft,
      endCall: attemptsLeft === 0 || locked,
    };
  }

  #prune(now: number): void {
    // A failure stamped after `now` (the clock moved back) keeps counting.
    for (const key of ["inbound", "outbound"] as const) {
      this.#failures[key] = this.#failures[key].filter((at) => now - at < HOUR_MS);
    }
    for (const [id, state] of this.#calls) {
      if (now - state.since >= CALL_STATE_MS || this.#calls.size > MAX_TRACKED_CALLS) this.#calls.delete(id);
    }
  }
}
