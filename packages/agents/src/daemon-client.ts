// A small client for the daemon's agent API. It only ever talks to 127.0.0.1,
// with the per-install token, and validates every response against the HL-02
// schemas: a response that does not parse is a failure, never an answer.
import { type AgentKind, Ask, AskOutcome, Id, type Risk, Session } from "@hotline/core";
import { z } from "zod";

/** The only host the client connects to. Not configurable. */
export const DAEMON_HOST = "127.0.0.1";

/** Where the daemon's agent API listens and the token it expects. */
export interface DaemonConnection {
  port: number;
  token: string;
}

/**
 * Finds the port and token, for example from the hotline config and secret store.
 * Called lazily and again after a connection or token failure, so a daemon started
 * after the MCP server is still found. Throw `DaemonError("not-configured")` when
 * Hotline is not set up.
 */
export type ConnectionSource = () => Promise<DaemonConnection>;

export type DaemonFailure =
  | "not-configured"
  | "unreachable"
  | "unauthorized"
  | "not-found"
  | "rejected"
  | "bad-response"
  | "aborted";

export class DaemonError extends Error {
  override readonly name = "DaemonError";
  constructor(
    readonly kind: DaemonFailure,
    message: string,
  ) {
    super(message);
  }
}

export const OutcomeState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting"), ask: Ask }),
  z.object({ state: z.literal("final"), ask: Ask, outcome: AskOutcome }),
]);
export type OutcomeState = z.infer<typeof OutcomeState>;

/** An instruction the owner gave this session by phone, in their own words. Handed over once. */
export const OwnerInstruction = z.object({ text: z.string().min(1), receivedAt: z.string() });
export type OwnerInstruction = z.infer<typeof OwnerInstruction>;
/** A queued instruction as the daemon lists it, with the id to acknowledge it by. */
export const ListedInstruction = OwnerInstruction.extend({ id: Id });
export type ListedInstruction = z.infer<typeof ListedInstruction>;

export const Inbox = z.object({
  session: Session,
  instructions: z.array(OwnerInstruction),
  asks: z.array(z.object({ ask: Ask, outcome: AskOutcome.optional() })),
});
export type Inbox = z.infer<typeof Inbox>;

export interface RegisterSessionRequest {
  agent: AgentKind;
  cwd: string;
  agentSessionId?: string;
}

export type CreateAskRequest =
  | { kind: "question"; text: string; options?: string[]; urgent?: boolean }
  | { kind: "notify" | "stop"; text: string; options?: undefined; urgent?: boolean }
  | { kind: "permission"; text: string; options?: undefined; toolName: string; risk: Risk; urgent?: boolean };

/** What the MCP server needs from the daemon; `DaemonClient` implements it, tests may fake it. */
export interface HotlineDaemon {
  registerSession(request: RegisterSessionRequest): Promise<Session>;
  createAsk(sessionId: string, request: CreateAskRequest): Promise<Ask>;
  /** The outcome, waiting up to `waitSeconds` on the daemon for one to arrive. */
  outcome(askId: string, waitSeconds: number, signal?: AbortSignal): Promise<OutcomeState>;
  cancelAsk(askId: string): Promise<boolean>;
  inbox(sessionId: string): Promise<Inbox>;
  /** The owner's queued instructions for the session, oldest first, with ids. Hands nothing over. */
  peekInstructions(sessionId: string): Promise<ListedInstruction[]>;
  /**
   * Marks instructions `ids` delivered, after an ask (`ask`) or at a Stop hook
   * (`stop`), and returns those that still were queued. Acknowledge only what
   * is about to be passed on; each is delivered once.
   */
  ackInstructions(
    sessionId: string,
    ids: readonly string[],
    via: "ask" | "stop",
  ): Promise<OwnerInstruction[]>;
  /** Marks the session ended and cancels its open asks. */
  endSession(sessionId: string): Promise<boolean>;
}

export interface DaemonClientOptions {
  connection: ConnectionSource;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Added to any server-side wait for the request deadline. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const SessionResponse = z.object({ session: Session });
const AskResponse = z.object({ ask: Ask });
const CancelResponse = z.object({ cancelled: z.boolean() });
const EndResponse = z.object({ ended: z.boolean() });
const InstructionsResponse = z.object({ instructions: z.array(OwnerInstruction) });
const ListedResponse = z.object({ instructions: z.array(ListedInstruction) });

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

interface Call<T> {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  schema: z.ZodType<T>;
  /** Extra time the daemon may take, for long-polling requests. */
  waitMs?: number;
  signal?: AbortSignal;
}

export class DaemonClient implements HotlineDaemon {
  private connection: Promise<DaemonConnection> | undefined;
  private readonly fetch: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: DaemonClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  registerSession(request: RegisterSessionRequest): Promise<Session> {
    return this.call({ method: "POST", path: "/v1/sessions", body: request, schema: SessionResponse }).then(
      (response) => response.session,
    );
  }

