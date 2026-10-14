// Agent API routes for the MCP server and the hook adapters. They sit behind
// the agent API's token and loopback Host checks (`buildAgentApi`).
//
//   POST /v1/sessions                      register a session (or refresh one by agentSessionId)
//   POST /v1/sessions/:sessionId/asks      queue a question, notification, permission request or stop
//   GET  /v1/sessions/:sessionId/inbox     owner instructions and this session's recent asks
//   GET  /v1/asks/:askId/outcome           the outcome, waiting up to `waitSeconds` for one
//   POST /v1/asks/:askId/cancel            the agent stopped waiting; do not call about it
//
// Everything an agent sends is untrusted text. Ask text and options are redacted
// here, before they are stored, so nothing downstream (a call, a text, the
// store) ever holds the raw version. An `answered` outcome is built only from
// an answer the store holds, which `recordAnswer` accepted after `answerProblem`
// passed; nothing here can produce one any other way.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  type AgentKind,
  AgentKind as AgentKindSchema,
  type Ask,
  type AskOutcome,
  Id,
  MAX_OPTIONS,
  Risk as RiskSchema,
  type Session,
} from "@hotline/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Redactor } from "./redact.js";
import type { HotlineStore } from "./store.js";

/** Longest an outcome request may wait before answering "still waiting". */
export const MAX_OUTCOME_WAIT_SECONDS = 30;
/** Asks listed by the inbox, newest first. */
export const INBOX_ASK_LIMIT = 20;
/** Lengths an agent may send. Ask text is cut to the contract's 1000 after redaction. */
export const MAX_ASK_TEXT = 1000;
export const MAX_OPTION_TEXT = 200;
/** On shutdown, agent API connections still open after this long are closed. */
export const CLOSE_GRACE_MS = 2_000;
/**
 * Open (pending or in-flight) asks one session may have at once. Questions wait
 * for the owner, so a few are plenty; notifications stay open until delivered or
 * expired. Beyond this the daemon answers 429 and stores no ask.
 */
export const MAX_OPEN_ASKS = { question: 3, notify: 10, permission: 3, stop: 1 } as const;
/** The same across every session, so registering many sessions does not multiply the limit. */
export const MAX_OPEN_ASKS_TOTAL = { question: 10, notify: 30, permission: 10, stop: 10 } as const;
/** A tool name as the agents report it: `Bash`, `apply_patch`, `mcp__server__tool`. */
export const MAX_TOOL_NAME = 100;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;
/** Ask kinds that hold an agent until the owner answers. */
const WAITING_KINDS = ["question", "permission", "stop"] as const;

const ELLIPSIS = "…";

export interface AgentRoutesOptions {
  store: HotlineStore;
  redactor: Redactor;
  /** The daemon's injected clock. */
  clock: () => Date;
  /** `config.policy.askTimeoutMinutes`: then the ask returns "no answer". */
  askTimeoutMinutes: number;
  /** `config.nicknames`: repository folder name to spoken nickname. */
  nicknames?: Readonly<Record<string, string>>;
  /** For tests; defaults to random UUIDs. */
  newId?: () => string;
}

const RegisterSessionBody = z.strictObject({
  agent: AgentKindSchema,
  cwd: z.string().min(1).max(4096).startsWith("/"),
  agentSessionId: Id.optional(),
});

const CreateAskBody = z
  .strictObject({
    kind: z.enum(["question", "notify", "permission", "stop"]),
    text: z.string().min(1).max(MAX_ASK_TEXT),
    options: z.array(z.string().min(1).max(MAX_OPTION_TEXT)).max(MAX_OPTIONS).optional(),
    /** Permission requests only: the tool, and the risk class the hook worked out from its full input. */
    toolName: z.string().min(1).max(MAX_TOOL_NAME).regex(TOOL_NAME).optional(),
    risk: RiskSchema.optional(),
    urgent: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    const permission = body.kind === "permission";
    if (permission && body.toolName === undefined) {
      ctx.addIssue({ code: "custom", path: ["toolName"], message: "permission requests name the tool" });
    }
    if (permission && body.risk === undefined) {
      ctx.addIssue({ code: "custom", path: ["risk"], message: "permission requests carry a risk class" });
    }
    if (!permission && (body.toolName !== undefined || body.risk !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "only permission requests carry toolName and risk",
      });
    }
    if (body.kind !== "question" && (body.options?.length ?? 0) > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "only questions carry options" });
    }
  });

