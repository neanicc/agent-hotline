import { describe, expect, it } from "vitest";
import {
  comparePriority,
  DEFAULT_CALL_STUCK_MINUTES,
  DEFAULT_MAX_ASKS_PER_CALL,
  DEFAULT_MAX_CALL_ATTEMPTS,
  DEFAULT_RETRY_DELAY_SECONDS,
  inQuietHours,
  localMinutes,
  nextRateSlot,
  rateLimitAllows,
} from "../src/index.js";
import { HOUR, MINUTE, makeAsk, makeSettings, NOON } from "./queue-harness.js";

describe("policySettings", () => {
  it("takes the config's limits and the fixed retry rules", () => {
    const settings = makeSettings({ batchWindowSeconds: 45 });
    expect(settings.batchWindowMs).toBe(45_000);
    expect(settings.rateLimits).toEqual({
      callsPerHour: 4,
      callsPerDay: 20,
      textsPerHour: 10,
      textsPerDay: 50,
    });
    expect(settings.maxCallAttempts).toBe(DEFAULT_MAX_CALL_ATTEMPTS);
    expect(settings.retryDelayMs).toBe(DEFAULT_RETRY_DELAY_SECONDS * 1000);
    expect(settings.maxAsksPerCall).toBe(DEFAULT_MAX_ASKS_PER_CALL);
    expect(settings.callStuckAfterMs).toBe(DEFAULT_CALL_STUCK_MINUTES * MINUTE);
  });
});

describe("quiet hours", () => {
  const night = { start: "22:00", end: "08:00", timeZone: "America/Toronto" };

  it("reads local time in the owner's zone, across daylight saving", () => {
    expect(localMinutes("America/Toronto", new Date("2026-10-13T16:00:00Z"))).toBe(12 * 60); // EDT
    expect(localMinutes("America/Toronto", new Date("2026-12-13T16:00:00Z"))).toBe(11 * 60); // EST
    expect(localMinutes("Asia/Kolkata", new Date("2026-10-13T16:00:00Z"))).toBe(21 * 60 + 30);
    expect(localMinutes("UTC", new Date("2026-10-13T00:00:00Z"))).toBe(0);
  });

  it("wraps past midnight with start inclusive and end exclusive", () => {
    const at = (iso: string) => inQuietHours(night, new Date(iso));
    expect(at("2026-10-14T01:59:00Z")).toBe(false); // 21:59 EDT
    expect(at("2026-10-14T02:00:00Z")).toBe(true); // 22:00
    expect(at("2026-10-14T07:30:00Z")).toBe(true); // 03:30
    expect(at("2026-10-14T11:59:00Z")).toBe(true); // 07:59
    expect(at("2026-10-14T12:00:00Z")).toBe(false); // 08:00
  });

  it("handles a same-day window and treats equal start and end as empty", () => {
    const lunch = { start: "12:00", end: "13:00", timeZone: "UTC" };
    expect(inQuietHours(lunch, new Date("2026-10-13T12:30:00Z"))).toBe(true);
    expect(inQuietHours(lunch, new Date("2026-10-13T13:00:00Z"))).toBe(false);
    expect(inQuietHours(lunch, new Date("2026-10-13T11:59:00Z"))).toBe(false);
    const empty = { start: "09:00", end: "09:00", timeZone: "UTC" };
    expect(inQuietHours(empty, new Date("2026-10-13T09:00:00Z"))).toBe(false);
  });
});

describe("rate limits", () => {
  const limit = { perHour: 2, perDay: 3 };

  it("allows until the hourly count is reached, then frees a slot as the oldest ages out", () => {
    expect(rateLimitAllows([], limit, NOON)).toBe(true);
    expect(rateLimitAllows([NOON - 10 * MINUTE], limit, NOON)).toBe(true);
    const two = [NOON - 50 * MINUTE, NOON - 10 * MINUTE];
    expect(rateLimitAllows(two, limit, NOON)).toBe(false);
    expect(nextRateSlot(two, limit, NOON)).toBe(NOON + 10 * MINUTE);
    expect(rateLimitAllows(two, limit, NOON + 10 * MINUTE)).toBe(true);
  });

  it("applies the daily count over a rolling 24 hours", () => {
    const three = [NOON - 20 * HOUR, NOON - 5 * HOUR, NOON - 2 * HOUR];
    expect(rateLimitAllows(three, limit, NOON)).toBe(false);
    expect(nextRateSlot(three, limit, NOON)).toBe(NOON + 4 * HOUR);
  });

  it("counts sends stamped after now, as after the clock moved back", () => {
    const ahead = [NOON + MINUTE];
    expect(rateLimitAllows(ahead, { perHour: 1, perDay: 5 }, NOON)).toBe(false);
    expect(nextRateSlot(ahead, { perHour: 1, perDay: 5 }, NOON)).toBe(NOON + MINUTE + HOUR);
  });

  it("waits for whichever limit frees last", () => {
    const times = [NOON - 23 * HOUR, NOON - 30 * MINUTE, NOON - 20 * MINUTE];
    expect(nextRateSlot(times, limit, NOON)).toBe(NOON + HOUR);
    expect(nextRateSlot(times, { perHour: 2, perDay: 2 }, NOON)).toBe(NOON + 23 * HOUR + 30 * MINUTE);
  });
});

describe("comparePriority", () => {
  it("orders urgent first, then permission, question, stop, notify, then oldest, then id", () => {
    const at = (offset: number) => NOON + offset * MINUTE;
    const asks = [
      makeAsk({ id: "notify", kind: "notify", createdAt: at(0) }),
      makeAsk({ id: "stop", kind: "stop", createdAt: at(0) }),
      makeAsk({ id: "question-new", createdAt: at(2) }),
      makeAsk({ id: "question-b", createdAt: at(1) }),
      makeAsk({ id: "question-a", createdAt: at(1) }),
      makeAsk({ id: "permission", kind: "permission", createdAt: at(3) }),
      makeAsk({ id: "urgent-stop", kind: "stop", urgent: true, createdAt: at(4) }),
    ];
    expect(asks.sort(comparePriority).map((ask) => ask.id)).toEqual([
      "urgent-stop",
      "permission",
      "question-a",
      "question-b",
      "question-new",
      "stop",
      "notify",
    ]);
  });
});
