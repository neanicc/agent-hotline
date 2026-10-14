// The ask queue: a pure state machine that decides who to call or text, when, and
// what each agent gets back. The daemon feeds it events with its own clock reading
// and executes the actions it returns; core never reads the clock, sets a timer or
// touches the network.
//
// Safety rules this file enforces:
// - An ask gets an `answered` outcome only from an `answer` event whose answer
//   passes `answerProblem` at the time it arrived. Every other path (no pickup, a
//   dropped or failed call, an unclear answer, a failed text, cancellation, expiry)
//   ends in `no-answer`, which denies a permission request.
// - Every open ask ends by its `expiresAt` at the latest.
// - Calls and texts stay within the rate limits; quiet hours mean texts, except
//   urgent asks when the owner allowed urgent calls, and the one call the owner
//   asks for by texting `call me`.
// - A `call-me` event only places a call (to the owner; actions carry no number).
//   It is never an answer and decides nothing.
import { Answer, Ask, AskOutcome, type AskStatus, answerProblem, type NoAnswerReason } from "./contracts.js";
import {
  callLimit,
  comparePriority,
  DAY_MS,
  inQuietHours,
  nextRateSlot,
  type PolicySettings,
  rateLimitAllows,
  textLimit,
} from "./policy.js";

/** `waiting` for a call or text, on the `calling` line now, or `texted` and awaiting a reply. */
export type AskPhase = "waiting" | "calling" | "texted";

/** Why an ask went out by text rather than a call. */
export type TextReason = "notify" | "quiet-hours" | "call-limit" | "after-call";

/** How a call the queue placed ended, as the daemon observed it. */
export type CallEnd = "answered" | "no-pickup" | "dropped" | "failed";

export interface QueuedAsk {
  /** The ask, with `status` kept current (`pending`, then `in-flight` once put to the owner). */
  ask: Ask;
  phase: AskPhase;
  /** Earliest time (epoch ms) this ask may go out: the end of its batch window or retry delay. */
  readyAt: number;
  /** Calls that have read this ask out. */
  callAttempts: number;
  /** Whether a text carried this ask; only then is a text reply accepted for it. */
  texted: boolean;
  /** Set once calling is over for this ask: its next contact is a text, for this reason. */
  textOnly?: TextReason;
  /** The open ask this one duplicates. It is never contacted itself and shares that ask's answer. */
  duplicateOf?: string;
  /** Why the last contact attempt failed; the no-answer reason if the ask then expires. */
  lastFailure?: "no-pickup" | "dropped" | "failed";
}

export interface ActiveCall {
  id: string;
  askIds: string[];
  placedAt: number;
}

/** Plain, JSON-serializable queue state. Treat it as immutable; `step` returns a new one. */
export interface QueueState {
  open: QueuedAsk[];
  /** The one outbound call in progress, if any. The owner has one phone. */
  call?: ActiveCall;
  /** When calls and texts went out in the last 24 hours (epoch ms), for the rate limits. */
  callTimes: number[];
  textTimes: number[];
  callSeq: number;
  /** Prefix for call ids; the daemon passes one unique to this daemon run. */
  idPrefix: string;
}

export type QueueEvent =
  /** An agent asked something. The ask must parse and be `pending`. */
  | { type: "ask"; ask: Ask }
  /** Nothing happened; time moved on. Send one at `nextWakeAt`. */
  | { type: "tick" }
  /** The owner answered, by voice (`submit_answer`) or text. Verified with `answerProblem`. */
  | { type: "answer"; answer: Answer }
  /** The owner was asked but the answer stayed unclear (the voice agent asked twice). */
  | { type: "unclear"; askId: string }
  | { type: "call-ended"; callId: string; result: CallEnd }
  /** The text for this ask went out. Ends a notification as `delivered`. */
  | { type: "text-sent"; askId: string }
  /** The text for this ask could not be sent. */
  | { type: "text-failed"; askId: string }
  /** The agent stopped waiting (session ended, hook killed). */
  | { type: "cancel"; askId: string }
  /**
   * The owner texted `call me` (the daemon checked it came from the owner's number).
   * Calls now about the open asks, within the call limit, even in quiet hours. Not an answer.
   */
  | { type: "call-me" };

