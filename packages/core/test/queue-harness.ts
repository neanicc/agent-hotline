// Test driver for the ask queue: a fake clock, deep-frozen states and an action log.
import {
  Answer,
  Ask,
  type AskKind,
  createQueue,
  type Decision,
  type PolicySettings,
  parseConfig,
  policySettings,
  type QueueAction,
  type QueueEvent,
  type QueueState,
  step,
} from "../src/index.js";

const PIN_HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;

/** Noon in Toronto (16:00Z), well outside the default 22:00-08:00 quiet hours. */
export const NOON = Date.parse("2026-10-13T16:00:00.000Z");
/** 23:00 in Toronto, inside quiet hours. */
export const NIGHT = Date.parse("2026-10-14T03:00:00.000Z");

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export function makeSettings(
  config: {
    allowUrgentCalls?: boolean;
    rateLimits?: Record<string, number>;
    batchWindowSeconds?: number;
  } = {},
  overrides: Partial<PolicySettings> = {},
): PolicySettings {
  const parsed = parseConfig({
    version: 1,
    owner: { phoneNumber: "+15555550100", pinHash: PIN_HASH },
    quietHours: { timeZone: "America/Toronto", allowUrgentCalls: config.allowUrgentCalls ?? false },
    rateLimits: config.rateLimits ?? {},
    policy: { batchWindowSeconds: config.batchWindowSeconds ?? 20 },
  });
  return { ...policySettings(parsed), ...overrides };
}

export interface AskSpec {
  id: string;
  kind?: AskKind;
  sessionId?: string;
  text?: string;
  options?: string[];
  risk?: "low" | "high";
  urgent?: boolean;
  createdAt: number;
  ttlMs?: number;
}

export function makeAsk(spec: AskSpec): Ask {
  const kind = spec.kind ?? "question";
  return Ask.parse({
    id: spec.id,
    sessionId: spec.sessionId ?? "session-1",
    kind,
    text: spec.text ?? `Question ${spec.id}?`,
    options: kind === "question" ? (spec.options ?? ["Yes", "No"]) : [],
    ...(kind === "permission" ? { toolName: "Bash" } : {}),
    risk: spec.risk ?? "low",
    urgent: spec.urgent ?? false,
    createdAt: new Date(spec.createdAt).toISOString(),
    expiresAt: new Date(spec.createdAt + (spec.ttlMs ?? 30 * MINUTE)).toISOString(),
    status: "pending",
  });
}

export function makeAnswer(
  askId: string,
  decision: Decision,
  answeredAt: number,
  extra: { channel?: "voice" | "sms"; confirmation?: "none" | "pin" | "text" } = {},
): Answer {
  return Answer.parse({
    askId,
    decision,
    channel: extra.channel ?? "voice",
    ownerExcerpt: "yes, go ahead",
    sourceId: "conv-fake-1",
    confirmation: extra.confirmation ?? "none",
    answeredAt: new Date(answeredAt).toISOString(),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export interface LoggedStep {
  at: number;
  event: QueueEvent;
  before: QueueState;
  after: QueueState;
  actions: QueueAction[];
}

/** Drives the queue with a fake clock. Every state it passes to `step` is deep-frozen. */
export class Harness {
  state: QueueState;
  now: number;
  readonly log: LoggedStep[] = [];

  constructor(
    readonly settings: PolicySettings,
    start: number = NOON,
  ) {
    this.state = deepFreeze(createQueue("test"));
    this.now = start;
  }

  send(event: QueueEvent): QueueAction[] {
    const before = this.state;
    const { state, actions } = step(before, event, new Date(this.now), this.settings);
    this.state = deepFreeze(state);
    this.log.push({ at: this.now, event, before, after: this.state, actions });
    return actions;
  }

  ask(spec: Omit<AskSpec, "createdAt"> & { createdAt?: number }): QueueAction[] {
    return this.send({ type: "ask", ask: makeAsk({ createdAt: this.now, ...spec }) });
  }

  /** Moves the clock forward and ticks. */
  advance(ms: number): QueueAction[] {
    this.now += ms;
    return this.send({ type: "tick" });
  }

  get allActions(): QueueAction[] {
    return this.log.flatMap((entry) => entry.actions);
  }

  get callId(): string {
    const id = this.state.call?.id;
    if (id === undefined) throw new Error("no call in progress");
    return id;
  }
}

export const ofType = <T extends QueueAction["type"]>(actions: QueueAction[], type: T) =>
  actions.filter((action): action is Extract<QueueAction, { type: T }> => action.type === type);