const SessionParams = z.strictObject({ sessionId: Id });
const AskParams = z.strictObject({ askId: Id });
const OutcomeQuery = z.strictObject({
  waitSeconds: z.coerce.number().int().min(0).max(MAX_OUTCOME_WAIT_SECONDS).default(0),
});

/** An owner instruction waiting for a session. HL-10 fills this queue; until then it is empty. */
export interface InboxInstruction {
  text: string;
  receivedAt: string;
}

export type OutcomeResponse =
  | { state: "waiting"; ask: Ask }
  | { state: "final"; ask: Ask; outcome: AskOutcome };

export interface InboxResponse {
  session: Session;
  instructions: InboxInstruction[];
  asks: { ask: Ask; outcome?: AskOutcome }[];
}

/** Paths and messages only: never the rejected values, which an agent wrote. */
function invalid(reply: FastifyReply, error: z.ZodError) {
  const issues = error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`);
  return reply.code(400).send({ error: "invalid request", issues });
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** "Claude in demo-app", unless `config.nicknames` names the folder. */
export function defaultNickname(agent: AgentKind, cwd: string, nicknames: Readonly<Record<string, string>>) {
  const folder = basename(cwd) || cwd;
  const configured = Object.hasOwn(nicknames, folder) ? nicknames[folder] : undefined;
  if (configured !== undefined) return configured;
  return cut(`${agent === "claude-code" ? "Claude" : "Codex"} in ${folder}`, 60);
}

export function registerAgentRoutes(app: FastifyInstance, options: AgentRoutesOptions): void {
  const { store, redactor, clock } = options;
  const newId = options.newId ?? randomUUID;
  const nicknames = options.nicknames ?? {};
  const askTimeoutMs = options.askTimeoutMinutes * 60_000;

  // Long-polling requests end as soon as the daemon starts closing, so shutdown
  // never waits for them.
  const closing = new AbortController();
  app.addHook("preClose", async () => {
    closing.abort();
    // `server.close()` drops only the connections idle at that moment. One whose
    // request was still running (a released long poll) goes idle a moment later
    // and would hold the close open until its keep-alive timeout. A connection
    // whose client aborted a long poll can also stay "active" with no request
    // left to finish. Every agent API request is short once long polls are
    // released, so after a grace period whatever is left is cut off.
    const started = Date.now();
    const reaper = setInterval(() => {
      if (Date.now() - started >= CLOSE_GRACE_MS) app.server.closeAllConnections();
      else app.server.closeIdleConnections();
      app.server.getConnections((error, count) => {
        if (error !== null || count === 0) clearInterval(reaper);
      });
    }, 50);
    reaper.unref();
  });
  app.addHook("onSend", async (_request, reply) => {
    if (closing.signal.aborted) void reply.header("connection", "close");
  });

  /** Marks `ask` expired, with an audit entry, if it is still open and its time is up. */
  const expireIfDue = (ask: Ask): boolean => {
    if (
      (ask.status !== "pending" && ask.status !== "in-flight") ||
      clock().getTime() < Date.parse(ask.expiresAt)
    ) {
      return false;
    }
    if (store.setAskStatus(ask.id, "expired")) {
      store.appendAudit("ask.expired", { kind: ask.kind }, clock(), {
        askId: ask.id,
        sessionId: ask.sessionId,
      });
    }
    return true;
  };

  /** The final outcome of `ask`, expiring it first if its time is up; undefined while it waits. */
  const outcomeOf = (ask: Ask): { ask: Ask; outcome?: AskOutcome } => {
    const current = expireIfDue(ask) ? (store.getAsk(ask.id) ?? ask) : ask;
    switch (current.status) {
      case "answered": {
        const answer = store.getAnswer(current.id);
        // The store sets `answered` only together with the answer; anything else is corruption.
        if (answer === undefined) throw new Error("answered ask without a stored answer");
        return { ask: current, outcome: { outcome: "answered", answer } };
      }
      case "expired":
        return { ask: current, outcome: { outcome: "no-answer", askId: current.id, reason: "timeout" } };
      case "cancelled":
        return { ask: current, outcome: { outcome: "no-answer", askId: current.id, reason: "cancelled" } };
      default:
        return { ask: current };
    }
  };

  /** `waiting-on-human` while the session has an open question, else `working`. */
  const refreshSessionState = (sessionId: string) => {
    const session = store.getSession(sessionId);
    if (session === undefined || session.state === "ended") return;
    const waiting = WAITING_KINDS.some((kind) => store.countOpenAsks(sessionId, kind) > 0);
    const state = waiting ? "waiting-on-human" : "working";
    if (session.state !== state) store.putSession({ ...session, state });
  };
  // Every status change, whoever makes it (an answer, expiry, a cancel), updates the session.
  const stopWatching = store.onAskChange((askId) => {
    const ask = store.getAsk(askId);
    if (ask !== undefined) refreshSessionState(ask.sessionId);
  });
  app.addHook("onClose", async () => {
    stopWatching();
  });

  /** Resolves when `askId` changes, `ms` pass, the client goes away or the daemon closes. */
  const changeOrTimeout = (askId: string, ms: number, reply: FastifyReply) =>
    new Promise<void>((resolve) => {
      if (closing.signal.aborted || ms <= 0) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        stopListening();
        closing.signal.removeEventListener("abort", done);
        reply.raw.off("close", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const stopListening = store.onAskChange((changed) => {
        if (changed === askId) done();
      });
      closing.signal.addEventListener("abort", done);
      reply.raw.once("close", done);
    });

  app.post("/v1/sessions", async (request, reply) => {
    const body = RegisterSessionBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const { agent, cwd, agentSessionId } = body.data;
    const now = clock().toISOString();
    const existing = agentSessionId === undefined ? undefined : store.findLiveSession(agent, agentSessionId);
    const session: Session = existing
      ? { ...existing, cwd, lastSeenAt: now }
      : {
          id: newId(),
          agent,
          ...(agentSessionId === undefined ? {} : { agentSessionId }),
          cwd,
          // The folder name will be spoken to the owner, so it is redacted like ask text.
          nickname: cut(redactor.text(defaultNickname(agent, cwd, nicknames)), 60),
          state: "working",
          registeredAt: now,
          lastSeenAt: now,
        };
    store.putSession(session);
    if (existing === undefined) {
      store.appendAudit("session.registered", { agent }, clock(), { sessionId: session.id });
    }
    return reply.code(existing ? 200 : 201).send({ session });
  });

  app.post("/v1/sessions/:sessionId/asks", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const body = CreateAskBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const session = store.getSession(params.data.sessionId);
    if (session === undefined || session.state === "ended") {
      return reply.code(404).send({ error: "unknown session" });
    }
    const { kind, urgent = false } = body.data;
    // Expired asks must not keep counting against the caps below, even if nobody
    // has polled them since (a killed agent, an undelivered notification).
    for (const open of store.listAsks(["pending", "in-flight"])) expireIfDue(open);
    if (kind === "stop") {
      // A session ends one turn at a time, so an older open stop is stale (its hook
      // was killed before it could cancel): nobody should be called about it.
      for (const open of store.listAsks(["pending", "in-flight"])) {
        if (
          open.sessionId === session.id &&
          open.kind === "stop" &&
          store.setAskStatus(open.id, "cancelled")
        ) {
          store.appendAudit("ask.cancelled", { kind: "stop", by: "newer-stop" }, clock(), {
            askId: open.id,
            sessionId: session.id,
          });
        }
      }
    }
    // A looping or prompt-injected agent must not be able to pile up asks, in one
    // session or by registering many.
    const scope =
      store.countOpenAsks(session.id, kind) >= MAX_OPEN_ASKS[kind]
        ? "session"
        : store.countOpenAsks(undefined, kind) >= MAX_OPEN_ASKS_TOTAL[kind]
          ? "all sessions"
          : undefined;
    if (scope !== undefined) {
      store.appendAudit("ask.refused", { kind, reason: `too many open asks (${scope})` }, clock(), {
        sessionId: session.id,
      });
      return reply.code(429).send({ error: `too many open asks (${scope})` });
    }
    // Redact before anything is stored, so no later step can forward the raw text.
    const text = cut(redactor.text(body.data.text), MAX_ASK_TEXT);
    const options =
      kind === "question" ? (body.data.options ?? []).map((o) => cut(redactor.text(o), MAX_OPTION_TEXT)) : [];
    if (new Set(options).size !== options.length) {
      return reply
        .code(400)
        .send({ error: "invalid request", issues: ["options: must be unique after redaction"] });
    }
    // The tool name is agent-written too: redacted like the text, though the schema
    // already limits it to identifier characters.
    const toolName =
      body.data.toolName === undefined ? undefined : cut(redactor.text(body.data.toolName), MAX_TOOL_NAME);
    const now = clock();
    const ask: Ask = {
      id: newId(),
      sessionId: session.id,
      kind,
      text,
      options,
      ...(toolName === undefined ? {} : { toolName }),
      risk: body.data.risk ?? "low",
      urgent,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + askTimeoutMs).toISOString(),
      status: "pending",
    };
    store.addAsk(ask);
    store.putSession({ ...session, lastSeenAt: now.toISOString() });
    refreshSessionState(session.id);
    store.appendAudit("ask.created", { kind, options: options.length, urgent, risk: ask.risk }, now, {
      askId: ask.id,
      sessionId: session.id,
    });
    return reply.code(201).send({ ask: store.getAsk(ask.id) ?? ask });
  });

  app.get("/v1/asks/:askId/outcome", async (request, reply) => {
    const params = AskParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const query = OutcomeQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const found = store.getAsk(params.data.askId);
    if (found === undefined) return reply.code(404).send({ error: "unknown ask" });

    let state = outcomeOf(found);
    if (state.outcome === undefined) {
      const remaining = Date.parse(state.ask.expiresAt) - clock().getTime();
      await changeOrTimeout(state.ask.id, Math.min(query.data.waitSeconds * 1000, remaining), reply);
      state = outcomeOf(store.getAsk(state.ask.id) ?? state.ask);
    }
    // Also covers a change written by another process, which no listener heard.
    if (state.outcome !== undefined) refreshSessionState(state.ask.sessionId);
    const response: OutcomeResponse =
      state.outcome === undefined
        ? { state: "waiting", ask: state.ask }
        : { state: "final", ask: state.ask, outcome: state.outcome };
    return response;
  });

  app.post("/v1/sessions/:sessionId/end", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const session = store.getSession(params.data.sessionId);
    if (session === undefined) return reply.code(404).send({ error: "unknown session" });
    if (session.state === "ended") return { ended: false };
    // Its open asks go too: nobody should be called for an agent that left.
    const open = store.listAsks(["pending", "in-flight"]).filter((ask) => ask.sessionId === session.id);
    for (const ask of open) {
      if (store.setAskStatus(ask.id, "cancelled")) {
        store.appendAudit("ask.cancelled", { kind: ask.kind, by: "session-end" }, clock(), {
          askId: ask.id,
          sessionId: session.id,
        });
      }
    }
    store.putSession({
      ...(store.getSession(session.id) ?? session),
      state: "ended",
      lastSeenAt: clock().toISOString(),
    });
    store.appendAudit("session.ended", {}, clock(), { sessionId: session.id });
    return { ended: true };
  });

  app.post("/v1/asks/:askId/cancel", async (request, reply) => {
    const params = AskParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const ask = store.getAsk(params.data.askId);
    if (ask === undefined) return reply.code(404).send({ error: "unknown ask" });
    const cancelled = store.setAskStatus(ask.id, "cancelled");
    if (cancelled) {
      store.appendAudit("ask.cancelled", { kind: ask.kind, by: "agent" }, clock(), {
        askId: ask.id,
        sessionId: ask.sessionId,
      });
    }
    return { cancelled };
  });

  app.get("/v1/sessions/:sessionId/inbox", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const session = store.getSession(params.data.sessionId);
    if (session === undefined) return reply.code(404).send({ error: "unknown session" });
    const asks = store.listSessionAsks(session.id, INBOX_ASK_LIMIT).map(outcomeOf);
    const seen = { ...(store.getSession(session.id) ?? session), lastSeenAt: clock().toISOString() };
    store.putSession(seen);
    const response: InboxResponse = { session: seen, instructions: [], asks };
    return response;
  });
}
