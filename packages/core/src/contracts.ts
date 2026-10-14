// Records the daemon stores and passes between packages (plan section 5).
// Every schema is strict: an unknown field is an error, not something to carry along.
import { z } from "zod";

/** ISO 8601 UTC timestamp, for example `2026-10-13T21:58:00.000Z`. */
export const Timestamp = z.iso.datetime();

/** A phone number in E.164 form, for example `+15555550100`. */
export const PhoneNumber = z.e164();

/** Opaque identifier the daemon or a provider assigned. */
export const Id = z.string().min(1).max(128);

/** Text with at least one non-whitespace character. Stored as given, never trimmed. */
const notBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.trim().length > 0, "must not be blank");

export const AgentKind = z.enum(["claude-code", "codex"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const SessionState = z.enum(["working", "waiting-on-human", "idle", "ended"]);
export type SessionState = z.infer<typeof SessionState>;

export const Session = z.strictObject({
  id: Id,
  agent: AgentKind,
  /** The agent's own session id (`session_id` in its hook payloads), when known. */
  agentSessionId: Id.optional(),
  cwd: z.string().startsWith("/"),
  /** Short spoken name, by default agent plus repository folder ("Claude in demo-app"). */
  nickname: z.string().min(1).max(60),
  state: SessionState,
  /** Redacted one or two sentence summary of the agent's last message. */
  lastMessageSummary: z.string().max(500).optional(),
  registeredAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type Session = z.infer<typeof Session>;

export const AskKind = z.enum(["question", "permission", "stop", "notify"]);
export type AskKind = z.infer<typeof AskKind>;

export const Risk = z.enum(["low", "high"]);
export type Risk = z.infer<typeof Risk>;

export const AskStatus = z.enum(["pending", "in-flight", "answered", "expired", "cancelled"]);
export type AskStatus = z.infer<typeof AskStatus>;

/** Options are read out as numbers and chosen by keypad, so at most nine. */
export const MAX_OPTIONS = 9;

export const Ask = z
  .strictObject({
    id: Id,
    sessionId: Id,
    kind: AskKind,
    /** Redacted, short text the human hears or reads. Untrusted: it came from an agent. */
    text: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(200)).max(MAX_OPTIONS).default([]),
    /** For `permission` asks: the tool the agent wants to run, such as `Bash`. */
    toolName: z.string().min(1).max(200).optional(),
    risk: Risk.default("low"),
    /** May call during quiet hours when the config allows urgent calls. */
    urgent: z.boolean().default(false),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    status: AskStatus,
  })
  .superRefine((ask, ctx) => {
    if (Date.parse(ask.expiresAt) <= Date.parse(ask.createdAt)) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after createdAt" });
    }
    if (ask.kind !== "question" && ask.options.length > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "only questions carry options" });
    }
    if (new Set(ask.options).size !== ask.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "options must be unique" });
    }
    if (ask.kind === "permission" && ask.toolName === undefined) {
      ctx.addIssue({ code: "custom", path: ["toolName"], message: "permission asks name the tool" });
    }
  });
export type Ask = z.infer<typeof Ask>;

/** What the owner decided. There is deliberately no "default" or "assumed" variant. */
export const Decision = z.discriminatedUnion("type", [
  /** Picked option `option` (1-based) of a question. */
  z.strictObject({ type: z.literal("option"), option: z.int().min(1).max(MAX_OPTIONS) }),
  /** Approved a permission request. */
  z.strictObject({ type: z.literal("allow") }),
  /** Refused a permission request. */
  z.strictObject({ type: z.literal("deny") }),
  /** Free-text answer to a question, or the next instruction after a stop. */
  z.strictObject({ type: z.literal("text"), text: notBlank(2000) }),
  /** After a stop: nothing more, let the agent finish. */
  z.strictObject({ type: z.literal("done") }),
]);
export type Decision = z.infer<typeof Decision>;

export const Channel = z.enum(["voice", "sms"]);
export type Channel = z.infer<typeof Channel>;

/**
 * How the owner proved it was them beyond caller ID, required for high-risk approvals.
 * The contract cannot prove the claim, so the daemon sets `pin` or `text` only from its
 * own server-side check (a PIN it verified against the stored hash, or a confirming text
 * from the owner's number on a verified webhook), never from model, tool or agent output.
 */
export const Confirmation = z.enum(["none", "pin", "text"]);
export type Confirmation = z.infer<typeof Confirmation>;