export type QueueAction =
  /** Place one call to the owner covering these asks, in this order. */
  | { type: "place-call"; callId: string; askIds: string[] }
  /** Hang up this call if it is still live: it was never reported as ended and has been given up on. */
  | { type: "end-call"; callId: string }
  /** Text the owner this ask. */
  | { type: "send-text"; askId: string; reason: TextReason }
  /** Final: return `outcome` to the agent and store the ask with `status`. */
  | {
      type: "resolve";
      askId: string;
      outcome: AskOutcome;
      status: Extract<AskStatus, "answered" | "expired" | "cancelled">;
    }
  /** Final for a notification: the daemon reported its text sent; nothing comes back. */
  | { type: "delivered"; askId: string }
  /** The event changed nothing. Log `reason`; never treat it as an answer. */
  | { type: "ignored"; event: QueueEvent["type"]; askId?: string; callId?: string; reason: string };

export interface StepResult {
  state: QueueState;
  actions: QueueAction[];
}

/** An empty queue. `idPrefix` makes call ids unique across daemon runs. */
export function createQueue(idPrefix = "call"): QueueState {
  return { open: [], callTimes: [], textTimes: [], callSeq: 0, idPrefix };
}

interface Context {
  s: QueueState;
  actions: QueueAction[];
  now: Date;
  t: number;
  settings: PolicySettings;
}

/**
 * Applies one event at clock reading `now`, then expires, retries and dispatches
 * whatever is due. Returns the new state and the actions for the daemon to carry
 * out in order. `state` is not modified.
 */
export function step(state: QueueState, event: QueueEvent, now: Date, settings: PolicySettings): StepResult {
  const t = now.getTime();
  if (Number.isNaN(t)) throw new RangeError("step needs a valid clock reading");
  const s = structuredClone(state);
  const ctx: Context = { s, actions: [], now, t, settings };
  s.callTimes = s.callTimes.filter((time) => time > t - DAY_MS);
  s.textTimes = s.textTimes.filter((time) => time > t - DAY_MS);

  apply(ctx, event);
  giveUpStuckCall(ctx);
  expire(ctx);
  dispatch(ctx);
  return { state: s, actions: ctx.actions };
}

/** A call never reported as ended is hung up and treated as dropped once it is stuck. */
function giveUpStuckCall(ctx: Context): void {
  const { s, settings, t } = ctx;
  if (s.call === undefined || t - s.call.placedAt < settings.callStuckAfterMs) return;
  ctx.actions.push({ type: "end-call", callId: s.call.id });
  endCall(ctx, "dropped");
}

/**
 * When the daemon should next send a `tick`: the earliest expiry, batch window or
 * retry end, rate-limit slot for a held ask, or stuck-call deadline. Undefined when
 * nothing is waiting on time.
 */
export function nextWakeAt(state: QueueState, now: Date, settings: PolicySettings): Date | undefined {
  const t = now.getTime();
  const quiet = inQuietHours(settings.quietHours, now);
  const times: number[] = [];
  for (const q of state.open) {
    times.push(Date.parse(q.ask.expiresAt));
    if (q.duplicateOf !== undefined || q.phase !== "waiting") continue;
    times.push(q.readyAt > t ? q.readyAt : earliestSend(state, q, quiet, t, settings));
  }
  if (state.call !== undefined) times.push(state.call.placedAt + settings.callStuckAfterMs);
  // Anything already overdue (say the daemon asks late, or restored saved state) means "now".
  return times.length > 0 ? new Date(Math.max(t, Math.min(...times))) : undefined;
}

/** When a due, waiting ask can next go out: now, or when the call or rate limit holding it frees. */
function earliestSend(state: QueueState, q: QueuedAsk, quiet: boolean, t: number, settings: PolicySettings) {
  const textSlot = () => nextRateSlot(state.textTimes, textLimit(settings), t);
  if (!mayCall(q, quiet, settings)) return textSlot();
  if (state.call !== undefined) return state.call.placedAt + settings.callStuckAfterMs;
  // Over the call limit, a due ask is texted instead.
  return rateLimitAllows(state.callTimes, callLimit(settings), t) ? t : textSlot();
}

/** Whether this ask may go out by call now rather than by text. */
function mayCall(q: QueuedAsk, quiet: boolean, settings: PolicySettings): boolean {
  return (
    q.ask.kind !== "notify" &&
    q.textOnly === undefined &&
    (!quiet || (q.ask.urgent && settings.quietHours.allowUrgentCalls))
  );
}

