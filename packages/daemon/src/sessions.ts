// Session lifetime (HL-10). An agent normally ends its own session (the MCP
// server on exit), but one that is killed never does, and hook sessions never
// end at all. So the daemon ends sessions nobody has heard from in a while, and
// caps how many can be live at once: the owner hears every live session on a
// status call, and a looping or prompt-injected agent must not be able to
// flood that list.
import type { Session } from "@hotline/core";
import type { HotlineStore } from "./store.js";

/** A session with no open ask that nobody heard from for this long is ended. */
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
/** Live sessions at once. A new one past this gets 429; an existing one can always refresh. */
export const MAX_LIVE_SESSIONS = 20;
/**
 * At the cap, a session idle this long with nothing open makes room for a new
 * one (a killed agent's, say), so restarts cannot lock registrations out for
 * hours; a looping agent cannot evict sessions that are in use.
 */
export const EVICT_IDLE_MS = 15 * 60 * 1000;

/**
 * Ends the longest-idle live session that has no open ask and no queued
 * instruction, if it has been idle for `EVICT_IDLE_MS`. Returns whether one was ended.
 */
export function evictIdleSession(store: HotlineStore, now: Date): boolean {
  const busy = new Set([
    ...store.listAsks(OPEN_STATUSES).map((ask) => ask.sessionId),
    ...store.listInstructions({ status: "queued" }).map((instruction) => instruction.sessionId),
  ]);
  const idlest = liveSessions(store)
    .filter((session) => !busy.has(session.id))
    .filter((session) => now.getTime() - Date.parse(session.lastSeenAt) >= EVICT_IDLE_MS)
    .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];
  return idlest !== undefined && endSession(store, idlest.id, now, "evicted");
}
/** A queued instruction no session picked up within this long is dropped. */
export const INSTRUCTION_TTL_MS = 6 * 60 * 60 * 1000;

const OPEN_STATUSES = ["pending", "in-flight"] as const;

/** Live (not ended) sessions, oldest registration first: the order a status call numbers them in. */
export function liveSessions(store: HotlineStore): Session[] {
  return store
    .listSessions()
    .filter((session) => session.state !== "ended")
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.id.localeCompare(b.id));
}

/**
 * Ends a session: cancels its open asks (nobody should be called for an agent
 * that left) and drops its queued instructions. `by` says who ended it, for the
 * audit log. Returns false when it is unknown or already ended.
 */
export function endSession(
  store: HotlineStore,
  sessionId: string,
  now: Date,
  by: "agent" | "idle" | "evicted",
): boolean {
  const session = store.getSession(sessionId);
  if (session === undefined || session.state === "ended") return false;
  for (const ask of store.listAsks(OPEN_STATUSES).filter((open) => open.sessionId === sessionId)) {
    if (store.setAskStatus(ask.id, "cancelled")) {
      store.appendAudit("ask.cancelled", { kind: ask.kind, by: "session-end" }, now, {
        askId: ask.id,
        sessionId,
      });
    }
  }
  const dropped = store.dropInstructions({ sessionId }, "session-ended", now);
  store.putSession({
    ...(store.getSession(sessionId) ?? session),
    state: "ended",
    lastSeenAt: now.toISOString(),
  });
  store.appendAudit(
    by === "agent" ? "session.ended" : by === "idle" ? "session.expired" : "session.evicted",
    dropped.length > 0 ? { instructionsDropped: dropped.length } : {},
    now,
    { sessionId },
  );
  return true;
}

/**
 * Drops queued instructions older than `INSTRUCTION_TTL_MS`, then ends every
 * session idle for `SESSION_IDLE_MS` with no open ask and no queued
 * instruction. Cheap enough to run before each registration and status read.
 */
export function expireStaleSessions(store: HotlineStore, now: Date): void {
  const expired = store.dropInstructions(
    { receivedBefore: new Date(now.getTime() - INSTRUCTION_TTL_MS) },
    "expired",
    now,
  );
  for (const instruction of expired) {
    store.appendAudit("instruction.expired", {}, now, { sessionId: instruction.sessionId });
  }
  // A session with an open ask or an instruction still waiting for it is not idle.
  const busy = new Set([
    ...store.listAsks(OPEN_STATUSES).map((ask) => ask.sessionId),
    ...store.listInstructions({ status: "queued" }).map((instruction) => instruction.sessionId),
  ]);
  for (const session of liveSessions(store)) {
    if (busy.has(session.id)) continue;
    if (now.getTime() - Date.parse(session.lastSeenAt) >= SESSION_IDLE_MS) {
      endSession(store, session.id, now, "idle");
    }
  }
}
