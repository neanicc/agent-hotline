// Seeds a temporary daemon store with fake calls and text events for the cost
// estimate tests. Fake ids only; nothing leaves the machine.
import type { CallRecord } from "@hotline/core";
import { openStore } from "@hotline/daemon";
import type { Usage } from "../src/cost.js";

export const NOW = new Date("2026-10-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function call(id: string, startedAt: Date, durationSeconds: number, direction: "outbound" | "inbound") {
  const record: CallRecord = {
    id,
    provider: "fake",
    direction,
    providerIds: {},
    askIds: direction === "outbound" ? [`ask-${id}`] : [],
    outcome: durationSeconds > 0 ? "answered" : "no-answer",
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + durationSeconds * 1000).toISOString(),
    durationSeconds,
    costEstimateCents: 0,
  };
  return record;
}

/** A typical month: three calls in the window (6 billed minutes), texts both ways, and older usage. */
export async function seedTypicalUsage(path: string): Promise<void> {
  const store = await openStore(path);
  try {
    store.putCall(call("c1", ago(2), 90, "outbound")); // 2 billed minutes
    store.putCall(call("c2", ago(5), 0, "outbound")); // no pickup: 0 minutes
    store.putCall(call("c3", ago(10), 200, "inbound")); // 4 billed minutes
    store.putCall(call("c-old", ago(40), 600, "outbound")); // outside the window
    for (const days of [1, 3, 29]) store.appendAudit("text.sent", { reason: "fake" }, ago(days));
    store.appendAudit("text.sent", { reason: "fake" }, ago(31)); // outside the window
    store.appendAudit("sms.interrupted", { count: 1 }, ago(4));
    for (const days of [1, 2]) store.appendAudit("sms.received", { reply: "yes" }, ago(days));
    store.appendAudit("sms.other-sender", {}, ago(6));
    store.appendAudit("call.placed", { asks: 1 }, ago(2)); // not a text
  } finally {
    store.close();
  }
}

/** What `seedTypicalUsage` amounts to over the 30 days before `NOW`. */
export const TYPICAL: Usage = {
  callsPlaced: 2,
  callsReceived: 1,
  billedMinutes: 6,
  textsSent: 4,
  replies: 2,
  textsReceived: 3,
};
