// The inbound line (HL-10, plan section 4D): the owner calls the Hotline number,
// gives the PIN, hears what every live session is doing, and can leave a
// session an instruction, delivered at its next ask, inbox read or Stop hook.
// The owner can also text `status`.
//
// Safety rules this file keeps (AGENTS.md):
// - The PIN comes first. The routes (`elevenlabs-webhook.ts`) refuse
//   `get_status` and `send_instruction` until this call passed `verify_pin`,
//   and serve nobody but a call with the owner's number on it. A spoofed
//   caller ID still needs the PIN; a lockout is texted to the owner here.
// - Instructions are the owner's own words. `send_instruction` only holds one;
//   it is queued once the post-call transcript backs it (`confirmInstructions`:
//   the owner's whole utterance after the PIN, exactly one session named, read
//   back and confirmed with a yes, not taken back). Each is confirmed on its
//   own: nothing else the model sent can excuse a turn of the transcript.
//   It is redacted and capped before it is stored, with the matching excerpt.
//   Nothing an agent writes can become one. An instruction not confirmed is
//   dropped, and the owner is texted that it did not go through.
// - Sessions are named by number on the call. The numbers are the ones the
//   status read out on that call; an instruction for a number the call never
//   heard, or a session that ended since, is refused.
// - Minimum data leaves the machine. The status is short: per session its
//   spoken name, state, open asks by kind, the latest ask's (already redacted)
//   text cut short, queued instructions and when it was last heard from. Agent
//   text is fenced as `<agent_text>` for the voice model, like ask text.
//   The routes redact and cut it again.
// - Inbound calls answer no asks (call orchestration accepts `submit_answer`
//   only on calls Hotline placed); the plan's inbound line reads status and
//   takes instructions only.
//
// Logs and audit entries carry ids, counts and results, never words.
import { createHash, randomUUID } from "node:crypto";
import type { Ask, AskKind, Session } from "@hotline/core";
import { type PostCallEvent, type SmsProvider, speakableName } from "@hotline/providers";
import { z } from "zod";
import type { SendInstructionResult, ToolCall, VoiceInstruction } from "./elevenlabs-webhook.js";
import { confirmInstructions, type HeldInstruction, plainInstruction } from "./instruction-confirm.js";
import type { OrchestratorLog } from "./orchestrator-state.js";
import { CALL_CENTS_PER_MINUTE } from "./orchestrator-voice.js";
import type { PinCallDirection } from "./pin.js";
import { expireStaleSessions, liveSessions } from "./sessions.js";
import type { HotlineStore } from "./store.js";

/** Instructions one call may give. */
export const MAX_INSTRUCTIONS_PER_CALL = 5;
/** Instructions waiting for one session (queued or held on a call). */
export const MAX_INSTRUCTIONS_PER_SESSION = 3;
/** Instructions waiting across all sessions. */
export const MAX_INSTRUCTIONS_TOTAL = 20;
/** Longest instruction stored, after redaction. */
export const MAX_INSTRUCTION_LENGTH = 1000;
/** A held instruction (or a call's session numbers) is forgotten after this long without a post-call event. */
const CALL_MEMORY_MS = 60 * 60 * 1000;
/** Calls remembered at once; past it the oldest are forgotten (their instructions are not queued). */
const MAX_CALLS = 1000;
/**
 * `daemon_state` key where runs before HL-13b saved how many instructions each
 * call held (counts only). Read once on start, to tell the owner those were lost.
 */
export const HELD_STATE_KEY = "inbound.held";
/** `daemon_state` key of when each direction's lockout text last went out (epoch ms). */
export const LOCKOUT_TEXTED_KEY = "inbound.lockout-texted-at";
/** At most one lockout text per direction in this window. */
const LOCKOUT_TEXT_MS = 60 * 60 * 1000;

/**
 * A call's memory as saved in the store (`inbound_calls`), so held
 * instructions survive a restart (HL-13b). The instruction and the owner's
 * words are redacted before they are saved; nicknames already are.
 */