export const Answer = z.strictObject({
  askId: Id,
  decision: Decision,
  channel: Channel,
  /** The owner's own words or keypresses that produced the decision, verbatim. */
  ownerExcerpt: notBlank(2000),
  /** Provider id of the call (conversation or call SID) or text message that carried it. */
  sourceId: Id,
  /** Set only from the daemon's own verification; see `Confirmation`. */
  confirmation: Confirmation.default("none"),
  answeredAt: Timestamp,
});
export type Answer = z.infer<typeof Answer>;

export const NoAnswerReason = z.enum(["timeout", "no-pickup", "unclear", "dropped", "failed", "cancelled"]);
export type NoAnswerReason = z.infer<typeof NoAnswerReason>;

/** What an agent gets back for an ask. Anything but `answered` means nobody decided. */
export const AskOutcome = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("answered"), answer: Answer }),
  z.strictObject({ outcome: z.literal("no-answer"), askId: Id, reason: NoAnswerReason }),
]);
export type AskOutcome = z.infer<typeof AskOutcome>;

export const CallDirection = z.enum(["outbound", "inbound"]);
export type CallDirection = z.infer<typeof CallDirection>;

export const CallOutcome = z.enum(["answered", "no-answer", "failed", "rejected"]);
export type CallOutcome = z.infer<typeof CallOutcome>;

export const VoiceProviderName = z.enum(["elevenlabs", "fake"]);
export type VoiceProviderName = z.infer<typeof VoiceProviderName>;

export const CallRecord = z
  .strictObject({
    id: Id,
    provider: VoiceProviderName,
    direction: CallDirection,
    /** Ids the providers assigned: ElevenLabs conversation id, Twilio call SID. */
    providerIds: z.strictObject({ conversationId: Id.optional(), callSid: Id.optional() }),
    /** Asks this call covered; several when asks were batched. Empty for an inbound status call. */
    askIds: z.array(Id),
    outcome: CallOutcome,
    startedAt: Timestamp,
    endedAt: Timestamp.optional(),
    durationSeconds: z.number().min(0),
    /** Estimated cost in US cents, for `hotline doctor`'s monthly estimate. */
    costEstimateCents: z.number().min(0),
  })
  .superRefine((call, ctx) => {
    if (call.direction === "outbound" && call.askIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["askIds"], message: "an outbound call covers at least one ask" });
    }
    if (call.endedAt !== undefined && Date.parse(call.endedAt) < Date.parse(call.startedAt)) {
      ctx.addIssue({ code: "custom", path: ["endedAt"], message: "must not be before startedAt" });
    }
  });
export type CallRecord = z.infer<typeof CallRecord>;

/** Statuses in which an ask still waits for the owner. Any other status is final. */
const OPEN_STATUSES: ReadonlySet<AskStatus> = new Set<AskStatus>(["pending", "in-flight"]);

/**
 * Why `answer` cannot resolve `ask`, or undefined when it can. Callers treat any
 * problem as "no answer": an ask that is no longer open (already answered, expired
 * or cancelled), an answer given or received at or after `expiresAt`, a decision of
 * the wrong kind, an option the ask did not offer, or a high-risk approval without
 * a PIN or confirming text never counts.
 *
 * `receivedAt` is the daemon's clock reading when the answer arrived. Core never
 * reads the wall clock itself; an invalid reading is a problem, not a pass.
 */
export function answerProblem(ask: Ask, answer: Answer, receivedAt: Date): string | undefined {
  if (answer.askId !== ask.id) return "answer belongs to a different ask";
  if (!OPEN_STATUSES.has(ask.status)) return `the ask is ${ask.status}, not waiting for an answer`;
  const expiresAt = Date.parse(ask.expiresAt);
  const received = receivedAt.getTime();
  if (Number.isNaN(received)) return "the time the answer arrived is unknown";
  if (received >= expiresAt) return "the answer arrived after the ask expired";
  if (Date.parse(answer.answeredAt) >= expiresAt) return "the answer was given after the ask expired";
  const { decision } = answer;
  switch (ask.kind) {
    case "question":
      if (decision.type === "text") return undefined;
      if (decision.type !== "option") return `a question cannot be answered with "${decision.type}"`;
      return decision.option <= ask.options.length ? undefined : "option is not one the ask offered";
    case "permission":
      if (decision.type === "deny") return undefined;
      if (decision.type !== "allow") return `a permission request cannot be answered with "${decision.type}"`;
      if (ask.risk === "high" && answer.confirmation === "none") {
        return "a high-risk approval needs the PIN or a confirming text";
      }
      return undefined;
    case "stop":
      return decision.type === "text" || decision.type === "done"
        ? undefined
        : `a stop cannot be answered with "${decision.type}"`;
    case "notify":
      return "a notification takes no answer";
  }
}