/**
 * Whether a permission hook may allow the action: only an `answered` outcome for
 * this permission ask whose decision is `allow`, with the PIN or a confirming text
 * when the ask is high risk. Anything else, malformed input included, is a deny.
 */
export function permissionVerdict(ask: Ask, outcome: AskOutcome): "allow" | "deny" {
  const parsed = AskOutcome.safeParse(outcome);
  if (!parsed.success || ask.kind !== "permission" || parsed.data.outcome !== "answered") return "deny";
  const { answer } = parsed.data;
  if (answer.askId !== ask.id || answer.decision.type !== "allow") return "deny";
  if (ask.risk !== "low" && answer.confirmation === "none") return "deny";
  return "allow";
}

/**
 * Only questions and notifications are deduped. `text` is a redacted, length-capped
 * summary, so two different permission requests (or stop prompts) can share it; each
 * of those gets its own decision, even when one call reads them out together.
 */
const DEDUPED_KINDS: ReadonlySet<Ask["kind"]> = new Set<Ask["kind"]>(["question", "notify"]);

function dedupeKey(ask: Ask): string | undefined {
  if (!DEDUPED_KINDS.has(ask.kind)) return undefined;
  return JSON.stringify([ask.sessionId, ask.kind, ask.text, ask.options, ask.toolName ?? null, ask.risk]);
}

function findOpen(s: QueueState, askId: string): QueuedAsk | undefined {
  return s.open.find((q) => q.ask.id === askId);
}

function resolve(ctx: Context, q: QueuedAsk, outcome: AskOutcome): void {
  ctx.s.open = ctx.s.open.filter((other) => other !== q);
  const status =
    outcome.outcome === "answered" ? "answered" : outcome.reason === "cancelled" ? "cancelled" : "expired";
  ctx.actions.push({ type: "resolve", askId: q.ask.id, outcome, status });
}

function noAnswer(ctx: Context, q: QueuedAsk, reason: NoAnswerReason): void {
  resolve(ctx, q, { outcome: "no-answer", askId: q.ask.id, reason });
}

function followersOf(ctx: Context, askId: string): QueuedAsk[] {
  return ctx.s.open.filter((q) => q.duplicateOf === askId);
}

/** The primary went away without an answer they can share: the oldest follower takes over. */
function promote(ctx: Context, followers: QueuedAsk[]): void {
  const [next, ...rest] = [...followers].sort((a, b) => comparePriority(a.ask, b.ask));
  if (next === undefined) return;
  delete next.duplicateOf;
  next.readyAt = ctx.t;
  for (const q of rest) q.duplicateOf = next.ask.id;
}

/** Ends a primary ask without an answer; its followers carry on under a new primary. */
function endWithoutAnswer(ctx: Context, q: QueuedAsk, reason: NoAnswerReason): void {
  const followers = q.duplicateOf === undefined ? followersOf(ctx, q.ask.id) : [];
  noAnswer(ctx, q, reason);
  promote(ctx, followers);
}

function apply(ctx: Context, event: QueueEvent): void {
  const reason = applyEvent(ctx, event);
  if (reason === undefined) return;
  const ids: { askId?: string; callId?: string } = {};
  const askId =
    event.type === "ask" ? event.ask?.id : event.type === "answer" ? event.answer?.askId : undefined;
  if (typeof askId === "string") ids.askId = askId;
  if ("askId" in event) ids.askId = event.askId;
  if (event.type === "call-ended") ids.callId = event.callId;
  ctx.actions.push({ type: "ignored", event: event.type, ...ids, reason });
}

