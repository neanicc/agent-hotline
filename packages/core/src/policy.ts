// Call policy building blocks: settings, priority, quiet hours and rate limits.
// Pure: every function takes the time it needs; nothing here reads the clock.
import type { Config } from "./config.js";
import type { Ask, AskKind } from "./contracts.js";

const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Calls placed for one ask (the first call plus retries) before it falls back to a text. */
export const DEFAULT_MAX_CALL_ATTEMPTS = 2;
/** Wait between an unanswered call and its retry. */
export const DEFAULT_RETRY_DELAY_SECONDS = 120;
/** Asks read out in one call. More wait for the next call, highest priority first. */
export const DEFAULT_MAX_ASKS_PER_CALL = 4;
/** A call the daemon never reported as ended is treated as dropped after this long. */
export const DEFAULT_CALL_STUCK_MINUTES = 15;

/** Everything the queue needs to decide who to contact, when and how. */
export interface PolicySettings {
  quietHours: Config["quietHours"];
  rateLimits: Config["rateLimits"];
  /** Asks arriving within this long of each other share one call. */
  batchWindowMs: number;
  maxCallAttempts: number;
  retryDelayMs: number;
  maxAsksPerCall: number;
  callStuckAfterMs: number;
}

/** Policy settings from a parsed config, with the fixed retry and call-size limits. */
export function policySettings(config: Pick<Config, "quietHours" | "rateLimits" | "policy">): PolicySettings {
  return {
    quietHours: config.quietHours,
    rateLimits: config.rateLimits,
    batchWindowMs: config.policy.batchWindowSeconds * 1000,
    maxCallAttempts: DEFAULT_MAX_CALL_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_SECONDS * 1000,
    maxAsksPerCall: DEFAULT_MAX_ASKS_PER_CALL,
    callStuckAfterMs: DEFAULT_CALL_STUCK_MINUTES * MINUTE_MS,
  };
}

/**
 * Order in which asks are read out and texted. Urgent asks first, then by kind: a
 * permission request holds an agent mid-tool-call, a question holds it mid-turn, a
 * stopped agent is idle, and a notification needs nothing back. Ties go to the
 * older ask, then the smaller id, so the order is total and stable.
 */
const KIND_RANK: Record<AskKind, number> = { permission: 0, question: 1, stop: 2, notify: 3 };

export function comparePriority(a: Ask, b: Ask): number {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;
  const byAge = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byAge !== 0) return byAge;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in `timeZone` at instant `at` (0..1439). */
export function localMinutes(timeZone: string, at: Date): number {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(at)) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

function clockMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Whether `at` falls in the owner's quiet hours: from `start` (inclusive) to `end`
 * (exclusive) in local time, wrapping past midnight when `end` is earlier than
 * `start`. Equal `start` and `end` is an empty window.
 */
export function inQuietHours(
  quietHours: Pick<Config["quietHours"], "start" | "end" | "timeZone">,
  at: Date,
): boolean {
  const now = localMinutes(quietHours.timeZone, at);
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** A limit of `perHour` events in any rolling hour and `perDay` in any rolling 24 hours. */
export interface RateLimit {
  perHour: number;
  perDay: number;
}

/**
 * The earliest time at or after `now` when one more event fits under `limit`, given
 * the times (epoch ms) of earlier events. An event at `t` stops counting at
 * `t + window`. Returns `now` when one fits already.
 */
export function nextRateSlot(times: readonly number[], limit: RateLimit, now: number): number {
  let slot = now;
  for (const [window, max] of [
    [HOUR_MS, limit.perHour],
    [DAY_MS, limit.perDay],
  ] as const) {
    const inWindow = times.filter((t) => t > now - window && t <= now).sort((a, b) => a - b);
    if (inWindow.length >= max) {
      // Once the oldest (inWindow.length - max + 1) events age out, one more fits.
      const freeing = inWindow[inWindow.length - max];
      if (freeing !== undefined) slot = Math.max(slot, freeing + window);
    }
  }
  return slot;
}

export function rateLimitAllows(times: readonly number[], limit: RateLimit, now: number): boolean {
  return nextRateSlot(times, limit, now) <= now;
}

export function callLimit(settings: PolicySettings): RateLimit {
  return { perHour: settings.rateLimits.callsPerHour, perDay: settings.rateLimits.callsPerDay };
}

export function textLimit(settings: PolicySettings): RateLimit {
  return { perHour: settings.rateLimits.textsPerHour, perDay: settings.rateLimits.textsPerDay };
}