  createAsk(sessionId: string, request: CreateAskRequest): Promise<Ask> {
    return this.call({
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(Id.parse(sessionId))}/asks`,
      body: request,
      schema: AskResponse,
    }).then((response) => response.ask);
  }

  outcome(askId: string, waitSeconds: number, signal?: AbortSignal): Promise<OutcomeState> {
    const wait = Math.max(0, Math.floor(waitSeconds));
    return this.call({
      method: "GET",
      path: `/v1/asks/${encodeURIComponent(Id.parse(askId))}/outcome?waitSeconds=${wait}`,
      schema: OutcomeState,
      waitMs: wait * 1000,
      signal,
    });
  }

  cancelAsk(askId: string): Promise<boolean> {
    return this.call({
      method: "POST",
      path: `/v1/asks/${encodeURIComponent(Id.parse(askId))}/cancel`,
      body: {},
      schema: CancelResponse,
    }).then((response) => response.cancelled);
  }

  endSession(sessionId: string): Promise<boolean> {
    return this.call({
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(Id.parse(sessionId))}/end`,
      body: {},
      schema: EndResponse,
    }).then((response) => response.ended);
  }

  inbox(sessionId: string): Promise<Inbox> {
    return this.call({
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(Id.parse(sessionId))}/inbox`,
      schema: Inbox,
    });
  }

  peekInstructions(sessionId: string): Promise<ListedInstruction[]> {
    return this.call({
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(Id.parse(sessionId))}/instructions`,
      schema: ListedResponse,
    }).then((response) => response.instructions);
  }

  ackInstructions(
    sessionId: string,
    ids: readonly string[],
    via: "ask" | "stop",
  ): Promise<OwnerInstruction[]> {
    return this.call({
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(Id.parse(sessionId))}/instructions/ack`,
      body: { via, ids },
      schema: InstructionsResponse,
    }).then((response) => response.instructions);
  }

  private resolveConnection(): Promise<DaemonConnection> {
    this.connection ??= this.options.connection().then((connection) => {
      if (!validPort(connection.port)) throw new DaemonError("not-configured", "daemon port is invalid");
      if (connection.token.length === 0) throw new DaemonError("not-configured", "no daemon token");
      return connection;
    });
    const pending = this.connection;
    // A failed lookup is retried on the next call, not cached.
    pending.catch(() => {
      if (this.connection === pending) this.connection = undefined;
    });
    return pending;
  }

  private async call<T>(call: Call<T>): Promise<T> {
    try {
      return await this.attempt(call);
    } catch (error) {
      // The token may have been created or replaced since we read it: look again once.
      if (error instanceof DaemonError && error.kind === "unauthorized") {
        this.connection = undefined;
        return this.attempt(call);
      }
      throw error;
    }
  }

  private async attempt<T>(call: Call<T>): Promise<T> {
    let connection: DaemonConnection;
    try {
      connection = await this.resolveConnection();
    } catch (error) {
      if (error instanceof DaemonError) throw error;
      throw new DaemonError("not-configured", (error as Error).message);
    }
    const deadline = AbortSignal.timeout((call.waitMs ?? 0) + this.requestTimeoutMs);
    const signal = call.signal === undefined ? deadline : AbortSignal.any([call.signal, deadline]);
    let response: Response;
    try {
      response = await this.fetch(`http://${DAEMON_HOST}:${connection.port}${call.path}`, {
        method: call.method,
        // Never follow a redirect: whatever answers on the port must not be able to
        // send the token or the unredacted text on to another host.
        redirect: "error",
        headers: {
          authorization: `Bearer ${connection.token}`,
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal,
      });
    } catch {
      if (call.signal?.aborted) throw new DaemonError("aborted", "the request was cancelled");
      // Refused, reset or timed out: the daemon may have restarted on another port.
      this.connection = undefined;
      throw new DaemonError("unreachable", "the Hotline daemon is not reachable on 127.0.0.1");
    }
    if (response.status === 401) throw new DaemonError("unauthorized", "the daemon refused the API token");
    if (response.status === 404)
      throw new DaemonError("not-found", "the daemon does not know that session or ask");
    if (response.status === 429) {
      throw new DaemonError("rejected", "too many open asks; wait for earlier ones to be answered or expire");
    }
    if (!response.ok) throw new DaemonError("rejected", `the daemon answered HTTP ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // Maybe not the daemon at all: look the port up again next time. Never replay.
      this.connection = undefined;
      throw new DaemonError("bad-response", "the daemon's response is not JSON");
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) {
      this.connection = undefined;
      throw new DaemonError("bad-response", "the daemon's response has an unexpected shape");
    }
    return parsed.data;
  }
}