/** Applies `event`, or returns why it changed nothing. */
function applyEvent(ctx: Context, event: QueueEvent): string | undefined {
  switch (event.type) {
    case "tick":
      return undefined;
    case "ask":
      return enqueue(ctx, event.ask);
    case "answer":
      return receiveAnswer(ctx, event.answer);
    case "unclear": {
      const q = findOpen(ctx.s, event.askId);
      if (q === undefined) return "no open ask with this id";
      if (q.duplicateOf !== undefined) return `the ask shares ${q.duplicateOf}'s answer`;
      if (q.phase !== "calling" && q.phase !== "texted")
        return "the ask is not on a call or awaiting a text reply";
      // The owner heard this exact question and gave no clear answer; duplicates share that.
      const followers = followersOf(ctx, q.ask.id);
      noAnswer(ctx, q, "unclear");
      for (const f of followers) noAnswer(ctx, f, "unclear");
      return undefined;
    }
    case "call-ended":
      if (ctx.s.call === undefined || ctx.s.call.id !== event.callId) return "not the call in progress";
      endCall(ctx, event.result);
      return undefined;
    case "text-sent": {
      const q = findOpen(ctx.s, event.askId);
      if (q === undefined || q.phase !== "texted") return "no open texted ask with this id";
      if (q.ask.kind === "notify") {
        // The same notification from the same session goes out once.
        for (const done of [q, ...followersOf(ctx, q.ask.id)]) {
          ctx.s.open = ctx.s.open.filter((other) => other !== done);
          ctx.actions.push({ type: "delivered", askId: done.ask.id });
        }
      }
      return undefined;
    }
    case "text-failed": {
      const q = findOpen(ctx.s, event.askId);
      if (q === undefined || q.phase !== "texted") return "no open texted ask with this id";
      endWithoutAnswer(ctx, q, "failed");
      return undefined;
    }
    case "cancel": {
      const q = findOpen(ctx.s, event.askId);
      if (q === undefined) return "no open ask with this id";
      endWithoutAnswer(ctx, q, "cancelled");
      return undefined;
    }
    case "call-me":
      return callMe(ctx);
  }
}

/**
 * The owner asked to be called. One call now covers the open asks that need an answer
 * (waiting or already texted, highest priority first, at most `maxAsksPerCall`). The
 * owner's request overrides quiet hours, a batch window, a retry delay and an earlier
 * fallback to text, for this call only. It never overrides the call limit or a call
 * in progress, and it is not an answer: every ask still needs the owner's own words.
 */
function callMe(ctx: Context): string | undefined {
  const { s, settings, t } = ctx;
  // A call already given up on does not hold the owner's request back. (`step` runs this
  // again afterwards; with the call gone, that second run does nothing.)
  giveUpStuckCall(ctx);
  if (s.call !== undefined) return "a call is already in progress";
  const asks = s.open
    .filter(
      (q) =>
        q.duplicateOf === undefined &&
        q.ask.kind !== "notify" &&
        (q.phase === "waiting" || q.phase === "texted") &&
        Date.parse(q.ask.expiresAt) > t,
    )
    .sort((a, b) => comparePriority(a.ask, b.ask));
  if (asks.length === 0) return "no open asks to call about";
  if (!rateLimitAllows(s.callTimes, callLimit(settings), t)) {
    return "over the call limit; open asks keep going by text";
  }
  placeCall(ctx, asks.slice(0, settings.maxAsksPerCall));
  return undefined;
}

function placeCall(ctx: Context, batch: QueuedAsk[]): void {
  const { s, t } = ctx;
  s.callSeq += 1;
  const callId = `${s.idPrefix}-${s.callSeq}`;
  for (const q of batch) {
    q.phase = "calling";
    q.callAttempts += 1;
    q.ask.status = "in-flight";
  }
  const askIds = batch.map((q) => q.ask.id);
  s.call = { id: callId, askIds, placedAt: t };
  s.callTimes.push(t);
  ctx.actions.push({ type: "place-call", callId, askIds });
}

function enqueue(ctx: Context, input: Ask): string | undefined {
  const parsed = Ask.safeParse(input);
  if (!parsed.success) return "not a valid ask";
  const ask = parsed.data;
  if (ask.status !== "pending") return `a new ask must be pending, not ${ask.status}`;
  if (findOpen(ctx.s, ask.id) !== undefined) return "already queued";
  const key = dedupeKey(ask);
  const primary =
    key === undefined
      ? undefined
      : ctx.s.open.find((q) => q.duplicateOf === undefined && dedupeKey(q.ask) === key);
  ctx.s.open.push({
    ask,
    phase: "waiting",
    readyAt: ctx.t + ctx.settings.batchWindowMs,
    callAttempts: 0,
    texted: false,
    ...(primary === undefined ? {} : { duplicateOf: primary.ask.id }),
  });
  return undefined;
}