const SavedCall = z.strictObject({
  sessionIds: z.array(z.string().min(1)),
  nicknames: z.array(z.string()),
  held: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        instruction: z.string(),
        ownerWords: z.string(),
        sessionNumber: z.number().int().positive(),
        listed: z.array(z.string()),
        sessionId: z.string().min(1),
        receivedAt: z.iso.datetime(),
        done: z.boolean().optional(),
      }),
    )
    .max(MAX_INSTRUCTIONS_PER_CALL),
});
/** Status lengths: what the voice route allows (1500) and one SMS (1600), with room for the cut marker. */
const STATUS_BUDGET = 1400;
const LATEST_LENGTH = 120;

const ASK_WORDS: Record<AskKind, [string, string]> = {
  question: ["question", "questions"],
  permission: ["permission request", "permission requests"],
  stop: ["finished turn", "finished turns"],
  notify: ["notification", "notifications"],
};
const STATE_WORDS: Record<Session["state"], string> = {
  working: "working",
  "waiting-on-human": "waiting on you",
  idle: "idle",
  ended: "ended",
};

export const INBOUND_TEXTS = {
  noSessions: "No live sessions right now.",
  lockout: (direction: PinCallDirection) =>
    direction === "inbound"
      ? "Hotline: too many wrong PINs were tried on calls to your Hotline number. Inbound calls are locked for up to an hour. If that was not you, someone may be calling with your number."
      : "Hotline: too many wrong PINs were given on calls Hotline placed to you. PIN approvals by phone are locked for up to an hour.",
  notQueued: (count: number) =>
    `Hotline: ${count === 1 ? "an instruction" : `${count} instructions`} from your call ${count === 1 ? "was" : "were"} not passed on: ${count === 1 ? "it" : "they"} could not be confirmed from the call, or the session ended. Call again if it still matters.`,
  queued: (count: number) =>
    `Hotline: ${count === 1 ? "your instruction is" : `your ${count} instructions are`} queued. ${count === 1 ? "It reaches" : "Each reaches"} its agent at its next question or when it finishes its turn.`,
  othersQueued: (count: number) => `${count === 1 ? "The other one was" : `The other ${count} were`} queued.`,
} as const;

