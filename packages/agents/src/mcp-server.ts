// `hotline mcp`: the stdio MCP server Claude Code and Codex start for each
// session. It offers three tools and relays them to the local daemon:
//
//   ask_human     ask the owner a question by phone (or text) and wait for the answer
//   notify_human  tell the owner something; no answer comes back
//   check_inbox   instructions the owner left for this session, and its recent asks
//
// Everything a tool receives was written by an agent and is untrusted. The server
// never decides anything itself: an answer reaches the agent only when the daemon
// reports an `answered` outcome for exactly the ask it created, and only the
// daemon's resolution path (`recordAnswer`, after `answerProblem`) produces one.
// Any failure, timeout or doubt returns "no answer", never a made-up answer.

import type { Readable, Writable } from "node:stream";
import {
  type AgentKind,
  type Ask,
  type AskOutcome,
  Id,
  MAX_OPTIONS,
  type NoAnswerReason,
} from "@hotline/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DaemonError, type HotlineDaemon, type Inbox } from "./daemon-client.js";

export const MCP_SERVER_NAME = "hotline";

/** Lengths the tools accept; the combined ask text stays under the contract's 1000. */
export const MAX_QUESTION = 500;
export const MAX_CONTEXT = 400;
export const MAX_OPTION = 200;
export const MAX_MESSAGE = 900;

/** About every minute, so an idle timeout on the client side never fires (plan section 4A). */
export const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;
/** How long each outcome request waits on the daemon. */
export const DEFAULT_POLL_SECONDS = 25;
/** Delays before retrying after the daemon stops answering mid-wait; then "no answer". */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Past the ask's own expiry, the server stops waiting even if the daemon has not said so. */
export const EXPIRY_GRACE_MS = 60_000;

export interface HotlineMcpOptions {
  daemon: HotlineDaemon;
  /** Which agent started the server (`--agent`). When unset it is guessed from the client's name. */
  agent?: AgentKind;
  /** The session's working directory: the server's own cwd, which the agent sets. */
  cwd: string;
  /** The agent's own session id, when it exposes one (Claude Code's `CLAUDE_CODE_SESSION_ID`). */
  agentSessionId?: string;
  version: string;
  clock?: () => Date;
  progressIntervalMs?: number;
  pollSeconds?: number;
  retryDelaysMs?: readonly number[];
}

/** What `ask_human` returns, as JSON text. */
export type AskHumanResult =
  | {
      outcome: "answered";
      askId: string;
      /** The option the owner picked, 1-based, and its text. */
      choice?: { option: number; text: string };
      /** The owner's free-text answer. */
      answer?: string;
      /** The owner's own words, verbatim. */
      ownerWords: string;
      channel: "voice" | "sms";
    }
  | { outcome: "no-answer"; askId?: string; reason: NoAnswerReason; note: string };

const NO_ANSWER_NOTE =
  "Nobody answered. This is not approval and not an answer: do not act as if the human agreed. " +
  "Continue without their input where that is safe, or stop and leave the question for them.";

// C0 controls except tab and newline, and DEL: agent text is spoken or texted, never interpreted.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clean(text: string): string {
  return text.replace(CONTROL, " ").trim();
}

function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function noAnswer(reason: NoAnswerReason, askId?: string): AskHumanResult {
  return { outcome: "no-answer", ...(askId === undefined ? {} : { askId }), reason, note: NO_ANSWER_NOTE };
}

/** The agent from the MCP client's name, when `--agent` was not given. */
export function agentFromClientName(name: string | undefined): AgentKind | undefined {
  if (name === undefined) return undefined;
  if (/claude/i.test(name)) return "claude-code";
  if (/codex/i.test(name)) return "codex";
  return undefined;
}

/**
 * Turns the daemon's outcome into the tool result. An `answered` outcome counts
 * only for this ask and only with a decision a question can have; anything else
 * is reported as "unclear", never passed on.
 */