function receiveAnswer(ctx: Context, input: Answer): string | undefined {
  const parsed = Answer.safeParse(input);
  if (!parsed.success) return "not a valid answer";
  const answer = parsed.data;
  const q = findOpen(ctx.s, answer.askId);
  if (q === undefined) return "no open ask with this id";
  if (q.duplicateOf !== undefined) return `the ask shares ${q.duplicateOf}'s answer`;
  // The owner can only answer what was put to them, on the channel it went out on.
  // A voice answer counts only while the ask is on the call in progress; the daemon delivers
  // `submit_answer` before that call's `call-ended`.
  if (answer.channel === "voice" && q.phase !== "calling") return "the ask is not on the call in progress";
  if (answer.channel === "sms" && !q.texted) return "the ask was never texted";
  const problem = answerProblem(q.ask, answer, ctx.now);
  if (problem !== undefined) return problem;

  const followers = followersOf(ctx, q.ask.id);
  resolve(ctx, q, { outcome: "answered", answer });
  // Identical questions from the same session get the same decision, checked against each
  // one. A PIN or confirming text proves something about one ask only, so it is never copied.
  const unresolved: QueuedAsk[] = [];
  for (const f of followers) {
    const shared: Answer = { ...answer, askId: f.ask.id, confirmation: "none" };
    if (answerProblem(f.ask, shared, ctx.now) === undefined) {
      resolve(ctx, f, { outcome: "answered", answer: shared });
    } else {
      unresolved.push(f);
    }
  }
  promote(ctx, unresolved);
  return undefined;
}

function endCall(ctx: Context, result: CallEnd): void {
  const call = ctx.s.call;
  if (call === undefined) return;
  delete ctx.s.call;
  const { settings, t } = ctx;
  for (const askId of call.askIds) {
    const q = findOpen(ctx.s, askId);
    if (q === undefined || q.phase !== "calling") continue;
    if (result === "no-pickup" || result === "failed") q.lastFailure = result;
    else if (result === "dropped") q.lastFailure = "dropped";
    if (q.texted) {
      // Already texted before a `call me` call: the owner has the text and can still reply to it.
      q.phase = "texted";
      continue;
    }
    q.phase = "waiting";
    if ((result === "no-pickup" || result === "failed") && q.callAttempts < settings.maxCallAttempts) {
      q.readyAt = t + settings.retryDelayMs;
    } else {
      // Retries are used up, or the owner picked up and this ask is still open: text it.
      q.textOnly = "after-call";
      q.readyAt = t;
    }
  }
}

function expire(ctx: Context): void {
  for (const q of [...ctx.s.open]) {
    if (!ctx.s.open.includes(q) || Date.parse(q.ask.expiresAt) > ctx.t) continue;
    endWithoutAnswer(ctx, q, q.lastFailure ?? "timeout");
  }
}

function dispatch(ctx: Context): void {
  const { s, settings, t } = ctx;
  const quiet = inQuietHours(settings.quietHours, ctx.now);
  const waiting = s.open
    .filter((q) => q.duplicateOf === undefined && q.phase === "waiting")
    .sort((a, b) => comparePriority(a.ask, b.ask));
  const due = (q: QueuedAsk) => q.readyAt <= t;

  const callable = waiting.filter((q) => mayCall(q, quiet, settings));
  let callLimited = false;
  if (s.call === undefined && callable.some(due)) {
    if (rateLimitAllows(s.callTimes, callLimit(settings), t)) {
      // Batch every due ask and every new one still in its batch window, highest priority
      // first. An ask waiting out its retry delay keeps waiting.
      placeCall(
        ctx,
        callable.filter((q) => due(q) || q.callAttempts === 0).slice(0, settings.maxAsksPerCall),
      );
    } else {
      callLimited = true;
    }
  }

  for (const q of waiting) {
    if (q.phase !== "waiting" || !due(q)) continue;
    let reason: TextReason;
    if (q.ask.kind === "notify") reason = "notify";
    else if (q.textOnly !== undefined) reason = q.textOnly;
    else if (!mayCall(q, quiet, settings)) reason = "quiet-hours";
    else if (callLimited) reason = "call-limit";
    else continue; // waits for the call in progress or the next one
    // Out of texts: this and every later text-bound ask wait for a slot or expire. (Asks that
    // can still go by call never reach this point; they were placed or skipped above.)
    if (!rateLimitAllows(s.textTimes, textLimit(settings), t)) break;
    s.textTimes.push(t);
    ctx.actions.push({ type: "send-text", askId: q.ask.id, reason });
    q.phase = "texted";
    q.texted = true;
    q.ask.status = "in-flight";
  }
}