/** One plain line: no control or format characters, no fence or variable delimiters. */
function plain(text: string, max: number): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function count(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

interface CallMemory {
  /** The sessions the last status on this call read out, in order: session N is `sessionIds[N - 1]`. */
  sessionIds: string[];
  nicknames: string[];
  held: (HeldInstruction & { id: string; sessionId: string; receivedAt: Date; done?: boolean })[];
  expires: number;
}

export interface InboundLineOptions {
  store: HotlineStore;
  clock: () => Date;
  /** The daemon's redactor. */
  redact: (text: string) => string;
  /** Texts the owner (lockouts, instructions that did not go through). */
  sms?: SmsProvider;
  log?: () => OrchestratorLog;
  /** For tests; defaults to random UUIDs. */
  newId?: () => string;
}

export class InboundLine {
  readonly #options: InboundLineOptions;
  readonly #store: HotlineStore;
  /** Per conversation: the session numbers its status read out, and its held instructions. */
  readonly #calls = new Map<string, CallMemory>();
  readonly #lockoutTexted: Partial<Record<PinCallDirection, number>> = {};
  /** Saved calls that could not be read back: their instructions are lost. */
  #unreadable = 0;

  constructor(options: InboundLineOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#restore();
  }

  /**
   * Loads the calls a previous run saved, with the instructions they hold, so
   * their post-call events still confirm them (HL-13b). Done at construction,
   * before any route serves. A saved call that does not read back is deleted
   * and counted, for `recover` to tell the owner.
   */
  #restore(): void {
    for (const saved of this.#store.listInboundCalls()) {
      const parsed = SavedCall.safeParse(saved.record);
      if (!parsed.success || !Number.isFinite(saved.expiresAtMs)) {
        this.#store.deleteInboundCall(saved.conversationId);
        // How many it held, when that much can be read (a call holds at most five); else one.
        const held = (saved.record as { held?: unknown } | undefined)?.held;
        this.#unreadable += Array.isArray(held) ? Math.min(held.length, MAX_INSTRUCTIONS_PER_CALL) : 1;
        continue;
      }
      const { sessionIds, nicknames, held } = parsed.data;
      this.#calls.set(saved.conversationId, {
        sessionIds,
        nicknames,
        held: held.map(({ done, ...h }) => ({
          ...h,
          receivedAt: new Date(h.receivedAt),
          ...(done === undefined ? {} : { done }),
        })),
        expires: saved.expiresAtMs,
      });
    }
  }

  /**
   * Saves one call's memory, so a restart keeps its session numbers and held
   * instructions. The words are redacted first; nothing else in it is words.
   */
  #save(conversationId: string, memory: CallMemory): void {
    const { redact } = this.#options;
    const record: z.input<typeof SavedCall> = {
      sessionIds: memory.sessionIds,
      nicknames: memory.nicknames,
      held: memory.held.map((h) => ({
        id: h.id,
        instruction: redact(h.instruction),
        ownerWords: redact(h.ownerWords),
        sessionNumber: h.sessionNumber,
        listed: [...h.listed],
        sessionId: h.sessionId,
        receivedAt: h.receivedAt.toISOString(),
        ...(h.done === undefined ? {} : { done: h.done }),
      })),
    };
    this.#store.putInboundCall(conversationId, memory.expires, SavedCall.parse(record));
  }

  /**
   * On start: tells the owner about instructions that can no longer be
   * confirmed. Those are a saved call that did not read back, calls whose
   * post-call event did not come in time (forgotten here as at any other
   * time), and counts a run before HL-13b saved when it stopped (it kept
   * no instructions). Audits them and texts the owner once.
   */
  async recover(): Promise<void> {
    const now = this.#options.clock();
    const saved = this.#store.getState(HELD_STATE_KEY);
    if (saved !== undefined) this.#store.putState(HELD_STATE_KEY, {});
    const counts =
      typeof saved === "object" && saved !== null ? Object.values(saved as Record<string, unknown>) : [];
    const restarted = counts.reduce<number>((sum, n) => sum + (typeof n === "number" && n > 0 ? n : 0), 0);
    const unreadable = this.#unreadable;
    this.#unreadable = 0;
    if (restarted > 0) {
      this.#store.appendAudit(
        "voice.instruction-unconfirmed",
        { reason: "restarted", count: restarted },
        now,
      );
    }
    if (unreadable > 0) {
      this.#store.appendAudit(
        "voice.instruction-unconfirmed",
        { reason: "unreadable", count: unreadable },
        now,
      );
    }
    const lost = restarted + unreadable;
    if (lost > 0) await this.#text(INBOUND_TEXTS.notQueued(lost), "instruction-not-queued", now);
    await this.#forget(now);
  }

  /** The live sessions, ended stale ones first, in the order a status numbers them. */
  #sessions(now: Date): Session[] {
    expireStaleSessions(this.#store, now);
    return liveSessions(this.#store);
  }

  /** What a status says about one session, with agent text fenced for the voice model or not. */
  #describe(session: Session, number: number, now: Date, fence: boolean): string {
    const { redact } = this.#options;
    const wrap = (text: string) => (fence ? `<agent_text>${text}</agent_text>` : text);
    const name = wrap(plain(speakableName(redact(session.nickname)) || "an unnamed session", 60));
    // Counts from every open ask, however old; the latest text from the newest one.
    const asks = this.#store.listSessionAsks(session.id, 1);
    const open = this.#store
      .listAsks(["pending", "in-flight"])
      .filter((ask) => ask.sessionId === session.id && Date.parse(ask.expiresAt) > now.getTime());
    const parts = [`Session ${number}, ${name}: ${STATE_WORDS[session.state]}`];
    const byKind = (["question", "permission", "stop", "notify"] as const)
      .map((kind) => [kind, open.filter((ask: Ask) => ask.kind === kind).length] as const)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => count(n, ASK_WORDS[kind]));
    if (byKind.length > 0) parts[0] += `, open: ${byKind.join(" and ")}`;
    const latest = asks[0];
    // Agent-written, so only on the voice path, fenced; the SMS carries state and counts only.
    if (fence && latest !== undefined)
      parts.push(`Latest: ${wrap(plain(redact(latest.text), LATEST_LENGTH))}`);
    const queued = this.#store.listInstructions({ sessionId: session.id, status: "queued" }).length;
    if (queued > 0) parts.push(`${count(queued, ["instruction", "instructions"])} from you waiting for it`);
    parts.push(`Last heard from ${ago(now.getTime() - Date.parse(session.lastSeenAt))}`);
    return `${parts.join(". ")}.`;
  }

  /**
   * Every live session, numbered, cut to the budget with a count of the rest.
   * `included` is the sessions actually read out, in order.
   */
  #status(
    sessions: readonly Session[],
    now: Date,
    fence: boolean,
    head: string,
    /** The number session `index` of `sessions` is read out with; default its position. */
    numberOf: (index: number) => number = (index) => index + 1,
  ): { text: string; included: Session[] } {
    if (sessions.length === 0) return { text: INBOUND_TEXTS.noSessions, included: [] };
    let text = head;
    const included: Session[] = [];
    for (const [index, session] of sessions.entries()) {
      const line = this.#describe(session, numberOf(index), now, fence);
      const rest = sessions.length - index;
      if (text.length + line.length + 1 > STATUS_BUDGET) {
        text += ` ${rest} more ${rest === 1 ? "session is" : "sessions are"} not read out.`;
        break;
      }
      text += fence ? ` ${line}` : `\n${line}`;
      included.push(session);
    }
    return { text, included };
  }

  /** `get_status`, after the PIN: every live session, numbered as `send_instruction` will name them. */
  getStatus(call: ToolCall): string {
    const now = call.receivedAt;
    const live = this.#sessions(now);
    const memory = this.#memory(call.conversationId, now);
    this.#store.appendAudit("voice.status", { sessions: live.length }, now);
    // Numbers stay put for the whole call: a session keeps the number it was
    // first read out with, a new one gets the next unused number, and an
    // ended one's number is never given to another. So "session 2" means
    // the same session however many times the owner asks for the status.
    const known = (session: Session) => memory.sessionIds.indexOf(session.id);
    const sessions = [...live].sort((a, b) => {
      const [x, y] = [known(a), known(b)];
      return (x < 0 ? Number.POSITIVE_INFINITY : x) - (y < 0 ? Number.POSITIVE_INFINITY : y);
    });
    const firstNew = sessions.findIndex((session) => known(session) < 0);
    const numberOf = (index: number) => {
      const session = sessions[index] as Session;
      const at = known(session);
      return at >= 0 ? at + 1 : memory.sessionIds.length + 1 + (index - firstNew);
    };
    const head = `${count(live.length, ["live session", "live sessions"])}.`;
    const { text, included } = this.#status(sessions, now, true, head, numberOf);
    // Only sessions this call heard read out get a number its instructions may use.
    for (const session of included) {
      if (known(session) >= 0) continue;
      memory.sessionIds.push(session.id);
      memory.nicknames.push(speakableName(this.#options.redact(session.nickname)));
    }
    // Saved so the numbers still hold for this call after a restart.
    this.#save(call.conversationId, memory);
    return text;
  }

  /** The reply to the owner's `status` text. */
  statusText(): string {
    const now = this.#options.clock();
    const sessions = this.#sessions(now);
    this.#store.appendAudit("sms.status", { sessions: sessions.length }, now);
    const head = `Hotline: ${count(sessions.length, ["live session", "live sessions"])}.`;
    const { text } = this.#status(sessions, now, false, head);
    return text === INBOUND_TEXTS.noSessions ? `Hotline: ${text}` : text;
  }

  /**
   * `send_instruction`, after the PIN: holds the instruction until the post-call
   * transcript confirms it. `queued` tells the voice agent it was taken.
   */
  sendInstruction(voice: VoiceInstruction): SendInstructionResult {
    const result = this.#hold(voice);
    const call = this.#calls.get(voice.conversationId);
    const sessionId = call?.sessionIds[voice.sessionNumber - 1];
    this.#store.appendAudit(
      "voice.instruction",
      { result },
      voice.receivedAt,
      result === "queued" && sessionId !== undefined ? { sessionId } : {},
    );
    return result;
  }

  #hold(voice: VoiceInstruction): SendInstructionResult {
    const now = voice.receivedAt;
    // Forget expired calls (and the oldest past the cap) first, so this call's
    // memory is read only after, never pushed to once it was let go. Calls
    // whose post-call event never came then stop counting against the caps.
    void this.#forget(now, voice.conversationId);
    const call = this.#calls.get(voice.conversationId);
    // Only a number the status on this call read out.
    const sessionId =
      call !== undefined && call.expires > now.getTime()
        ? call.sessionIds[voice.sessionNumber - 1]
        : undefined;
    const session = sessionId === undefined ? undefined : this.#store.getSession(sessionId);
    if (call === undefined || session === undefined || session.state === "ended") return "unknown-session";
    if (voice.instruction.trim() === "" || voice.ownerWords.trim() === "") return "invalid";
    const held = [...this.#calls.values()].flatMap((memory) => memory.held.filter((h) => !h.done));
    const queued = this.#store.listInstructions({ status: "queued" });
    const forSession = (list: readonly { sessionId: string }[]) =>
      list.filter((i) => i.sessionId === session.id).length;
    if (
      call.held.length >= MAX_INSTRUCTIONS_PER_CALL ||
      forSession(held) + forSession(queued) >= MAX_INSTRUCTIONS_PER_SESSION ||
      held.length + queued.length >= MAX_INSTRUCTIONS_TOTAL
    ) {
      return "too-many";
    }
    call.held.push({
      // Stable from here on, so a retried post-call event stores it once.
      id: this.#options.newId?.() ?? randomUUID(),
      instruction: voice.instruction,
      ownerWords: voice.ownerWords,
      sessionNumber: voice.sessionNumber,
      // A snapshot: the names the owner had heard when they spoke.
      listed: [...call.nicknames],
      sessionId: session.id,
      receivedAt: now,
    });
    try {
      // Saved before the voice agent hears "queued", so a restart keeps it.
      this.#save(voice.conversationId, call);
    } catch (error) {
      call.held.pop();
      throw error;
    }
    return "queued";
  }

  /** This call's memory, created if new; forgets expired calls, and the oldest past `MAX_CALLS`. */
  #memory(conversationId: string, now: Date): CallMemory {
    void this.#forget(now, conversationId);
    let memory = this.#calls.get(conversationId);
    if (memory === undefined) {
      memory = { sessionIds: [], nicknames: [], held: [], expires: now.getTime() + CALL_MEMORY_MS };
      this.#calls.set(conversationId, memory);
    }
    return memory;
  }

  /**
   * Forgets calls past `CALL_MEMORY_MS` (their instructions are never queued),
   * and the oldest past `MAX_CALLS`, in memory and in the store. The returned
   * promise settles once the owner was texted about lost instructions; it
   * never rejects.
   */
  #forget(now: Date, keep?: string): Promise<void> {
    let lost = 0;
    for (const [id, memory] of this.#calls) {
      // The call being served is never evicted for space, only when it expired.
      const spare = id === keep || this.#calls.size <= MAX_CALLS;
      if (memory.expires > now.getTime() && spare) continue;
      this.#calls.delete(id);
      this.#store.deleteInboundCall(id);
      // The voice agent told the owner these were queued: say they were not.
      for (const held of memory.held.filter((h) => !h.done)) {
        this.#store.appendAudit("voice.instruction-unconfirmed", { reason: "no post-call event" }, now, {
          sessionId: held.sessionId,
        });
        lost += 1;
      }
    }
    if (lost === 0) return Promise.resolve();
    return this.#text(INBOUND_TEXTS.notQueued(lost), "instruction-not-queued", now).catch((error: unknown) =>
      this.#options.log?.().warn({ err: error }, "could not text about instructions not passed on"),
    );
  }

  /**
   * A verified post-call webhook. Records an inbound call, then confirms the
   * call's held instructions against its transcript and queues the confirmed
   * ones. Throws to have ElevenLabs retry; what was already queued is not queued again.
   */
  async postCall(
    event: Exclude<PostCallEvent, { type: "other" }>,
    receivedAt: Date,
    placedByHotline: boolean,
  ): Promise<void> {
    if (event.type === "transcription" && event.direction === "inbound" && !placedByHotline) {
      this.#recordInboundCall(event, receivedAt);
    }
    const memory = this.#calls.get(event.conversationId);
    if (memory === undefined || memory.held.length === 0) {
      this.#calls.delete(event.conversationId);
      this.#store.deleteInboundCall(event.conversationId);
      return;
    }
    let notQueued = 0;
    let queued = 0;
    // All of the call's instructions are judged together against the same
    // transcript (only one confirmed on its own can excuse a turn), every time,
    // so a retry after a failure reaches the same verdicts. Each is crossed off
    // once handled, and its stable id stops a second copy being stored.
    const checks =
      event.type === "transcription"
        ? confirmInstructions(event.transcript, memory.held)
        : memory.held.map(() => ({ confirmed: false as const, reason: "the call never connected" }));
    for (const [index, held] of memory.held.entries()) {
      if (held.done) continue;
      const check = checks[index] ?? { confirmed: false as const, reason: "not checked" };
      const session = this.#store.getSession(held.sessionId);
      if (!check.confirmed || session === undefined || session.state === "ended") {
        const reason = check.confirmed ? "the session ended" : check.reason;
        this.#store.appendAudit("voice.instruction-unconfirmed", { reason }, receivedAt, {
          sessionId: held.sessionId,
        });
        notQueued += 1;
      } else if (!this.#queue(held, check.text, check.excerpt, event.conversationId, receivedAt)) {
        notQueued += 1;
      } else {
        queued += 1;
      }
      held.done = true;
    }
    this.#calls.delete(event.conversationId);
    this.#store.deleteInboundCall(event.conversationId);
    // One text closes the loop either way: the voice agent said "queued" before
    // the transcript was checked. Counts only, never the words.
    if (notQueued > 0) {
      const text = INBOUND_TEXTS.notQueued(notQueued);
      await this.#text(
        queued > 0 ? `${text} ${INBOUND_TEXTS.othersQueued(queued)}` : text,
        "instruction-not-queued",
        receivedAt,
      );
    } else if (queued > 0) {
      await this.#text(INBOUND_TEXTS.queued(queued), "instruction-queued", receivedAt);
    }
  }

  #queue(
    held: CallMemory["held"][number],
    /** The owner's own words for the instruction, from the transcript: never the model's text. */
    ownerWords: string,
    excerpt: string,
    conversationId: string,
    receivedAt: Date,
  ): boolean {
    const { redact } = this.#options;
    const cap = (text: string, max: number) => {
      const redacted = redact(text).trim();
      return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
    };
    // Redacted first, so a secret is caught before its symbols are dropped.
    const redacted = cap(ownerWords, MAX_INSTRUCTION_LENGTH).replace(/\s+/g, " ");
    const text = plainInstruction(redacted);
    const ownerExcerpt = cap(excerpt, 2000);
    // Stripping symbols could change what the owner heard read back ("use C++"
    // would become "use C"), so such an instruction is refused, not altered.
    const reason =
      text === "" || ownerExcerpt === ""
        ? "nothing left after redaction"
        : text !== redacted
          ? "the instruction holds symbols that cannot be passed on as said"
          : undefined;
    if (reason !== undefined) {
      this.#store.appendAudit("voice.instruction-unconfirmed", { reason }, receivedAt, {
        sessionId: held.sessionId,
      });
      return false;
    }
    const stored = this.#store.addInstruction({
      id: held.id,
      sessionId: held.sessionId,
      text,
      ownerExcerpt,
      sourceId: conversationId,
      channel: "voice",
      receivedAt: held.receivedAt.toISOString(),
      status: "queued",
    });
    // Already stored by an earlier attempt at this event: the rest was done or is idempotent.
    if (stored) this.#store.appendAudit("instruction.queued", {}, receivedAt, { sessionId: held.sessionId });
    // A Stop hook already waiting on the owner picks the instruction up at once:
    // its open stop gives way (the hook then takes the queued instructions).
    for (const ask of this.#store.listAsks(["pending", "in-flight"])) {
      if (ask.sessionId !== held.sessionId || ask.kind !== "stop") continue;
      if (this.#store.setAskStatus(ask.id, "cancelled")) {
        this.#store.appendAudit("ask.cancelled", { kind: "stop", by: "instruction" }, receivedAt, {
          askId: ask.id,
          sessionId: ask.sessionId,
        });
      }
    }
    return true;
  }

  /** A call the owner (or anyone) placed to the Hotline number, for the cost estimate. Ids and numbers only. */
  #recordInboundCall(event: Extract<PostCallEvent, { type: "transcription" }>, receivedAt: Date): void {
    const duration = event.durationSeconds ?? 0;
    const verified = event.transcript.some((turn) => turn.role === "owner");
    const id = `inbound-${createHash("sha256").update(event.conversationId).digest("hex").slice(0, 32)}`;
    try {
      this.#store.putCall({
        id,
        provider: "elevenlabs",
        direction: "inbound",
        providerIds: {
          conversationId: event.conversationId,
          ...(event.callSid === undefined ? {} : { callSid: event.callSid }),
        },
        askIds: [],
        outcome: verified ? "answered" : "rejected",
        startedAt: new Date(receivedAt.getTime() - duration * 1000).toISOString(),
        endedAt: receivedAt.toISOString(),
        durationSeconds: duration,
        costEstimateCents: Math.ceil(duration / 60) * CALL_CENTS_PER_MINUTE,
      });
    } catch (error) {
      this.#options.log?.().error({ err: error }, "could not store the inbound call record");
    }
    this.#store.appendAudit("call.inbound", { outcome: verified ? "answered" : "rejected" }, receivedAt, {
      callId: id,
    });
  }

  /** `PinGate.onLockout`: tells the owner, at most once an hour per direction. */
  async pinLockout(direction: PinCallDirection): Promise<void> {
    const now = this.#options.clock();
    this.#store.appendAudit("voice.pin-lockout", { direction }, now);
    // When the last one went out is saved, so a restart does not allow another early.
    let saved: Partial<Record<PinCallDirection, unknown>> = {};
    try {
      const state = this.#store.getState(LOCKOUT_TEXTED_KEY);
      if (typeof state === "object" && state !== null) saved = state as typeof saved;
    } catch {
      // This run's own record still applies.
    }
    const times = [saved[direction], this.#lockoutTexted[direction]].filter(
      (at): at is number => typeof at === "number" && Number.isFinite(at),
    );
    const last = times.length === 0 ? undefined : Math.max(...times);
    if (last !== undefined && now.getTime() - last < LOCKOUT_TEXT_MS) return;
    this.#lockoutTexted[direction] = now.getTime();
    try {
      this.#store.putState(LOCKOUT_TEXTED_KEY, { ...saved, [direction]: now.getTime() });
    } catch {
      // This run still remembers it.
    }
    await this.#text(INBOUND_TEXTS.lockout(direction), "pin-lockout", now);
  }

  async #text(text: string, why: string, now: Date): Promise<void> {
    const sms = this.#options.sms;
    if (sms === undefined) {
      this.#store.appendAudit("text.failed", { reason: "no SMS provider", about: why }, now);
      return;
    }
    try {
      await sms.sendToOwner(text);
      this.#store.appendAudit("text.sent", { reason: why }, now);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      this.#store.appendAudit(
        "text.failed",
        { status: typeof status === "number" ? status : null, about: why },
        now,
      );
    }
  }
}