export function askHumanResult(ask: Ask, outcome: AskOutcome): AskHumanResult {
  if (outcome.outcome === "no-answer") {
    return noAnswer(outcome.askId === ask.id ? outcome.reason : "unclear", ask.id);
  }
  const { answer } = outcome;
  if (answer.askId !== ask.id) return noAnswer("unclear", ask.id);
  const base = {
    outcome: "answered" as const,
    askId: ask.id,
    ownerWords: answer.ownerExcerpt,
    channel: answer.channel,
  };
  const { decision } = answer;
  if (decision.type === "option") {
    const text = ask.options[decision.option - 1];
    return text === undefined
      ? noAnswer("unclear", ask.id)
      : { ...base, choice: { option: decision.option, text } };
  }
  if (decision.type === "text") return { ...base, answer: decision.text };
  return noAnswer("unclear", ask.id);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

function summarizeInbox(inbox: Inbox) {
  return {
    session: { nickname: inbox.session.nickname, state: inbox.session.state },
    instructions: inbox.instructions,
    asks: inbox.asks.map(({ ask, outcome }) => ({
      askId: ask.id,
      kind: ask.kind,
      status: ask.status,
      text: ask.text,
      ...(ask.kind === "question" && outcome !== undefined ? { result: askHumanResult(ask, outcome) } : {}),
    })),
  };
}

export interface HotlineMcpServer {
  server: McpServer;
  /** Resolves when no tool call is running, including the cleanup of cancelled ones. */
  settled(): Promise<void>;
}

export function createHotlineMcpServer(options: HotlineMcpOptions): HotlineMcpServer {
  const { daemon } = options;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    const running = work();
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running)).catch(() => {});
    return running;
  };
  const clock = options.clock ?? (() => new Date());
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const pollSeconds = options.pollSeconds ?? DEFAULT_POLL_SECONDS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const agentSessionId =
    options.agentSessionId !== undefined && Id.safeParse(options.agentSessionId).success
      ? options.agentSessionId
      : undefined;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: options.version },
    {
      instructions:
        "Agent Hotline phones your human. Use ask_human only for a decision you cannot make yourself; " +
        "keep it to one short spoken sentence and never include secrets, file contents or diffs. " +
        "A 'no-answer' result is never approval.",
    },
  );

  // Session registration: once per server, retried on the next tool call if it failed.
  let session: Promise<string> | undefined;
  const ensureSession = (): Promise<string> => {
    if (session !== undefined) return session;
    const agent = options.agent ?? agentFromClientName(server.server.getClientVersion()?.name);
    const pending =
      agent === undefined
        ? Promise.reject(new DaemonError("not-configured", "unknown agent: start the server with --agent"))
        : daemon
            .registerSession({ agent, cwd: options.cwd, ...(agentSessionId ? { agentSessionId } : {}) })
            .then((registered) => registered.id);
    session = pending;
    pending.catch(() => {
      if (session === pending) session = undefined;
    });
    return pending;
  };
  const forgetSession = () => {
    session = undefined;
  };
  server.server.oninitialized = () => {
    ensureSession().catch(() => {
      // Reported by the first tool call instead; the daemon may simply not be running yet.
    });
  };

  /** Creates an ask, registering again once if the daemon no longer knows the session. */
  const createAsk = async (request: Parameters<HotlineDaemon["createAsk"]>[1]): Promise<Ask> => {
    try {
      return await daemon.createAsk(await ensureSession(), request);
    } catch (error) {
      if (!(error instanceof DaemonError) || error.kind !== "not-found") throw error;
      forgetSession();
      return daemon.createAsk(await ensureSession(), request);
    }
  };

  server.registerTool(
    "ask_human",
    {
      title: "Ask the human",
      description:
        "Phone the human (or text them during quiet hours) with one short question and wait for the answer, " +
        "which can take many minutes. Use it only for a decision you cannot make yourself. Keep the question " +
        "to one spoken sentence; offer up to 9 options when you can, since the human picks them by number. " +
        "Never include secrets, keys, file contents or diffs: they are redacted and only a short summary is " +
        "read out. Returns JSON: outcome 'answered' with the human's choice or answer and their own words, " +
        "or outcome 'no-answer' with a reason. 'no-answer' is never approval.",
      inputSchema: {
        question: z.string().min(1).max(MAX_QUESTION).describe("One short question, as it should be spoken"),
        options: z
          .array(z.string().min(1).max(MAX_OPTION))
          .min(2)
          .max(MAX_OPTIONS)
          .optional()
          .describe("Up to 9 short answers the human can pick by number"),
        context: z
          .string()
          .max(MAX_CONTEXT)
          .optional()
          .describe("One or two sentences of background: what you are doing and why you need them"),
        urgent: z
          .boolean()
          .optional()
          .describe(
            "Ask for a call even during quiet hours. Only a request: the owner's settings and rate limits decide",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args, extra) =>
      track(async () => {
        const question = clean(args.question);
        const context = args.context === undefined ? "" : clean(args.context);
        const choices = (args.options ?? []).map(clean);
        if (question === "" || choices.some((choice) => choice === "")) {
          return json({ error: "The question and every option need visible text." }, true);
        }
        if (new Set(choices).size !== choices.length)
          return json({ error: "Options must be different." }, true);
        const text = context === "" ? question : `${question}\n\nContext: ${context}`;

        let ask: Ask;
        try {
          ask = await createAsk({
            kind: "question",
            text,
            ...(choices.length > 0 ? { options: choices } : {}),
            ...(args.urgent === undefined ? {} : { urgent: args.urgent }),
          });
        } catch {
          // Daemon down, not set up or refusing: nobody was asked, so nobody answered.
          return json(noAnswer("failed"));
        }

        const progressToken = extra._meta?.progressToken;
        const started = clock().getTime();
        let ticks = 0;
        const progress =
          progressToken === undefined
            ? undefined
            : setInterval(() => {
                ticks += 1;
                const minutes = Math.floor((clock().getTime() - started) / 60_000);
                extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: ticks,
                      message: `Waiting for the human to answer (${minutes} min so far)`,
                    },
                  })
                  .catch(() => {
                    // The client went away; the abort signal ends the wait.
                  });
              }, progressIntervalMs);

        try {
          const deadline = Date.parse(ask.expiresAt) + EXPIRY_GRACE_MS;
          let failures = 0;
          for (;;) {
            if (extra.signal.aborted) break;
            if (clock().getTime() >= deadline) {
              await daemon.cancelAsk(ask.id).catch(() => false);
              return json(noAnswer("timeout", ask.id));
            }
            try {
              const state = await daemon.outcome(ask.id, pollSeconds, extra.signal);
              failures = 0;
              if (state.state === "final") return json(askHumanResult(ask, state.outcome));
            } catch (error) {
              if (extra.signal.aborted || (error instanceof DaemonError && error.kind === "aborted")) break;
              const delay = retryDelaysMs[failures];
              failures += 1;
              if (delay === undefined) return json(noAnswer("failed", ask.id));
              await sleep(delay, extra.signal);
            }
          }
          // The agent cancelled the call: nobody should be phoned about it any more.
          await daemon.cancelAsk(ask.id).catch(() => false);
          return json(noAnswer("cancelled", ask.id));
        } finally {
          if (progress !== undefined) clearInterval(progress);
        }
      }),
  );

  server.registerTool(
    "notify_human",
    {
      title: "Notify the human",
      description:
        "Send the human a short note (usually a text message), for example that a long task finished or " +
        "failed. It does not wait and no answer comes back. Never include secrets, keys or file contents.",
      inputSchema: {
        message: z.string().min(1).max(MAX_MESSAGE).describe("One or two short sentences"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const message = clean(args.message);
      if (message === "") return json({ error: "The message needs visible text." }, true);
      try {
        const ask = await createAsk({ kind: "notify", text: message });
        return json({ queued: true, askId: ask.id, note: "Queued for the human. No reply comes back." });
      } catch (error) {
        const reason = error instanceof DaemonError ? error.message : "the daemon could not be reached";
        return json({ queued: false, error: `Not sent: ${reason}.` }, true);
      }
    },
  );

  server.registerTool(
    "check_inbox",
    {
      title: "Check the Hotline inbox",
      description:
        "List instructions the human left for this session and the status of its recent questions and " +
        "notifications. Instructions come from the human; question text came from this agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json(summarizeInbox(await daemon.inbox(await ensureSession())));
      } catch (error) {
        if (error instanceof DaemonError && error.kind === "not-found") forgetSession();
        const reason = error instanceof DaemonError ? error.message : "the daemon could not be reached";
        return json({ error: `Inbox unavailable: ${reason}.` }, true);
      }
    },
  );

  return {
    server,
    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

export interface RunStdioOptions extends HotlineMcpOptions {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Serves MCP over stdin and stdout until the client closes stdin. Resolves once
 * every in-flight tool call has finished; an `ask_human` still waiting is
 * cancelled on the daemon first, so nobody is phoned for an agent that left.
 * Nothing but MCP messages is ever written to stdout.
 */
export async function runStdioMcpServer(options: RunStdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const hotline = createHotlineMcpServer(options);
  const transport = new StdioServerTransport(stdin, options.stdout ?? process.stdout);
  const closed = new Promise<void>((resolve) => {
    hotline.server.server.onclose = () => resolve();
  });
  const close = () => {
    void hotline.server.close();
  };
  stdin.once("end", close);
  stdin.once("close", close);
  try {
    await hotline.server.connect(transport);
    await closed;
    await hotline.settled();
  } finally {
    stdin.off("end", close);
    stdin.off("close", close);
  }
}
